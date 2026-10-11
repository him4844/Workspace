/**
 * Agent runtime (SPEC §4, §40, §49; docs/06 §3, §5).
 *
 * One LLM call, strict JSON, schema validation, at most ONE repair attempt, then a
 * structured envelope. The orchestrator routes on `status` only — prose is never parsed.
 */
import type { LlmClient, LlmRequest, LlmUsage , ReasoningEffort } from './llm/types.js';
import { LlmError } from './llm/types.js';
import { assemblePrompt, CLIENT_CONTENT_OPEN } from './prompt.js';
import { AGENT_RULES } from './prompt.js';
import { budgetReport } from './prompt-budget.js';

export type AgentErrorCode =
  | 'LLM_TIMEOUT' | 'LLM_RATE_LIMITED' | 'LLM_PROVIDER_ERROR' | 'LLM_BUDGET_EXCEEDED' | 'INVALID_JSON'
  | 'SCHEMA_VALIDATION_FAILED' | 'CONTENT_POLICY' | 'INPUT_MISSING' | 'INTERNAL_ERROR';

export type AgentEnvelope<T> =
  | {
      status: 'SUCCESS';
      output: T;
      usage: LlmUsage;
      repairCount: 0 | 1;
      nextAction?: string | null;
      confidence?: number;
    }
  | { status: 'FAILED'; errorCode: AgentErrorCode; message: string; retryable: boolean; usage?: LlmUsage; retryAfterMs?: number }
  | { status: 'NEEDS_REVIEW'; reason: string; partialOutput?: unknown; usage?: LlmUsage };

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface RunAgentInput<T> {
  task: string;
  projectData: unknown;
  clientMessages: Array<{ id?: string; at?: string; text: string }>;
  outputSchema: unknown;
  /** JSON extraction + validation for this agent (Zod-backed in the concrete agents) */
  validate: (raw: unknown) => ValidateResult<T>;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** see LlmRequest.reasoningEffort — reasoning models can eat the whole completion cap */
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  /** optional hook so callers can persist the raw text for the audit trail */
  onRaw?: (info: { attempt: 0 | 1; text: string }) => void;
}

export interface RunAgentDeps {
  client: LlmClient;
  systemInstructions: string;
  /** optional logger (pino-compatible), only used for diagnostics */
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /**
   * 429 handling for free tiers (§58): when the provider says how long to wait, wait instead of
   * failing the run — a token-per-minute limit is a pause, not an error. Bounded twice and by
   * `maxRateLimitWaitMs`: a provider asking for minutes must fail the job (retry policy owns it),
   * never occupy a worker for minutes (§21). Tests inject `sleepMs` to assert without waiting.
   */
  maxRateLimitWaits?: number;
  maxRateLimitWaitMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
  /** Atomic/persisted cost reservation before each model request; thrown LlmError becomes a FAILED envelope. */
  beforeRequest?: (request: LlmRequest) => Promise<unknown>;
  /** Settle/release the reservation after the provider returns or rejects. */
  afterRequest?: (reservation: unknown, outcome: { usage?: LlmUsage; error?: unknown }) => Promise<void>;
}

/** Strip markdown fences and tolerate leading/trailing prose around a JSON object. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return { ok: false, error: 'empty response' };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  const direct = tryParse(candidate);
  if (direct.ok) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(candidate.slice(start, end + 1));
    if (sliced.ok) return sliced;
  }
  return { ok: false, error: 'response is not valid JSON' };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function runAgentTurn<T>(deps: RunAgentDeps, input: RunAgentInput<T>): Promise<AgentEnvelope<T>> {
  if (!deps.client) {
    return { status: 'FAILED', errorCode: 'INTERNAL_ERROR', message: 'no LLM client configured', retryable: false };
  }
  const messages = assemblePrompt({
    systemInstructions: deps.systemInstructions,
    task: input.task,
    projectData: input.projectData,
    clientMessages: input.clientMessages,
    outputSchema: input.outputSchema,
  });

  // Free-tier guard (§58): providers reserve prompt + max_tokens against a per-minute window, so
  // an oversized prompt is a 429 waiting to happen. The request still goes out (the window may be
  // warm), but the numbers are logged so a live run can be diagnosed without guesswork.
  // The 8 000 default is the GROQ free-tier TPM budget — providers without a published TPM limit
  // (OpenRouter :free = 20 RPM / 50 RPD) still serve oversized prompts, measured live 2026-10-08.
  // Do NOT "fix" this warning by lowering maxOutputTokens: a reasoning model that runs out of
  // output budget returns empty content (finish_reason=length), which dead-letters the call.
  const budget = budgetReport(messages, input.maxOutputTokens ?? 0);
  if (!budget.fits) {
    deps.logger?.warn(
      { task: input.task.slice(0, 60), provider: deps.client.provider, ...budget },
      `prompt exceeds the ${budget.budgetTokens} TPM heuristic (Groq free-tier budget; provider=${deps.client.provider}) — the request still goes out; trim the prompt if the provider 429s`,
    );
  }

  let usage: LlmUsage | undefined;
  let lastRaw: unknown;

  for (let attempt = 0 as 0 | 1; attempt <= 1; attempt = (attempt + 1) as 0 | 1) {
    const request: LlmRequest = {
      model: input.model,
      messages,
      temperature: input.temperature,
      // A truncated answer is usually a reasoning budget problem, not a schema problem: the repair
      // attempt gets more room (bounded by the free-tier window) before a human is asked (§42).
      maxOutputTokens: attempt === 0 || !input.maxOutputTokens
        ? input.maxOutputTokens
        // Never clamp below the original cap: when the prompt alone exceeds the heuristic TPM
        // window the remainder is negative and a 0-token repair request is a guaranteed 400.
        : Math.min(Math.round(input.maxOutputTokens * 1.5), Math.max(input.maxOutputTokens, budget.budgetTokens - budget.promptTokens)),
      reasoningEffort: input.reasoningEffort,
      timeoutMs: input.timeoutMs,
      jsonMode: true,
    };

    const maxWaits = deps.maxRateLimitWaits ?? 2;
    const maxWaitMs = deps.maxRateLimitWaitMs ?? 70_000;
    const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let completion;
    let rateLimitWaits = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let budgetReservation: unknown;
      if (deps.beforeRequest) {
        try {
          budgetReservation = await deps.beforeRequest(request);
        } catch (err) {
          const guardError = err instanceof LlmError
            ? err
            : new LlmError('LLM_BUDGET_EXCEEDED', (err as Error).message ?? String(err), false, err);
          deps.logger?.warn({ code: guardError.code, model: request.model, message: guardError.message }, 'LLM call refused by the persisted daily budget guard');
          return {
            status: 'FAILED',
            errorCode: guardError.code,
            message: guardError.message,
            retryable: false,
            usage,
            retryAfterMs: guardError.retryAfterMs,
          };
        }
      }
      try {
        completion = await deps.client.complete(request);
        if (deps.afterRequest) {
          try {
            await deps.afterRequest(budgetReservation, { usage: completion.usage });
          } catch (settleError) {
            // Keep the request result; an unsettled reservation remains counted conservatively.
            deps.logger?.warn({ model: request.model, error: (settleError as Error).message }, 'daily LLM budget settlement failed; reservation remains held');
          }
        }
        break;
      } catch (err) {
        if (deps.afterRequest) {
          try {
            await deps.afterRequest(budgetReservation, { error: err });
          } catch (settleError) {
            deps.logger?.warn({ model: request.model, error: (settleError as Error).message }, 'daily LLM budget release/settlement failed; reservation remains held');
          }
        }
        const llmError = err instanceof LlmError
          ? err
          : new LlmError('LLM_PROVIDER_ERROR', (err as Error).message, true, err);
        // Two ways a free provider says "not now": a 429 with an interval, and a 5xx spike with
        // nothing to read (Gemini's "high demand" 503 answers the same request a minute later).
        // Both are pauses, not failures — wait them out, bounded (§21, §58).
        const waitMs = llmError.retryAfterMs
          ?? (llmError.code === 'LLM_PROVIDER_ERROR' && llmError.retryable ? 5_000 : undefined);
        const waitable = llmError.code === 'LLM_RATE_LIMITED'
          || (llmError.code === 'LLM_PROVIDER_ERROR' && llmError.retryable);
        if (waitable && waitMs !== undefined && waitMs <= maxWaitMs && rateLimitWaits < maxWaits) {
          rateLimitWaits += 1;
          deps.logger?.warn(
            { waitMs, attempt: rateLimitWaits, code: llmError.code },
            'provider is temporarily unavailable — waiting it out (§58 free tier)',
          );
          await sleep(waitMs);
          continue;
        }
        return {
          status: 'FAILED',
          errorCode: llmError.code,
          message: llmError.message,
          retryable: llmError.retryable,
          usage,
          // Carried so the orchestrator can SCHEDULE the retry at the provider's own deadline
          // instead of burning the attempt budget on backoff re-queries (D-052).
          retryAfterMs: llmError.retryAfterMs,
        };
      }
    }

    usage = completion.usage;
    input.onRaw?.({ attempt, text: completion.text });

    const extracted = extractJson(completion.text);
    if (!extracted.ok) {
      if (attempt === 0) {
        // A reasoning model can return empty *visible* text (all tokens spent thinking). Echoing an
        // empty assistant message back is invalid for strict providers — measured live 2026-10-08:
        // OpenRouter/Cohere answered `400 invalid message provided at index 1: must have non-empty
        // content` on exactly this repair, which dead-lettered the audit as non-retryable.
        messages.push({ role: 'assistant', content: completion.text.length > 0 ? completion.text.slice(0, 2000) : '(empty response)' });
        messages.push({
          role: 'user',
          content: `Your previous answer was not valid JSON (${extracted.error}). Respond again with ONE JSON object conforming to the OUTPUT SCHEMA. No prose, no markdown fences.`,
        });
        continue;
      }
      // docs/06 §5: one repair, then a human looks at it. Retrying the whole job would burn
      // tokens on a model that is clearly not following the contract (§21).
      return {
        status: 'NEEDS_REVIEW',
        reason: `output was not valid JSON after one repair: ${extracted.error}`,
        partialOutput: { raw: completion.text.slice(0, 2000) },
        usage,
      };
    }

    const validated = input.validate(extracted.value);
    if (validated.ok) {
      return { status: 'SUCCESS', output: validated.value, usage, repairCount: attempt };
    }

    lastRaw = extracted.value;
    if (attempt === 0) {
      messages.push({ role: 'assistant', content: JSON.stringify(extracted.value).slice(0, 2000) });
      messages.push({
        role: 'user',
        content: [
          'Your previous answer did not match the OUTPUT SCHEMA. Validation errors:',
          ...validated.errors.map((e) => `- ${e}`),
          'Fix exactly these problems and respond with ONE JSON object. No prose, no markdown fences.',
        ].join('\n'),
      });
      deps.logger?.warn({ errors: validated.errors }, 'agent output failed validation; one repair attempt');
      continue;
    }

    // §42 — after the single repair attempt a human looks at it instead of looping.
    return {
      status: 'NEEDS_REVIEW',
      reason: `output did not match the schema after one repair: ${validated.errors.slice(0, 5).join('; ')}`,
      partialOutput: lastRaw,
      usage,
    };
  }

  return { status: 'FAILED', errorCode: 'INTERNAL_ERROR', message: 'unreachable', retryable: false, usage };
}

/** Export for tests and for the repair prompt wording check. */
export { AGENT_RULES, CLIENT_CONTENT_OPEN };

/**
 * Agent runtime (SPEC §4, §40, §49; docs/06 §3, §5).
 *
 * One LLM call, strict JSON, schema validation, at most ONE repair attempt, then a
 * structured envelope. The orchestrator routes on `status` only — prose is never parsed.
 */
import type { LlmClient, LlmRequest, LlmUsage } from './llm/types.js';
import { LlmError } from './llm/types.js';
import { assemblePrompt, CLIENT_CONTENT_OPEN } from './prompt.js';
import { AGENT_RULES } from './prompt.js';

export type AgentErrorCode =
  | 'LLM_TIMEOUT' | 'LLM_RATE_LIMITED' | 'LLM_PROVIDER_ERROR' | 'INVALID_JSON'
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
  | { status: 'FAILED'; errorCode: AgentErrorCode; message: string; retryable: boolean; usage?: LlmUsage }
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
  timeoutMs?: number;
  /** optional hook so callers can persist the raw text for the audit trail */
  onRaw?: (info: { attempt: 0 | 1; text: string }) => void;
}

export interface RunAgentDeps {
  client: LlmClient;
  systemInstructions: string;
  /** optional logger (pino-compatible), only used for diagnostics */
  logger?: { warn: (obj: unknown, msg?: string) => void };
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

  let usage: LlmUsage | undefined;
  let lastRaw: unknown;

  for (let attempt = 0 as 0 | 1; attempt <= 1; attempt = (attempt + 1) as 0 | 1) {
    const request: LlmRequest = {
      model: input.model,
      messages,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: input.timeoutMs,
      jsonMode: true,
    };

    let completion;
    try {
      completion = await deps.client.complete(request);
    } catch (err) {
      const llmError = err instanceof LlmError
        ? err
        : new LlmError('LLM_PROVIDER_ERROR', (err as Error).message, true, err);
      return {
        status: 'FAILED',
        errorCode: llmError.code,
        message: llmError.message,
        retryable: llmError.retryable,
        usage,
      };
    }

    usage = completion.usage;
    input.onRaw?.({ attempt, text: completion.text });

    const extracted = extractJson(completion.text);
    if (!extracted.ok) {
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: completion.text.slice(0, 2000) });
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

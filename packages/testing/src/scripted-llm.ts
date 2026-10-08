/**
 * Scripted LLM client for tests and local demos (docs/14 §3).
 * It is NOT a mock of the agent: the real prompt assembly, runtime, validation, repair
 * loop, persistence and orchestration all run — only the network call is replaced.
 *
 * The script can be a fixed list of responses, or a function that receives the prompt
 * (so a test can assert what the model actually saw, e.g. the CLIENT CONTENT block).
 */
import type { LlmClient, LlmRequest, LlmCompletion } from '@wpp/agents';

export type ScriptedResponse = string | { text: string; promptTokens?: number; completionTokens?: number };

export type ScriptedSource =
  | ScriptedResponse[]
  | ((request: LlmRequest, callIndex: number) => ScriptedResponse | Promise<ScriptedResponse>);

export interface ScriptedLlm extends LlmClient {
  /** every request the runtime made, in order — for assertions and debugging */
  calls: LlmRequest[];
  /** how many scripted responses are left (list mode only) */
  remaining(): number;
}

export function createScriptedLlm(source: ScriptedSource, provider = 'fake'): ScriptedLlm {
  const calls: LlmRequest[] = [];
  let index = 0;
  return {
    provider,
    calls,
    remaining: () => (Array.isArray(source) ? Math.max(0, source.length - index) : Number.POSITIVE_INFINITY),
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      calls.push(request);
      const i = index;
      index += 1;
      const response =
        typeof source === 'function'
          ? await source(request, i)
          : source[Math.min(i, source.length - 1)];
      if (response === undefined) {
        throw new Error(`scripted LLM ran out of responses at call ${i + 1}`);
      }
      const text = typeof response === 'string' ? response : response.text;
      const promptTokens = typeof response === 'string' ? estimateTokens(request) : response.promptTokens ?? estimateTokens(request);
      const completionTokens = Math.max(1, Math.ceil(text.length / 4));
      return {
        text,
        usage: {
          provider,
          model: request.model,
          promptTokens,
          completionTokens,
          costUsd: 0,
        },
      };
    },
  };
}

function estimateTokens(request: LlmRequest): number {
  const chars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Build a valid requirements turn JSON string (used by fixtures and tests). */
export function requirementsTurn(partial: Record<string, unknown>): string {
  const base = {
    turnType: 'ASK_QUESTION',
    fieldUpdates: [],
    contradictions: [],
    vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
  };
  return JSON.stringify({ ...base, ...partial });
}

/**
 * Provider-agnostic LLM client (SPEC §51, D-015).
 * Agents never import a vendor SDK: they depend on this interface, so providers can be
 * swapped per agent (and the Spec Auditor can run on a different provider — Q4 answer).
 */
export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** ask the provider for a JSON-only answer where it supports it */
  jsonMode?: boolean;
  /**
   * Provider-side reasoning control. Gemini 3.x spends a hidden "thinking" budget out of the SAME
   * completion cap: measured 2026-10-08, a 4 KB JSON answer came back truncated (146 visible chars,
   * finish_reason=length) until the cap was raised or reasoning was set to `minimal`. Ignored by
   * providers that do not support it — but it is only ever SENT when the agent config sets it.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface LlmUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'none';

/**
 * Agent configs store the value as text (config is data): accept only what providers understand.
 * 'none' disables reasoning entirely (OpenRouter `reasoning:{enabled:false}`) — measured live
 * 2026-10-08: a reasoning model on a 9.7k-token audit prompt spent 2 700 tokens thinking, hit the
 * completion cap (finish_reason=length) and returned EMPTY content, which dead-lettered the audit.
 * With reasoning off the same call answered in ~1 s with a valid verdict.
 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'none'
    ? value
    : undefined;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
  /** provider response trimmed for the audit trail (no secrets) */
  raw?: unknown;
}

export interface LlmClient {
  readonly provider: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

export type LlmErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_RATE_LIMITED'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_BUDGET_EXCEEDED'
  | 'CONTENT_POLICY';

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryable: boolean = code !== 'CONTENT_POLICY',
    public readonly detail?: unknown,
    /** 429: how long the provider asked us to wait (free tiers are token-per-minute limited) */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Pull the wait out of a 429. Providers differ: a `retry-after` header (seconds), a
 * `retry-after-ms` header, or prose in the body ("Please try again in 16.19s" — Groq).
 */
export function parseRetryAfterMs(headers: Headers, bodyText: string): number | undefined {
  const headerMs = headers.get('retry-after-ms');
  if (headerMs && Number.isFinite(Number(headerMs))) return Math.max(0, Number(headerMs));
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const prose = /try again in ([0-9.]+)\s*s/i.exec(bodyText) ?? /retry after ([0-9.]+)\s*s/i.exec(bodyText);
  if (prose) return Math.ceil(Number(prose[1]) * 1000);
  return undefined;
}

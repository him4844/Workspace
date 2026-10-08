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
}

export interface LlmUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
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
  | 'CONTENT_POLICY';

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryable: boolean = code !== 'CONTENT_POLICY',
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

import type { ProjectState } from './types.js';

/** Structured domain errors (SPEC §40 — never swallow, always classify). */
export type ErrorClass =
  | 'RETRYABLE'
  | 'VALIDATION'
  | 'AI_QUALITY'
  | 'INTEGRATION'
  | 'HUMAN_REQUIRED'
  | 'SECURITY';

export class WppError extends Error {
  readonly code: string;
  readonly errorClass: ErrorClass;
  readonly retryable: boolean;
  readonly detail?: unknown;
  /** 429: how long the provider asked us to wait — the orchestrator schedules `runAt` from it (D-052) */
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, errorClass: ErrorClass, detail?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = 'WppError';
    this.code = code;
    this.errorClass = errorClass;
    this.retryable = errorClass === 'RETRYABLE' || errorClass === 'INTEGRATION';
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

export const ERR = {
  INVALID_SIGNATURE: () => new WppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 'SECURITY'),
  MISSING_SIGNATURE: () => new WppError('MISSING_SIGNATURE', 'Webhook request has no X-Hub-Signature-256 header', 'SECURITY'),
  INVALID_PAYLOAD: (d?: unknown) => new WppError('INVALID_PAYLOAD', 'Webhook payload is malformed', 'VALIDATION', d),
  TRANSITION_NOT_ALLOWED: (from: ProjectState, to: ProjectState, reason: string) =>
    new WppError('TRANSITION_NOT_ALLOWED', `Cannot move ${from} → ${to}: ${reason}`, 'VALIDATION'),
  REASON_REQUIRED: (id: string) => new WppError('REASON_REQUIRED', `Transition ${id} requires a reason`, 'VALIDATION'),
  WINDOW_CLOSED: (expiresAt: Date) =>
    new WppError('SEND_WINDOW_CLOSED', `Messaging window closed at ${expiresAt.toISOString()}`, 'INTEGRATION'),
  CHANNEL_UNAVAILABLE: (m: string) => new WppError('CHANNEL_UNAVAILABLE', m, 'INTEGRATION'),
  DUPLICATE: (m = 'Already processed') => new WppError('DUPLICATE', m, 'VALIDATION'),
  NOT_FOUND: (what: string, id: string) => new WppError('NOT_FOUND', `${what} ${id} not found`, 'VALIDATION'),
} as const;

export function toWppError(e: unknown): WppError {
  if (e instanceof WppError) return e;
  // An LlmError that escaped a handler keeps its provider wait so the queue can schedule from it.
  const retryAfterMs = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (e instanceof Error) {
    return new WppError('INTERNAL_ERROR', e.message, 'RETRYABLE', { stack: e.stack },
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
  }
  return new WppError('INTERNAL_ERROR', String(e), 'RETRYABLE');
}

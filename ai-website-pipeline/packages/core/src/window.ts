/**
 * Messaging window math (SPEC §31A; docs/08 §4-§5).
 * Pure functions with an injectable "now" so tests are deterministic.
 */

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLICK_TO_DIRECT_WINDOW_MS = 7 * STANDARD_WINDOW_MS;
export const HUMAN_AGENT_WINDOW_MS = 7 * STANDARD_WINDOW_MS;

export type WindowKind = 'STANDARD_24H' | 'CLICK_TO_DIRECT_7D';

export interface WindowContext {
  lastClientMessageAt: Date;
  /** true when the window was opened by a first message after a Click-to-Direct ad */
  clickToDirect?: boolean;
}

export function computeWindowExpiry(ctx: WindowContext): Date {
  const duration = ctx.clickToDirect ? CLICK_TO_DIRECT_WINDOW_MS : STANDARD_WINDOW_MS;
  return new Date(ctx.lastClientMessageAt.getTime() + duration);
}

export function isWindowOpen(expiry: Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiry) return false;
  return expiry.getTime() > now.getTime();
}

/** Human-agent tag eligibility: a human may reply up to 7 days after the client's message. */
export function isHumanAgentEligible(lastClientMessageAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastClientMessageAt) return false;
  const elapsed = now.getTime() - lastClientMessageAt.getTime();
  return elapsed >= 0 && elapsed <= HUMAN_AGENT_WINDOW_MS;
}

export type SendDecision =
  | { allowed: true; mode: 'STANDARD' }
  | { allowed: true; mode: 'HUMAN_AGENT'; requiresHumanAuthored: true }
  | { allowed: false; code: 'WINDOW_CLOSED'; message: string };

/**
 * Decide whether an outbound message may be sent. The caller must still check
 * whether the *actor* is human before using the human_agent path (§30, §31A).
 */
export function decideSend(params: {
  windowExpiresAt: Date | null | undefined;
  lastClientMessageAt: Date | null | undefined;
  now?: Date;
  humanAuthored: boolean;
  humanAgentEnabled: boolean;
}): SendDecision {
  const now = params.now ?? new Date();
  if (isWindowOpen(params.windowExpiresAt, now)) return { allowed: true, mode: 'STANDARD' };
  if (
    params.humanAuthored &&
    params.humanAgentEnabled &&
    isHumanAgentEligible(params.lastClientMessageAt, now)
  ) {
    return { allowed: true, mode: 'HUMAN_AGENT', requiresHumanAuthored: true };
  }
  return {
    allowed: false,
    code: 'WINDOW_CLOSED',
    message: 'The 24h messaging window is closed; contact the client another way or wait for a new inbound message.',
  };
}

/** Hours left until the window closes (negative when already closed). */
export function hoursUntilExpiry(expiry: Date | null | undefined, now: Date = new Date()): number | null {
  if (!expiry) return null;
  return (expiry.getTime() - now.getTime()) / (60 * 60 * 1000);
}

import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { sendRateLimits } from '../schema.js';

export type SendRateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Consume one outbound slot from a per-connection **fixed 60-second window**, durably.
 *
 * This is a fixed window, not a token bucket — `docs/08 §Rate limits`, `docs/10` and `docs/16 A5`
 * used to call it a token bucket, which promised a smoothing property the code does not have. The
 * difference is observable: because the window starts at its own first send and resets all at once,
 * a connection can be admitted for its full allowance at the end of one window and again at the
 * start of the next, i.e. up to ~2x `limitPerMinute` inside a short span around the boundary.
 * `tests/integration/send-rate-window.test.ts` pins that behaviour so it cannot change unnoticed.
 * A sliding-window log would remove it and needs a schema change (one row per send); it is deferred
 * with the rest of the Postgres/P8 work, and is acceptable for now because the self-imposed cap
 * (30/min) sits far below Meta's per-account limits.
 *
 * Simulator sends deliberately bypass this repository — they are not Meta sends. The real Instagram
 * adapter calls it before the Graph API, so concurrent workers share the same counter.
 *
 * The parameter is `Db`, not `Executor`, on purpose: this function opens its own transaction and the
 * PGlite driver has no savepoint support, so calling it with an existing `Tx` would nest one
 * transaction inside another. Typing it `Db` makes that a compile error instead of a runtime
 * surprise. A caller that needs the send and the slot to commit together does not exist today; if
 * one appears, it needs savepoints first.
 */
export async function consumeSendRateLimit(
  db: Db,
  connectionId: string,
  limitPerMinute: number,
  now = new Date(),
): Promise<SendRateLimitDecision> {
  const limit = Math.max(1, Math.floor(limitPerMinute));
  return db.transaction(async (tx) => {
    await tx.insert(sendRateLimits).values({
      connectionId, windowStartedAt: now, sentCount: 0, updatedAt: now,
    }).onConflictDoNothing();

    const [bucket] = await tx.select().from(sendRateLimits)
      .where(eq(sendRateLimits.connectionId, connectionId))
      .for('update')
      .limit(1);
    if (!bucket) throw new Error(`send-rate bucket missing for connection ${connectionId}`);

    const elapsedMs = now.getTime() - bucket.windowStartedAt.getTime();
    if (elapsedMs >= 60_000 || elapsedMs < 0) {
      await tx.update(sendRateLimits).set({ windowStartedAt: now, sentCount: 1, updatedAt: now })
        .where(eq(sendRateLimits.connectionId, connectionId));
      return { allowed: true };
    }
    if (bucket.sentCount < limit) {
      await tx.update(sendRateLimits).set({ sentCount: bucket.sentCount + 1, updatedAt: now })
        .where(eq(sendRateLimits.connectionId, connectionId));
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.max(1, 60_000 - elapsedMs) };
  });
}

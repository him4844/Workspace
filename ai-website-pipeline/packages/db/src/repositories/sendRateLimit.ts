import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { sendRateLimits } from '../schema.js';

export type SendRateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Atomically consume one outbound token from a per-connection fixed 60-second window.
 * Simulator sends deliberately bypass this repository; the real Instagram adapter calls it before
 * the Graph API, so concurrent workers share the same durable counter.
 */
export async function consumeSendRateLimit(
  ex: Executor,
  connectionId: string,
  limitPerMinute: number,
  now = new Date(),
): Promise<SendRateLimitDecision> {
  const limit = Math.max(1, Math.floor(limitPerMinute));
  return ex.transaction(async (tx) => {
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

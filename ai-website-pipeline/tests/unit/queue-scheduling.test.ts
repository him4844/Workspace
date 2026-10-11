import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations, createDb, orgRepo, queueRepo, schema, type DbHandle } from '@wpp/db';

/**
 * D-052 — a 429 that names its wait is a SCHEDULE, not a failure.
 *
 * Measured live 2026-10-08 (run #3): a daily-quota 429 carried a ~7 h 45 m retry hint; the runtime
 * could not wait it out in-run, the job re-queued on backoff, re-claimed inside the same closed
 * window, and DEAD_LETTERed within minutes. `failJob` must instead set `runAt` to the provider's
 * own deadline, so the job sleeps until the window resets and spends no attempt on re-queries.
 */
describe('queue — failJob schedules from the provider wait (D-052)', () => {
  let handle: DbHandle;
  let orgId: string;

  beforeEach(async () => {
    handle = await createDb({ memory: true });
    await applyMigrations(handle);
    orgId = await orgRepo.getOrCreateDefaultOrg(handle.db);
  });

  afterEach(async () => {
    await handle.close();
  });

  async function enqueueOne() {
    const { job } = await queueRepo.enqueueJob(handle.db, {
      orgId, type: 'REQUIREMENTS_TURN', payload: {}, idempotencyKey: `sched-${Math.random()}`,
    });
    return job;
  }

  it('re-queues at the provider deadline instead of backoff when retryAfterMs is known', async () => {
    const job = await enqueueOne();
    const before = Date.now();
    const outcome = await queueRepo.failJob(handle.db, job.id, {
      code: 'LLM_RATE_LIMITED', message: 'rate limited', retryable: true, retryAfterMs: 120_000,
    });
    expect(outcome.status).toBe('PENDING');
    const updated = await queueRepo.getJob(handle.db, job.id);
    expect(updated?.status).toBe('PENDING');
    const waitMs = updated!.runAt!.getTime() - before;
    // provider deadline (120 s) + 1 s buffer — NOT the 5 s × attempts backoff
    expect(waitMs).toBeGreaterThanOrEqual(120_000);
    expect(waitMs).toBeLessThan(130_000);
  });

  it('falls back to backoff when the provider names no wait', async () => {
    const job = await enqueueOne();
    const before = Date.now();
    await queueRepo.failJob(handle.db, job.id, {
      code: 'LLM_PROVIDER_ERROR', message: 'boom', retryable: true,
    });
    const updated = await queueRepo.getJob(handle.db, job.id);
    const waitMs = updated!.runAt!.getTime() - before;
    // REQUIREMENTS_TURN backoff = 5 000 ms × max(1, attempts=1)
    expect(waitMs).toBeGreaterThanOrEqual(5_000);
    expect(waitMs).toBeLessThan(15_000);
  });

  it('a wait beyond 24 h dead-letters instead of sleeping in the queue (escalation owns it)', async () => {
    const job = await enqueueOne();
    const outcome = await queueRepo.failJob(handle.db, job.id, {
      code: 'LLM_RATE_LIMITED', message: 'daily quota exhausted', retryable: true,
      retryAfterMs: queueRepo.MAX_SCHEDULED_RETRY_MS + 1,
    });
    expect(outcome.status).toBe('DEAD_LETTER');
    const updated = await queueRepo.getJob(handle.db, job.id);
    expect(updated?.status).toBe('DEAD_LETTER');
  });

  it('still dead-letters when attempts are exhausted, wait or no wait', async () => {
    const job = await enqueueOne();
    // REQUIREMENTS_TURN allows 3 attempts; claim+fail until the budget is gone.
    let outcome: { status: string } = { status: 'PENDING' };
    for (let i = 0; i < 5 && outcome.status === 'PENDING'; i += 1) {
      // the re-queued job is scheduled in the future — rewind it so the worker can claim it
      await handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1) }).where(eq(schema.jobs.id, job.id));
      const claimed = await queueRepo.claimNextJob(handle.db, 'tester');
      expect(claimed?.id).toBe(job.id);
      outcome = await queueRepo.failJob(handle.db, job.id, {
        code: 'LLM_RATE_LIMITED', message: 'x', retryable: true, retryAfterMs: 1_000,
      });
    }
    expect(outcome.status).toBe('DEAD_LETTER');
  });
});

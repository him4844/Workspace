import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { idempotencyKeys, jobAttempts, jobs } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import { JOB_POLICIES, type JobType } from '@wpp/core';

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  orgId: string;
  type: JobType;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

/**
 * Enqueue a job. When an idempotency key already exists the insert is a no-op (§41),
 * so a webhook replay cannot create a second work item.
 */
export async function enqueueJob(ex: Executor, input: EnqueueInput): Promise<{ job: JobRow; duplicate: boolean }> {
  const policy = JOB_POLICIES[input.type];
  const id = uuidv7();
  const inserted = await ex
    .insert(jobs)
    .values({
      id,
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      type: input.type,
      payload: (input.payload ?? {}) as object,
      idempotencyKey: input.idempotencyKey ?? null,
      runAt: input.runAt ?? new Date(),
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? policy.maxAttempts,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();

  if (inserted.length > 0) return { job: inserted[0]!, duplicate: false };

  const existing = await ex.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey!)).limit(1);
  return { job: existing[0]!, duplicate: true };
}

export async function claimNextJob(ex: Executor, workerId: string, leaseSeconds = 120): Promise<JobRow | null> {
  // Atomic claim: the sub-select locks one runnable row, skipping rows another worker holds.
  const rows = await ex.execute(sql`
    UPDATE jobs SET
      status = 'RUNNING',
      locked_by = ${workerId},
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'PENDING' AND run_at <= now()
      ORDER BY priority ASC, run_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  if (list.length === 0) return null;
  return mapJob(list[0]!);
}

/** Re-queue jobs whose worker died mid-flight (lease expired) — docs/02 §4. */
export async function requeueExpiredLeases(ex: Executor): Promise<number> {
  const rows = await ex
    .update(jobs)
    .set({ status: 'PENDING', lockedBy: null, lockedAt: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, 'RUNNING'), lte(jobs.leaseExpiresAt, new Date())))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function completeJob(ex: Executor, jobId: string, attemptStatus: 'SUCCESS' | 'NEEDS_REVIEW' = 'SUCCESS'): Promise<void> {
  const job = await getJob(ex, jobId);
  if (!job) return;
  await ex
    .update(jobs)
    .set({ status: 'DONE', lockedBy: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
  await ex.insert(jobAttempts).values({
    id: uuidv7(),
    jobId,
    attempt: job.attempts,
    status: attemptStatus,
    finishedAt: new Date(),
  });
}

export async function getJob(ex: Executor, id: string): Promise<JobRow | null> {
  const rows = await ex.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function failJob(
  ex: Executor,
  jobId: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<{ status: JobStatusLike }> {
  const job = await getJob(ex, jobId);
  if (!job) return { status: 'DONE' };
  const policy = JOB_POLICIES[job.type as JobType];
  const exhausted = job.attempts >= job.maxAttempts;
  if (error.retryable && !exhausted) {
    const backoff = policy.backoffMs * Math.max(1, job.attempts);
    await ex
      .update(jobs)
      .set({
        status: 'PENDING',
        runAt: new Date(Date.now() + backoff),
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: `${error.code}: ${error.message}`,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
    await ex.insert(jobAttempts).values({
      id: uuidv7(), jobId, attempt: job.attempts, status: 'FAILED',
      errorCode: error.code, errorDetail: error.message, finishedAt: new Date(),
    });
    return { status: 'PENDING' };
  }
  await ex
    .update(jobs)
    .set({
      status: 'DEAD_LETTER',
      lockedBy: null,
      leaseExpiresAt: null,
      lastError: `${error.code}: ${error.message}`,
      deadLetteredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
  await ex.insert(jobAttempts).values({
    id: uuidv7(), jobId, attempt: job.attempts, status: 'FAILED',
    errorCode: error.code, errorDetail: error.message, finishedAt: new Date(),
  });
  return { status: 'DEAD_LETTER' };
}

/** Park a job whose project state does not yet allow it (SPEC §4.6). Re-checked on every tick. */
export async function parkJob(ex: Executor, jobId: string, reason: string): Promise<void> {
  await ex
    .update(jobs)
    .set({ status: 'PARKED', lockedBy: null, leaseExpiresAt: null, lastError: reason, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

export async function listParkedJobs(ex: Executor, limit = 100): Promise<JobRow[]> {
  return ex.select().from(jobs).where(eq(jobs.status, 'PARKED')).orderBy(asc(jobs.runAt)).limit(limit);
}

/** Return parked jobs of a project to PENDING (called after successful transitions). */
export async function unparkJobs(ex: Executor, jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const rows = await ex
    .update(jobs)
    .set({ status: 'PENDING', lockedBy: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(inArray(jobs.id, jobIds))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function listJobs(ex: Executor, opts: { status?: string; limit?: number } = {}) {
  const q = opts.status
    ? ex.select().from(jobs).where(eq(jobs.status, opts.status as 'PENDING'))
    : ex.select().from(jobs);
  return q.orderBy(asc(jobs.runAt)).limit(opts.limit ?? 50);
}

export async function jobStats(ex: Executor) {
  const rows = await ex
    .select({ status: jobs.status, n: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status);
  return rows;
}

export type JobStatusLike = 'PENDING' | 'DONE' | 'DEAD_LETTER';

function mapJob(row: Record<string, unknown>): JobRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    projectId: (row.project_id as string | null) ?? null,
    type: String(row.type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    status: row.status as JobRow['status'],
    priority: Number(row.priority),
    runAt: new Date(row.run_at as string),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lockedBy: (row.locked_by as string | null) ?? null,
    lockedAt: row.locked_at ? new Date(row.locked_at as string) : null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string) : null,
    lastError: (row.last_error as string | null) ?? null,
    deadLetteredAt: row.dead_lettered_at ? new Date(row.dead_lettered_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function rememberIdempotencyKey(ex: Executor, key: string, scope: string): Promise<boolean> {
  const inserted = await ex.insert(idempotencyKeys).values({ key, scope }).onConflictDoNothing().returning();
  return inserted.length > 0;
}

/**
 * Orchestrator (SPEC §4): the only component that decides what runs next.
 * Claims jobs, checks that the project state allows the job, executes the handler,
 * records attempts, and applies retry/backoff/dead-letter policy.
 *
 * Agents never call other agents and never change state directly.
 */
import type { Db, JobRow } from '@wpp/db';
import { claimNextJob, completeJob, failJob, getProject, listParkedJobs, obsRepo, projectsRepo, queueRepo, unparkJobs } from '@wpp/db';
import { isJobAllowedInState, JOB_POLICIES, toWppError, type JobType } from '@wpp/core';
import type { Config, Logger } from '@wpp/infra';
import type { LlmClient } from '@wpp/agents';
import { HANDLERS, type JobHandler } from './handlers/index.js';

export interface HandlerContext {
  db: Db;
  config: Config;
  logger: Logger;
  workerId: string;
  /**
   * LLM client injected by the entrypoint (null when no provider is configured — the
   * pipeline then runs the Phase 1 acknowledgment path instead of failing, §51/D-015).
   */
  llm?: LlmClient | null;
  /**
   * The provider/model the injected client actually speaks (the resolved free route). Handlers use
   * it instead of the DB agent-config model: the seeded model is a placeholder ('gpt-5-mini') and
   * sending it to a route that cannot serve it was a real 404 in the first live run (2026-10-08).
   */
  llmRoute?: { provider: string; model: string } | null;
  /** filesystem root for artifacts (SPEC §45); tests point this at a temp directory */
  artifactsRoot?: string;
}

export interface OrchestratorDeps extends HandlerContext {}

export interface TickResult {
  processed: number;
  parked: number;
  failed: number;
  empty: boolean;
}

/** Process every currently runnable job once (used by tests and by the continuous loop). */
export async function tick(deps: OrchestratorDeps, opts: { maxJobs?: number } = {}): Promise<TickResult> {
  const max = opts.maxJobs ?? 25;
  let processed = 0;
  let parked = 0;
  let failed = 0;

  // Jobs parked on a state mismatch are re-evaluated before claiming new work,
  // so a completed transition immediately releases its follow-up jobs.
  const parkedJobs = await listParkedJobs(deps.db, 50);
  const releasable: string[] = [];
  for (const candidate of parkedJobs) {
    const state = candidate.projectId ? (await getProject(deps.db, candidate.projectId))?.state ?? null : null;
    if (isJobAllowedInState(candidate.type as JobType, state)) releasable.push(candidate.id);
  }
  if (releasable.length > 0) {
    const n = await unparkJobs(deps.db, releasable);
    deps.logger.info({ unparked: n }, 'parked jobs released after state change');
  }

  for (let i = 0; i < max; i += 1) {
    const job = await claimNextJob(deps.db, deps.workerId, deps.config.JOB_LEASE_SECONDS);
    if (!job) return { processed, parked, failed, empty: true };

    try {
      const state = job.projectId ? (await getProject(deps.db, job.projectId))?.state ?? null : null;
      if (!isJobAllowedInState(job.type as JobType, state)) {
        // Prerequisites not satisfied: park the job instead of executing it (SPEC §4.6).
        await queueRepo.parkJob(deps.db, job.id, `state ${state} does not allow ${job.type}`);
        deps.logger.warn({ jobId: job.id, type: job.type, state }, 'job parked: state mismatch');
        parked += 1;
        continue;
      }

      // HANDLERS is total over JobType, but job.type is a string read back from the database: a row
      // written by another build can name a type this binary does not know. Keep the runtime guard.
      const handler: JobHandler | undefined = HANDLERS[job.type as JobType];
      if (!handler) {
        await failAndEscalateDeadLetter(deps, job, {
          code: 'NO_HANDLER', message: `no handler for ${job.type}`, retryable: false,
        });
        failed += 1;
        continue;
      }

      await runWithTimeout(handler, deps, job);
      await completeJob(deps.db, job.id);
      processed += 1;
    } catch (err) {
      const werr = toWppError(err);
      const outcome = await failAndEscalateDeadLetter(deps, job, {
        code: werr.code, message: werr.message, retryable: werr.retryable, retryAfterMs: werr.retryAfterMs,
      });
      // §57: a failure nobody can read is a failure nobody can fix — log the provider's own words
      // (truncated), not just the error class. D-052 wait is logged so operators can see the next runAt.
      deps.logger.error(
        {
          jobId: job.id, type: job.type, code: werr.code, retryable: werr.retryable, outcome: outcome.status,
          retryAfterMs: werr.retryAfterMs,
          message: werr.message.slice(0, 400),
        },
        werr.retryAfterMs !== undefined && outcome.status === 'PENDING'
          ? 'job failed — re-queued at the provider\'s own deadline (D-052)'
          : 'job failed',
      );
      failed += 1;
    }
  }
  return { processed, parked, failed, empty: false };
}

/**
 * Persist failure/backoff and §42 escalation in one transaction. A non-retryable/depleted job
 * must not leave an otherwise runnable project silently mid-phase: T30 moves it to BLOCKED and
 * the CRITICAL HUMAN_REVIEW task carries the provider wait and suggested recovery (D-044/D-052).
 */
export async function failAndEscalateDeadLetter(
  deps: OrchestratorDeps,
  job: JobRow,
  error: { code: string; message: string; retryable: boolean; retryAfterMs?: number },
): Promise<{ status: string }> {
  return deps.db.transaction(async (tx) => {
    const outcome = await failJob(tx, job.id, error);
    if (outcome.status !== 'DEAD_LETTER' || !job.projectId) return outcome;

    const project = await projectsRepo.getProject(tx, job.projectId);
    if (!project) return outcome;
    await obsRepo.recordEvent(tx, {
      orgId: project.orgId,
      projectId: job.projectId,
      type: 'SYSTEM_ERROR',
      actorType: 'SYSTEM',
      severity: 'CRITICAL',
      payload: {
        code: 'JOB_DEAD_LETTER', jobId: job.id, jobType: job.type, failureCode: error.code,
        attempts: job.attempts, retryAfterMs: error.retryAfterMs ?? null,
      },
    });
    await obsRepo.createTask(tx, {
      orgId: project.orgId,
      projectId: job.projectId,
      type: 'HUMAN_REVIEW',
      priority: 'CRITICAL',
      title: `${job.type} gave up after ${job.attempts} attempt(s)`,
      reason: `${error.code}: ${error.message}`,
      suggestedAction: error.code === 'LLM_BUDGET_EXCEEDED'
        ? `The configured daily LLM budget ($${deps.config.LLM_DAILY_BUDGET_USD.toFixed(2)}, UTC day) would be exceeded. Wait for the next UTC day or, if the owner approves, raise the cap and verify the model's pricing before resuming.`
        // `LLM_QUOTA_EXHAUSTED` used to be tested here and is not a code anything can produce: it
        // appears in neither `LlmErrorCode` nor `AGENT_ERROR_CODES`, so this arm was dead and the
        // distinction it promised never reached an operator. Adding it would mean editing the frozen
        // §49 envelope contract, and the observable signal already exists without that: a provider
        // out of DAILY quota either names a wait of hours or names none at all, while a
        // tokens-per-minute refusal names a short one. The message now says which is which.
        : error.code === 'LLM_RATE_LIMITED'
          ? `The free provider refused the call${error.retryAfterMs !== undefined ? ` and asked us to wait ${Math.ceil(error.retryAfterMs / 60_000)} minute(s)` : ''}. The queue reschedules waits of up to 24 hours (D-052); this failure exceeded that window or exhausted its attempts. A wait measured in minutes is the tokens-per-minute window — retrying is enough. A wait measured in hours, or no wait at all, usually means the provider's DAILY quota is gone: pick another free preset in config/llm-presets.json (a different vendor has a separate bucket) instead of waiting, then resume the blocked project.`
          : 'Read the job attempt history (GET /api/v1/jobs), fix the cause, then resume the blocked project.',
      aiReport: {
        jobId: job.id, jobType: job.type, code: error.code, retryable: error.retryable,
        attempts: job.attempts, retryAfterMs: error.retryAfterMs ?? null,
      },
    });
    if (!['BLOCKED', 'COMPLETED', 'FAILED'].includes(project.state)) {
      await projectsRepo.applyTransition(tx, {
        projectId: job.projectId,
        transitionId: 'T30',
        context: { reason: 'JOB_DEAD_LETTER' },
        reason: `${job.type} dead-lettered after ${job.attempts} attempt(s): ${error.code}`,
        actorType: 'SYSTEM',
        meta: { jobId: job.id, jobType: job.type, failureCode: error.code },
      });
    }
    return outcome;
  });
}

async function runWithTimeout(handler: (ctx: HandlerContext, job: JobRow) => Promise<void>, deps: OrchestratorDeps, job: JobRow): Promise<void> {
  // The queue policy table is the single source for job timeouts (config as data, §50). A hard-coded
  // 60 s here contradicted JOB_POLICIES (SPEC_GENERATE / SPEC_AUDIT / BUILD_RUN allow 300 s+) and
  // would have killed a slow-but-healthy free-tier agent call — exactly what a free tier produces.
  const policy = JOB_POLICIES[job.type as JobType] ?? JOB_POLICIES.REQUIREMENTS_TURN;
  const policySeconds = Math.max(5, Math.round(policy.timeoutMs / 1000));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handler(deps, job),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`job ${job.id} timed out after ${policySeconds}s`)), policySeconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Continuous worker loop (apps/worker/src/index.ts). */
export async function runLoop(deps: OrchestratorDeps, opts: { signal?: AbortSignal } = {}): Promise<void> {
  // Recover jobs whose worker died mid-flight before we start claiming.
  const requeued = await queueRepo.requeueExpiredLeases(deps.db);
  if (requeued > 0) deps.logger.warn({ requeued }, 'requeued expired job leases');

  const interval = deps.config.JOB_POLL_INTERVAL_MS;
  deps.logger.info({ workerId: deps.workerId, interval }, 'orchestrator loop started');

  // Deliberately constant: the loop leaves through the abort signal below or when the process is
  // terminated, never because a condition went false.
  while (true) {
    if (opts.signal?.aborted) return;
    const result = await tick(deps);
    if (result.empty) await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


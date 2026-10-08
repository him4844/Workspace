/**
 * Orchestrator (SPEC §4): the only component that decides what runs next.
 * Claims jobs, checks that the project state allows the job, executes the handler,
 * records attempts, and applies retry/backoff/dead-letter policy.
 *
 * Agents never call other agents and never change state directly.
 */
import type { Db, JobRow } from '@wpp/db';
import { claimNextJob, completeJob, failJob, getProject, listParkedJobs, obsRepo, queueRepo, unparkJobs } from '@wpp/db';
import { isJobAllowedInState, JOB_POLICIES, toWppError, type JobType } from '@wpp/core';
import type { Config, Logger } from '@wpp/infra';
import type { LlmClient } from '@wpp/agents';
import { HANDLERS } from './handlers/index.js';

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

      const handler = HANDLERS[job.type as JobType];
      if (!handler) {
        await failJob(deps.db, job.id, { code: 'NO_HANDLER', message: `no handler for ${job.type}`, retryable: false });
        failed += 1;
        continue;
      }

      await runWithTimeout(handler, deps, job);
      await completeJob(deps.db, job.id);
      processed += 1;
    } catch (err) {
      const werr = toWppError(err);
      const outcome = await failJob(deps.db, job.id, { code: werr.code, message: werr.message, retryable: werr.retryable });
      // §57: a failure nobody can read is a failure nobody can fix — log the provider's own words
      // (truncated), not just the error class. Measured need 2026-10-08: a non-retryable audit call
      // dead-lettered and the reason only existed inside the (volatile) job row.
      deps.logger.error(
        { jobId: job.id, type: job.type, code: werr.code, retryable: werr.retryable, outcome: outcome.status, message: werr.message.slice(0, 400) },
        'job failed',
      );
      if (outcome.status === 'DEAD_LETTER' && job.projectId) {
        // §42: when automation gives up, a human must be told WHY and what to do — a log line is not
        // an escalation. Measured live 2026-10-08: a free-tier quota exhaustion dead-lettered an
        // interview turn and the project silently stopped mid-interview.
        await obsRepo.recordEvent(deps.db, {
          orgId: (await getProject(deps.db, job.projectId))?.orgId ?? '',
          projectId: job.projectId,
          type: 'SYSTEM_ERROR',
          actorType: 'SYSTEM',
          severity: 'CRITICAL',
          payload: { code: 'JOB_DEAD_LETTER', jobId: job.id, jobType: job.type, failureCode: werr.code, attempts: job.attempts },
        });
        await obsRepo.createTask(deps.db, {
          orgId: (await getProject(deps.db, job.projectId))?.orgId ?? '',
          projectId: job.projectId,
          type: 'HUMAN_REVIEW',
          priority: 'CRITICAL',
          title: `${job.type} gave up after ${job.attempts} attempt(s)`,
          reason: `${werr.code}: ${werr.message}`,
          suggestedAction: werr.code === 'LLM_QUOTA_EXHAUSTED' || werr.code === 'LLM_RATE_LIMITED'
            ? 'The free provider refused the call for longer than the in-run wait budget. Wait for the provider window (or use another free model/preset from config/llm-presets.json) and re-run the job.'
            : 'Read the job attempt history (GET /api/v1/jobs), fix the cause, then re-run the job or resume the project.',
          aiReport: { jobId: job.id, jobType: job.type, code: werr.code, retryable: werr.retryable, attempts: job.attempts },
        });
      }
      failed += 1;
    }
  }
  return { processed, parked, failed, empty: false };
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) return;
    const result = await tick(deps);
    if (result.empty) await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


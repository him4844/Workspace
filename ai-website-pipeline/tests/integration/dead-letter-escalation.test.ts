import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { obsRepo, orgRepo, projectsRepo, queueRepo, type JobRow } from '@wpp/db';
import { getConnectionForChannel } from '../../apps/api/src/services/context.js';
import { failAndEscalateDeadLetter } from '../../apps/worker/src/orchestrator.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';

/** D-044/§42: a dead-letter is an operational state change, not merely a log and a task. */
describe('orchestrator — DEAD_LETTER blocks the project and escalates atomically', () => {
  let ctx: TestContext;
  let orgId: string;
  let projectId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const connectionId = (await getConnectionForChannel(ctx.handle.db, 'SIMULATOR')).id;
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId: 'igsid_deadletter', text: 'Salom, sayt kerak', mid: `deadletter-${Date.now()}` });
    const [event] = parseInstagramWebhook(payload as never);
    const ingested = await ingestInboundEvent(ctx.handle.db, {
      orgId, connectionId, channel: 'SIMULATOR', event: event!, turnJobType: 'ECHO_REPLY',
    });
    projectId = ingested.projectId!;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('marks the job DEAD_LETTER, records a CRITICAL event/task, and moves the project to BLOCKED (T30)', async () => {
    const { job } = await queueRepo.enqueueJob(ctx.handle.db, {
      orgId,
      projectId,
      type: 'REQUIREMENTS_TURN',
      payload: { conversationId: 'test' },
      idempotencyKey: `deadletter-job-${Date.now()}`,
      maxAttempts: 1,
    });
    const deps = {
      db: ctx.handle.db,
      config: ctx.config,
logger: silentLogger(),
      workerId: 'deadletter-test',
      artifactsRoot: '/tmp/wpp-deadletter-test',
    };

    const outcome = await failAndEscalateDeadLetter(deps, job as JobRow, {
      code: 'LLM_RATE_LIMITED',
      message: 'provider daily quota exhausted; retry after 7h45m',
      retryable: false,
      retryAfterMs: 7 * 60 * 60 * 1000 + 45 * 60 * 1000,
    });

    expect(outcome.status).toBe('DEAD_LETTER');
    expect((await queueRepo.getJob(ctx.handle.db, job.id))?.status).toBe('DEAD_LETTER');
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))?.state).toBe('BLOCKED');

    const events = await obsRepo.listEvents(ctx.handle.db, projectId);
    expect(events.some((event) => event.type === 'SYSTEM_ERROR' && (event.payload as { code?: string }).code === 'JOB_DEAD_LETTER')).toBe(true);
    const tasks = await obsRepo.listOpenTasks(ctx.handle.db, projectId);
    const task = tasks.find((row) => row.type === 'HUMAN_REVIEW');
    expect(task).toMatchObject({ priority: 'CRITICAL', status: 'OPEN' });
    expect(task!.reason).toContain('7h45m');
    expect(task!.suggestedAction).toContain('provider');

    const transitions = await projectsRepo.listTransitions(ctx.handle.db, projectId);
    expect(transitions.some((row) => row.transitionId === 'T30' && row.toState === 'BLOCKED')).toBe(true);
  });

  it('does not re-block a terminal or already blocked project when a later job dead-letters', async () => {
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project).not.toBeNull();
    const { job } = await queueRepo.enqueueJob(ctx.handle.db, {
      orgId, projectId, type: 'REQUIREMENTS_TURN', payload: {}, idempotencyKey: `deadletter-second-${Date.now()}`, maxAttempts: 1,
    });
    const deps = { db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'deadletter-test' };
    await failAndEscalateDeadLetter(deps, job as JobRow, { code: 'LLM_PROVIDER_ERROR', message: 'no route', retryable: false });
    const firstTransitions = await projectsRepo.listTransitions(ctx.handle.db, projectId);
    expect(firstTransitions.filter((row) => row.transitionId === 'T30')).toHaveLength(1);

    // Blocked is human-gated; a subsequent independent dead-letter may add an incident/task but
    // must not overwrite blocked_from by recording BLOCKED → BLOCKED again.
    const { job: secondJob } = await queueRepo.enqueueJob(ctx.handle.db, {
      orgId, projectId, type: 'REQUIREMENTS_TURN', payload: {}, idempotencyKey: `deadletter-third-${Date.now()}`, maxAttempts: 1,
    });
    await failAndEscalateDeadLetter(deps, secondJob as JobRow, { code: 'LLM_PROVIDER_ERROR', message: 'again', retryable: false });
    const finalProject = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(finalProject?.state).toBe('BLOCKED');
    const finalTransitions = await projectsRepo.listTransitions(ctx.handle.db, projectId);
    expect(finalTransitions.filter((row) => row.transitionId === 'T30')).toHaveLength(1);
  });
});

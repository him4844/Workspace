import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { identityRepo, obsRepo, queueRepo, schema } from '@wpp/db';
import { eq } from 'drizzle-orm';
import { tick } from '../../apps/worker/src/orchestrator.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';

/**
 * Phase 1 acceptance, end to end through the real pipeline:
 * two clients → persisted conversations → worker reply → window-blocked escalation.
 */
describe('phase 1 vertical slice (simulator channel)', () => {
  let ctx: TestContext;
  let orgId: string;
  let connectionId: string;

  beforeEach(async () => {
    ctx = await createTestContext({ ECHO_REPLY_TEMPLATE: 'Rahmat! Savollaringizni tez orada beraman.' });
    const { getConnectionForChannel, getDefaultOrgId } = await import('../../apps/api/src/services/context.js');
    orgId = await getDefaultOrgId(ctx.handle.db);
    connectionId = (await getConnectionForChannel(ctx.handle.db, 'SIMULATOR')).id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function send(senderId: string, text: string, mid: string, at?: Date) {
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId, text, mid, at });
    const [event] = parseInstagramWebhook(payload as never);
    return ingestInboundEvent(ctx.handle.db, { orgId, connectionId, channel: 'SIMULATOR', event: event! });
  }

  it('answers a client through the worker loop and records the whole story', async () => {
    const a = await send('igsid_restaurant', 'Salom! Restoranim uchun sayt kerak', 'e2e_mid_1');
    const b = await send('igsid_clinic', 'Klinika uchun sayt kerak', 'e2e_mid_2');

    const result = await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'test-worker' });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    for (const convId of [a.conversationId, b.conversationId]) {
      const messages = await identityRepo.listMessages(ctx.handle.db, convId);
      expect(messages).toHaveLength(2);
      const outbound = messages.find((m) => m.direction === 'OUTBOUND');
      expect(outbound).toBeTruthy();
      expect(outbound!.status).toBe('SENT');
      expect(outbound!.sentAt).toBeInstanceOf(Date);
      expect(outbound!.text).toBe(ctx.config.ECHO_REPLY_TEMPLATE);
    }

    // every outbound message has an agent run (SPEC §36) even without an AI agent yet
    const runs = await obsRepo.listAgentRuns(ctx.handle.db, {});
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'SUCCESS')).toBe(true);

    const jobs = await queueRepo.jobStats(ctx.handle.db);
    expect(jobs).toEqual([{ status: 'DONE', n: 2 }]);

    // outbound messages update the business-side timestamp
    const conversation = await identityRepo.getConversation(ctx.handle.db, a.conversationId);
    expect(conversation!.lastBusinessMessageAt).toBeInstanceOf(Date);
  });

  it('a busy conversation (two rapid messages) still gets exactly one reply per turn', async () => {
    const first = await send('igsid_a', 'Birinchi xabar', 'e2e_mid_10');
    await send('igsid_a', 'Ikkinchi xabar', 'e2e_mid_11');
    await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'test-worker' });

    const messages = await identityRepo.listMessages(ctx.handle.db, first.conversationId);
    const inbound = messages.filter((m) => m.direction === 'INBOUND');
    const outbound = messages.filter((m) => m.direction === 'OUTBOUND');
    expect(inbound).toHaveLength(2);
    expect(outbound).toHaveLength(2);
  });

  it('retrying the same job does not produce a second reply', async () => {
    const a = await send('igsid_a', 'Salom', 'e2e_mid_20');
    await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'w1' });
    // simulate a crash after the send: re-run the same handler for the completed job's turn
    const messages = await identityRepo.listMessages(ctx.handle.db, a.conversationId);
    expect(messages.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1);

    // a second tick with no new jobs changes nothing
    const second = await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'w1' });
    expect(second.processed).toBe(0);
    const after = await identityRepo.listMessages(ctx.handle.db, a.conversationId);
    expect(after.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1);
  });

  it('blocks an out-of-window send and raises a human task (SPEC §31A)', async () => {
    const a = await send('igsid_a', 'Salom', 'e2e_mid_30');
    await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'test-worker' });

    // age the conversation beyond 24 hours
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    await identityRepo.touchInbound(ctx.handle.db, a.conversationId, old, new Date(old.getTime() + 24 * 3600 * 1000));

    const { message } = await identityRepo.insertMessage(ctx.handle.db, {
      conversationId: a.conversationId,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      text: 'Narx taklifi: 6 000 000 so‘m',
      humanAuthored: true,
    });
    await queueRepo.enqueueJob(ctx.handle.db, {
      orgId,
      type: 'SEND_OUTBOUND',
      payload: { messageId: message.id, conversationId: a.conversationId },
      idempotencyKey: `e2e:send:${message.id}`,
    });
    await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'test-worker' });

    const stored = await ctx.handle.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
    expect(stored[0]!.status).toBe('SEND_BLOCKED');
    expect(stored[0]!.errorCode).toBe('WINDOW_CLOSED');

    const tasks = await obsRepo.listOpenTasks(ctx.handle.db, a.projectId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe('MANUAL_SEND');

    const blockers = await ctx.handle.db.select().from(schema.events).where(eq(schema.events.type, 'MESSAGE_SEND_BLOCKED'));
    expect(blockers).toHaveLength(1);
  });

  it('parks a job whose project state does not allow it, then releases it after the state changes', async () => {
    const a = await send('igsid_a', 'Salom', 'e2e_mid_40');
    // Put the project into a state where ECHO_REPLY is not allowed (BLOCKED via human action).
    const { projectsRepo } = await import('@wpp/db');
    await ctx.handle.db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId: a.projectId,
        transitionId: 'T30',
        context: { reason: 'manual block for the test' },
        actorType: 'HUMAN',
        reason: 'manual block for the test',
      });
    });

    const parkedTick = await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'w-park' });
    expect(parkedTick.parked).toBe(1);
    expect(parkedTick.processed).toBe(0);

    // resolve the block: the parked job must be released automatically on the next tick
    await ctx.handle.db.transaction(async (tx) => {
      await projectsRepo.resetLoopCounter(tx, a.projectId, 'none');
      await projectsRepo.applyTransition(tx, {
        projectId: a.projectId,
        transitionId: 'T31',
        context: { blockedFrom: 'INTAKE', reason: 'resolved in test' },
        actorType: 'HUMAN',
        reason: 'resolved in test',
      });
    });

    const resumed = await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'w-resume' });
    expect(resumed.processed).toBe(1);
    const messages = await identityRepo.listMessages(ctx.handle.db, a.conversationId);
    expect(messages.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1);
  });
});

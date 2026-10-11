import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { channelsRepo, identityRepo, orgRepo, schema, consumeSendRateLimit } from '@wpp/db';
import { eq } from 'drizzle-orm';
import { sendOutboundMessage } from '../../apps/worker/src/services/outbound.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';

/** Phase-1 SEND_RATE_PER_MINUTE must be a real per-connection guard, not config-only. */
describe('Instagram outbound rate limit (durable, per connection)', () => {
  let ctx: TestContext;
  let orgId: string;
  let connectionId: string;
  let projectId: string;
  let conversationId: string;

  beforeEach(async () => {
    ctx = await createTestContext({ SEND_RATE_PER_MINUTE: '1' });
    orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const connection = await channelsRepo.ensureConnection(ctx.handle.db, {
      orgId, channel: 'INSTAGRAM', externalAccountId: 'ig-business-test', displayName: 'IG test',
    });
    connectionId = connection.id;
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId: 'igsid_send_limit', text: 'Salom', mid: `send-limit-${Date.now()}` });
    const [event] = parseInstagramWebhook(payload as never);
    const ingested = await ingestInboundEvent(ctx.handle.db, {
      orgId, connectionId, channel: 'INSTAGRAM', event: event!, turnJobType: 'ECHO_REPLY',
    });
    projectId = ingested.projectId!;
    conversationId = ingested.conversationId;
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function insertOutbound(text: string) {
    const { message } = await identityRepo.insertMessage(ctx.handle.db, {
      conversationId, projectId, direction: 'OUTBOUND', status: 'QUEUED', text,
    });
    return message;
  }

  it('queues an inline outbound message for a later SEND_OUTBOUND job when the connection limit is hit', async () => {
    const first = await insertOutbound('Birinchi xabar');
    // No Instagram token is configured in this test, so this consumes one local send slot then
    // safely stops before any network call.
    const firstResult = await sendOutboundMessage({ db: ctx.handle.db, config: ctx.config, logger: silentLogger() }, first.id);
    expect(firstResult.status).toBe('SEND_BLOCKED');

    const second = await insertOutbound('Ikkinchi xabar');
    const before = Date.now();
    const outcome = await sendOutboundMessage({ db: ctx.handle.db, config: ctx.config, logger: silentLogger() }, second.id);
    expect(outcome.status).toBe('RATE_LIMITED');
    if (outcome.status === 'RATE_LIMITED') expect(outcome.retryAfterMs).toBeGreaterThan(0);

    const saved = await identityRepo.getMessage(ctx.handle.db, second.id);
    expect(saved?.status).toBe('QUEUED');
    const jobs = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId));
    const sendJob = jobs.find((job) => job.type === 'SEND_OUTBOUND' && (job.payload as { messageId?: string }).messageId === second.id);
    expect(sendJob).toBeDefined();
    expect(sendJob!.runAt.getTime()).toBeGreaterThan(before);
    expect(sendJob!.idempotencyKey).toBe(`send-rate-limit:${second.id}`);
  });

  it('simulator sends bypass the Instagram API bucket', async () => {
    const simulator = await channelsRepo.ensureConnection(ctx.handle.db, {
      orgId, channel: 'SIMULATOR', externalAccountId: 'sim-send-test', displayName: 'Simulator',
    });
    const payload = buildSimulatorPayload({ accountId: simulator.id, senderId: 'igsid_sim_limit', text: 'Salom', mid: `sim-limit-${Date.now()}` });
    const [event] = parseInstagramWebhook(payload as never);
    const ingested = await ingestInboundEvent(ctx.handle.db, {
      orgId, connectionId: simulator.id, channel: 'SIMULATOR', event: event!, turnJobType: 'ECHO_REPLY',
    });
    const { message } = await identityRepo.insertMessage(ctx.handle.db, {
      conversationId: ingested.conversationId, projectId: ingested.projectId,
      direction: 'OUTBOUND', status: 'QUEUED', text: 'Simulator reply',
    });
    const outcome = await sendOutboundMessage({ db: ctx.handle.db, config: ctx.config, logger: silentLogger() }, message.id);
    expect(outcome.status).toBe('SENT');
    // The Instagram connection still has its own first slot; simulator traffic didn't consume it.
    const result = await consumeSendRateLimit(ctx.handle.db, connectionId, 1);
    expect(result.allowed).toBe(true);
  });
});

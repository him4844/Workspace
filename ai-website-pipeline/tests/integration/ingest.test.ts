import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { identityRepo, listTransitions, projectsRepo, queueRepo, schema, webhookEvents } from '@wpp/db';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../helpers/context.js';

/**
 * Integration tests against a real Postgres-compatible database (PGlite + SQL migrations).
 * They prove the guarantees from SPEC §32, §41, §33 — not mocks of them.
 */
describe('inbound ingestion (conversation engine)', () => {
  let ctx: TestContext;
  let orgId: string;
  let connectionId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
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

  it('creates client, conversation, project and job on first contact', async () => {
    const result = await send('igsid_a', 'Salom, sayt kerak', 'mid_1');
    expect(result.duplicate).toBe(false);
    expect(result.clientCreated).toBe(true);
    expect(result.projectCreated).toBe(true);
    expect(result.projectState).toBe('INTAKE');
    expect(result.jobId).toBeTruthy();

    const messages = await identityRepo.listMessages(ctx.handle.db, result.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe('INBOUND');
    expect(messages[0]!.status).toBe('RECEIVED');
    expect(messages[0]!.projectId).toBe(result.projectId);

    const jobs = await queueRepo.jobStats(ctx.handle.db);
    expect(jobs).toEqual([{ status: 'PENDING', n: 1 }]);
  });

  it('reports the conversation with an accurate message count', async () => {
    const sent = await send('igsid_a', 'Salom', 'mid_overview_1');
    await send('igsid_a', 'Yana bir xabar', 'mid_overview_2');
    const overview = await identityRepo.conversationOverview(ctx.handle.db);
    const row = overview.find((c) => c.conversationId === sent.conversationId);
    expect(row?.messageCount).toBe(2);
    expect(row?.windowExpiresAt).toBeInstanceOf(Date);
  });

  it('is idempotent for a replayed message (same mid)', async () => {
    const first = await send('igsid_a', 'Salom', 'mid_same');
    const second = await send('igsid_a', 'Salom', 'mid_same');
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);

    const messages = await identityRepo.listMessages(ctx.handle.db, first.conversationId);
    expect(messages).toHaveLength(1);
    const jobs = await queueRepo.jobStats(ctx.handle.db);
    expect(jobs).toEqual([{ status: 'PENDING', n: 1 }]);
  });

  it('keeps two clients completely separate (SPEC §32)', async () => {
    const a = await send('igsid_a', 'Restoran uchun sayt', 'mid_a1');
    const b = await send('igsid_b', 'Klinika uchun sayt', 'mid_b1');
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.projectId).not.toBe(b.projectId);

    const aMessages = await identityRepo.listMessages(ctx.handle.db, a.conversationId);
    const bMessages = await identityRepo.listMessages(ctx.handle.db, b.conversationId);
    expect(aMessages).toHaveLength(1);
    expect(bMessages).toHaveLength(1);
    expect(aMessages[0]!.text).toBe('Restoran uchun sayt');
    expect(bMessages[0]!.text).toBe('Klinika uchun sayt');

    const aConversation = await identityRepo.getConversation(ctx.handle.db, a.conversationId);
    const bConversation = await identityRepo.getConversation(ctx.handle.db, b.conversationId);
    expect(aConversation!.clientId).toBe(a.clientId);
    expect(bConversation!.clientId).toBe(b.clientId);
  });

  it('reuses the open project for follow-up messages in the same conversation', async () => {
    const first = await send('igsid_a', 'Salom', 'mid_1');
    const second = await send('igsid_a', 'Yana bir savol', 'mid_2');
    expect(second.projectId).toBe(first.projectId);
    expect(second.projectCreated).toBe(false);

    const projects = await projectsRepo.listProjects(ctx.handle.db);
    expect(projects).toHaveLength(1);

    const jobs = await queueRepo.jobStats(ctx.handle.db);
    expect(jobs).toEqual([{ status: 'PENDING', n: 2 }]);
  });

  it('records the window expiry from the client message timestamp (SPEC §31A)', async () => {
    const at = new Date('2026-10-07T10:00:00Z');
    const result = await send('igsid_a', 'Salom', 'mid_window', at);
    const conversation = await identityRepo.getConversation(ctx.handle.db, result.conversationId);
    expect(conversation!.lastClientMessageAt!.toISOString()).toBe(at.toISOString());
    expect(conversation!.windowExpiresAt!.toISOString()).toBe(new Date(at.getTime() + 24 * 3600 * 1000).toISOString());
  });

  it('applies the explicit state machine: T01 create + T02 → INTAKE', async () => {
    const result = await send('igsid_a', 'Salom', 'mid_1');
    const transitions = await listTransitions(ctx.handle.db, result.projectId);
    expect(transitions.map((t) => t.transitionId)).toEqual(['T01', 'T02']);
    expect(transitions[1]!.fromState).toBe('NEW');
    expect(transitions[1]!.toState).toBe('INTAKE');
    expect(transitions[1]!.actorType).toBe('CLIENT');
  });

  it('dedupes raw webhook events at the event level (SPEC §41)', async () => {
    const { recordInboundWebhook } = await import('@wpp/channels');
    const first = await recordInboundWebhook(ctx.handle.db, {
      channel: 'INSTAGRAM', externalEventId: 'evt_1', signatureValid: true, payload: { object: 'instagram' },
    });
    const second = await recordInboundWebhook(ctx.handle.db, {
      channel: 'INSTAGRAM', externalEventId: 'evt_1', signatureValid: true, payload: { object: 'instagram' },
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const rows = await ctx.handle.db.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, 'evt_1'));
    expect(rows).toHaveLength(1);
  });

  it('stores raw inbound attachments without exploding on unknown kinds', async () => {
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId: 'igsid_a', text: 'sticker', mid: 'mid_att' }) as never as {
      entry: Array<{ messaging: Array<Record<string, unknown>> }>;
    };
    payload.entry[0]!.messaging[0]!.message = { mid: 'mid_att', attachments: [{ type: 'image', payload: { url: 'https://x/y.jpg' } }] };
    const [event] = parseInstagramWebhook(payload as never);
    expect(event!.kind).toBe('ATTACHMENT');
    const result = await ingestInboundEvent(ctx.handle.db, { orgId, connectionId, channel: 'SIMULATOR', event: event! });
    const messages = await identityRepo.listMessages(ctx.handle.db, result.conversationId);
    expect(messages[0]!.attachments).toHaveLength(1);
  });

  it('persists every message with timestamps and actor information', async () => {
    const result = await send('igsid_a', 'Birinchi', 'mid_t1');
    const messages = await identityRepo.listMessages(ctx.handle.db, result.conversationId);
    expect(messages[0]!.createdAt).toBeInstanceOf(Date);
    expect(messages[0]!.receivedAt).toBeInstanceOf(Date);
    expect(messages[0]!.clientIdentityId).toBeTruthy();

    const events = await ctx.handle.db.select().from(schema.events).where(eq(schema.events.projectId, result.projectId));
    const types = events.map((e) => e.type).sort();
    expect(types).toContain('PROJECT_CREATED');
    expect(types).toContain('MESSAGE_INBOUND');
    expect(types).toContain('STATE_CHANGED');
  });
});

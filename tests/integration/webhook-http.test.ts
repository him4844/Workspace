import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { computeSignature } from '@wpp/channels';
import { identityRepo, listProjects, schema } from '@wpp/db';
import { eq } from 'drizzle-orm';
import { buildTestApp, createTestContext, type TestContext } from '../helpers/context.js';

/**
 * HTTP-level tests of the real webhook endpoint (docs/07 §3):
 * signature enforcement, fast ack, dedupe, and persistence through Fastify's injector.
 */
describe('POST /webhooks/instagram', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  const accountId = 'ig_account_1';

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await buildTestApp(ctx);
  });

  afterEach(async () => {
    await app.close();
    await ctx.close();
  });

  function payloadFor(mid: string, senderId: string, text: string, timestamp = Math.floor(Date.now() / 1000)) {
    return {
      object: 'instagram',
      entry: [{ id: accountId, time: timestamp, messaging: [{ sender: { id: senderId, username: 'test_user' }, recipient: { id: accountId }, timestamp, message: { mid, text } }] }],
    };
  }

  function post(body: unknown, opts: { sign?: boolean } = {}) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.sign !== false) headers['x-hub-signature-256'] = computeSignature(raw, ctx.config.IG_APP_SECRET);
    return app.inject({ method: 'POST', url: '/webhooks/instagram', payload: raw, headers });
  }

  it('GET verification handshake echoes the challenge', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=test-verify-token',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');

    const bad = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.challenge=1&hub.verify_token=wrong',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('accepts a signed event, persists it, and enqueues work', async () => {
    const res = await post(payloadFor('mid_http_1', 'igsid_http_a', 'Salom!'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { processed: number; duplicates: number } };
    expect(body.ok).toBe(true);
    expect(body.data.processed).toBe(1);

    const projects = await listProjects(ctx.handle.db);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.state).toBe('INTAKE');
    const messages = await identityRepo.listMessages(ctx.handle.db, projects[0]!.conversationId!);
    expect(messages.some((m) => m.text === 'Salom!')).toBe(true);
  });

  it('rejects an unsigned request and writes nothing', async () => {
    const res = await post(payloadFor('mid_unsigned', 'igsid_http_b', 'Salom'), { sign: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
    const projects = await listProjects(ctx.handle.db);
    expect(projects).toHaveLength(0);
    const messages = await ctx.handle.db.select().from(schema.messages);
    expect(messages).toHaveLength(0);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const raw = JSON.stringify(payloadFor('mid_bad_secret', 'igsid_http_c', 'Salom'));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': computeSignature(raw, 'attacker') },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a duplicate delivery creates no new message, project or job', async () => {
    const payload = payloadFor('mid_dup_1', 'igsid_http_d', 'Salom');
    const first = await post(payload);
    const second = await post(payload);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { data: { duplicates: number } }).data.duplicates).toBe(1);

    const projects = await listProjects(ctx.handle.db);
    expect(projects).toHaveLength(1);
    const messages = await identityRepo.listMessages(ctx.handle.db, projects[0]!.conversationId!);
    expect(messages).toHaveLength(1);
  });

  it('records a security alert for a forged signature', async () => {
    await post(payloadFor('mid_forged', 'igsid_http_e', 'Salom'), { sign: false });
    const alerts = await ctx.handle.db.select().from(schema.events).where(eq(schema.events.type, 'SECURITY_ALERT'));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!.severity).toBe('CRITICAL');
  });

  it('handles a batch with several entries independently', async () => {
    const payload = {
      object: 'instagram',
      entry: [
        { id: accountId, time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: 'igsid_batch_a' }, recipient: { id: accountId }, timestamp: Math.floor(Date.now() / 1000), message: { mid: 'mid_b1', text: 'A' } }] },
        { id: accountId, time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: 'igsid_batch_b' }, recipient: { id: accountId }, timestamp: Math.floor(Date.now() / 1000), message: { mid: 'mid_b2', text: 'B' } }] },
      ],
    };
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    const projects = await listProjects(ctx.handle.db);
    expect(projects).toHaveLength(2);
  });
});

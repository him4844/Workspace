/**
 * P2-1 / P2-2: the HTTP surface is guarded in exactly one place, and the guards actually hold.
 *
 * Before this, three route modules each registered their own root-level `preHandler`, the `/api/v1`
 * token was compared with `!==` (a short-circuiting compare that leaks how much of a guessed bearer
 * token was right), and `/dev/simulator/*` — which injects client DMs into the real ingestion path
 * and therefore spends LLM budget — was gated only by a flag that defaults to **true** and is only
 * refused when `NODE_ENV=production`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isLoopback, safeEqual } from '../../apps/api/src/auth.js';
import { buildTestApp, createTestContext, type TestContext } from '../helpers/context.js';

const TOKEN = 'test-internal-token'; // tests/helpers/context.ts sets INTERNAL_API_TOKEN to this
const REMOTE = '203.0.113.7'; // TEST-NET-3, RFC 5737: never a real host

describe('safeEqual — a shared secret must not be measurable by timing', () => {
  it('accepts an exact match and rejects everything else', () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('is not a prefix match in either direction', () => {
    expect(safeEqual(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(safeEqual(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(safeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
  });

  it('survives a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths; hashing both sides first prevents that,
    // which is also what stops the secret's length from being observable.
    expect(() => safeEqual('a', 'a'.repeat(4096))).not.toThrow();
    expect(safeEqual('a', 'a'.repeat(4096))).toBe(false);
    expect(safeEqual('a'.repeat(4096), 'a')).toBe(false);
  });
});

describe('isLoopback', () => {
  it("accepts only the machine's own addresses", () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('refuses everything else, including a missing address', () => {
    expect(isLoopback(REMOTE)).toBe(false);
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback(null)).toBe(false);
  });
});

describe('the guard is registered once, not per route module', () => {
  const routesDir = 'apps/api/src/routes';

  it('no route module registers its own preHandler hook', () => {
    const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0); // the check must actually have looked at something
    for (const file of files) {
      const src = readFileSync(join(routesDir, file), 'utf8');
      expect(src, `${file} must not register a guard — apps/api/src/auth.ts owns them`).not.toMatch(
        /addHook\(\s*['"]preHandler['"]/,
      );
    }
  });

  it('auth.ts registers exactly one hook', () => {
    const src = readFileSync('apps/api/src/auth.ts', 'utf8');
    expect((src.match(/addHook\(/g) ?? []).length).toBe(1);
  });
});

describe('/api/v1 authentication over HTTP', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await buildTestApp(ctx);
  });

  afterEach(async () => {
    await app.close();
    await ctx.close();
  });

  it('refuses a request with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('refuses a wrong token, including near-misses', async () => {
    for (const bad of ['nope', TOKEN.slice(0, -1), `${TOKEN}x`, '', TOKEN.toUpperCase()]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { 'x-internal-token': bad },
      });
      expect(res.statusCode, `token ${JSON.stringify(bad)} was accepted`).toBe(401);
    }
  });

  it('accepts the configured token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('guards the spec routes through the same single hook', async () => {
    const url = '/api/v1/projects/00000000-0000-0000-0000-000000000000/spec';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    // authorised, then the handler answers for itself: the project does not exist
    const authorised = await app.inject({ method: 'GET', url, headers: { 'x-internal-token': TOKEN } });
    expect(authorised.statusCode).toBe(404);
  });

  it('leaves the genuinely public endpoints reachable without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const handshake = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=test-verify-token',
    });
    expect(handshake.statusCode).toBe(200);
    expect(handshake.body).toBe('abc');
  });
});

describe('/dev/simulator exposure', () => {
  async function withSimulator(enabled: boolean) {
    const ctx = await createTestContext({ CHANNEL_SIMULATOR_ENABLED: enabled ? 'true' : 'false' });
    const app = await buildTestApp(ctx);
    return { ctx, app, close: async () => { await app.close(); await ctx.close(); } };
  }

  /** An empty body reaches the handler's own Zod check, so 400 proves the guard let it through. */
  const injectInbound = (app: FastifyInstance, remoteAddress?: string) =>
    app.inject({
      method: 'POST',
      url: '/dev/simulator/inbound',
      payload: {},
      ...(remoteAddress ? { remoteAddress } : {}),
    });

  it('is refused for a non-loopback peer even when the flag is on', async () => {
    const { app, close } = await withSimulator(true);
    const res = await injectInbound(app, REMOTE);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'simulator channel is local-only' },
    });
    await close();
  });

  it('reaches the handler from loopback when the flag is on', async () => {
    const { app, close } = await withSimulator(true);
    const res = await injectInbound(app, '127.0.0.1');
    expect(res.statusCode).toBe(400); // the guard passed; the body is what is wrong
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    await close();
  });

  it('is refused for everyone when the flag is off, loopback included', async () => {
    const { app, close } = await withSimulator(false);
    const res = await injectInbound(app, '127.0.0.1');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'simulator channel is disabled' },
    });
    await close();
  });

  it('also covers the console endpoints registered in a different module', async () => {
    // /dev/simulator/lookup lives in simulator-console.ts, not simulator.ts: a per-module hook
    // could never have covered both, which is the point of one central guard.
    const { app, close } = await withSimulator(true);
    const remote = await app.inject({ method: 'GET', url: '/dev/simulator/lookup?senderId=x', remoteAddress: REMOTE });
    expect(remote.statusCode).toBe(404);
    await close();
  });
});

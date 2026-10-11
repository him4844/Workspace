/**
 * P2-5: pins what the outbound send limiter actually IS — a durable fixed 60-second window, not the
 * token bucket that `docs/08`, `docs/10` and `docs/16 A5` used to claim.
 *
 * The distinction is not pedantry: a token bucket smooths traffic, a fixed window does not, so up to
 * about twice the allowance can pass around a window boundary. Those documents now say "fixed
 * 60-second window" and this file is the evidence — if anyone ever replaces the counter with a
 * sliding window or a real bucket, the burst test below fails and the docs get updated with it.
 *
 * Every call passes an explicit `now`, so the window boundary is tested deterministically rather
 * than by sleeping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsRepo, consumeSendRateLimit, orgRepo, schema } from '@wpp/db';
import { createTestContext, type TestContext } from '../helpers/context.js';

const T0 = new Date('2026-10-11T00:00:00.000Z').getTime();
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const LIMIT = 2;

describe('send rate limiter — fixed 60-second window semantics (D-062)', () => {
  let ctx: TestContext;
  let connectionId: string;
  let orgId: string;

  beforeEach(async () => {
    ctx = await createTestContext({ SEND_RATE_PER_MINUTE: String(LIMIT) });
    orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const connection = await channelsRepo.ensureConnection(ctx.handle.db, {
      orgId, channel: 'INSTAGRAM', externalAccountId: 'ig-window-test', displayName: 'IG window',
    });
    connectionId = connection.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  const consume = (seconds: number, limit = LIMIT, id = connectionId) =>
    consumeSendRateLimit(ctx.handle.db, id, limit, at(seconds));

  it('admits up to the limit inside one window, then refuses and says how long is left', async () => {
    expect((await consume(0)).allowed).toBe(true);
    expect((await consume(1)).allowed).toBe(true);

    const refused = await consume(2);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      // the whole remaining window, so D-052 reschedules the job at the provider's own deadline
      expect(refused.retryAfterMs).toBe(58_000);
    }
  });

  it('keeps refusing until the window has fully elapsed, then resets all at once', async () => {
    expect((await consume(0)).allowed).toBe(true);
    expect((await consume(0)).allowed).toBe(true);
    expect((await consume(30)).allowed).toBe(false);
    expect((await consume(59)).allowed).toBe(false);
    expect((await consume(60)).allowed).toBe(true); // elapsed >= 60_000 rolls the window over
    expect((await consume(60)).allowed).toBe(true);
    expect((await consume(60)).allowed).toBe(false);
  });

  it('PINS THE GAP: a boundary burst passes more than the per-minute limit', async () => {
    expect((await consume(0)).allowed).toBe(true); // the window opens here
    expect((await consume(59)).allowed).toBe(true); // 2nd of 2, one second before the boundary
    expect((await consume(59.5)).allowed).toBe(false);
    expect((await consume(60)).allowed).toBe(true); // rollover: the full allowance is back
    expect((await consume(60)).allowed).toBe(true);

    // Three admissions between t=59 s and t=60 s against a limit of 2 per minute. A token bucket
    // would have admitted about two. This is the residual gap recorded in docs/16 A5, not a
    // surprise: it is why the self-imposed cap sits far below Meta's per-account limits.
  });

  it('rolls the window over when the clock goes backwards instead of wedging the connection', async () => {
    expect((await consume(100)).allowed).toBe(true);
    expect((await consume(100)).allowed).toBe(true);
    expect((await consume(100)).allowed).toBe(false);
    // elapsed < 0 means the stored window start is in the future relative to `now` — a wrong clock
    // must cost one window, not block the connection forever.
    expect((await consume(50)).allowed).toBe(true);
  });

  it('counts per connection, not globally', async () => {
    // `ensureConnection` deliberately keeps ONE active connection per channel (SPEC §2: one team,
    // one primary Instagram business account), so a second Instagram connection cannot be created
    // here — the isolation has to be demonstrated across two channels instead.
    const other = await channelsRepo.ensureConnection(ctx.handle.db, {
      orgId, channel: 'TELEGRAM', externalAccountId: 'tg-window-test', displayName: 'TG window',
    });
    expect(other.id).not.toBe(connectionId);

    expect((await consume(0)).allowed).toBe(true);
    expect((await consume(0)).allowed).toBe(true);
    expect((await consume(0)).allowed).toBe(false);
    // the other connection has its own allowance at the same instant
    expect((await consume(0, LIMIT, other.id)).allowed).toBe(true);
    expect((await consume(0, LIMIT, other.id)).allowed).toBe(true);
    expect((await consume(0, LIMIT, other.id)).allowed).toBe(false);
  });

  it('clamps a nonsense limit so a connection can never be silenced completely', async () => {
    expect((await consume(200, 0)).allowed).toBe(true); // max(1, floor(0)) === 1
    expect((await consume(200, 0)).allowed).toBe(false);
  });

  it('floors a fractional limit rather than rounding it up', async () => {
    expect((await consume(300, 2.7)).allowed).toBe(true);
    expect((await consume(300, 2.7)).allowed).toBe(true);
    expect((await consume(300, 2.7)).allowed).toBe(false); // floor(2.7) === 2, not 3
  });

  it('persists the counter in one durable row, so concurrent workers share an allowance', async () => {
    expect((await consume(400)).allowed).toBe(true);
    expect((await consume(400)).allowed).toBe(true);
    const rows = await ctx.handle.db.select().from(schema.sendRateLimits);
    expect(rows.length).toBe(1);
    expect(rows[0]!.connectionId).toBe(connectionId);
    expect(Number(rows[0]!.sentCount)).toBe(2);
    expect(rows[0]!.windowStartedAt.toISOString()).toBe(at(400).toISOString());
  });
});

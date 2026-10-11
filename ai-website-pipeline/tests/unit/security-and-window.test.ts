import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature, verifyHandshake } from '@wpp/channels';
import { decideSend, computeWindowExpiry, isHumanAgentEligible, isWindowOpen, STANDARD_WINDOW_MS } from '@wpp/core';

describe('webhook signature verification (SPEC §31A(5))', () => {
  const secret = 'test-app-secret';
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));

  it('accepts the signature produced with the app secret', () => {
    const header = computeSignature(body, secret);
    expect(verifySignature({ rawBody: body, header, appSecret: secret })).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    const header = computeSignature(body, 'attacker-secret');
    expect(verifySignature({ rawBody: body, header, appSecret: secret })).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifySignature({ rawBody: body, header: undefined, appSecret: secret })).toBe(false);
    expect(verifySignature({ rawBody: body, header: 'sha256=deadbeef', appSecret: secret })).toBe(false);
    expect(verifySignature({ rawBody: body, header: 'nonsense', appSecret: secret })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const header = computeSignature(body, secret);
    const tampered = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: 'evil' }] }));
    expect(verifySignature({ rawBody: tampered, header, appSecret: secret })).toBe(false);
  });

  it('verification handshake echoes the challenge only with the right token', () => {
    const query = { 'hub.mode': 'subscribe', 'hub.challenge': '1158201444', 'hub.verify_token': 'test-verify-token' };
    expect(verifyHandshake(query, 'test-verify-token')).toEqual({ ok: true, challenge: '1158201444' });
    expect(verifyHandshake({ ...query, 'hub.verify_token': 'wrong' }, 'test-verify-token').ok).toBe(false);
    expect(verifyHandshake({ ...query, 'hub.mode': 'unsubscribe' }, 'test-verify-token').ok).toBe(false);
  });
});

describe('messaging window math (SPEC §31A(3), docs/08 §4)', () => {
  const now = new Date('2026-10-07T12:00:00Z');

  it('a standard window lasts 24 hours from the client message', () => {
    const last = new Date('2026-10-07T10:00:00Z');
    const expiry = computeWindowExpiry({ lastClientMessageAt: last });
    expect(expiry.getTime() - last.getTime()).toBe(STANDARD_WINDOW_MS);
    expect(isWindowOpen(expiry, now)).toBe(true);
    expect(isWindowOpen(expiry, new Date('2026-10-08T10:00:01Z'))).toBe(false);
  });

  it('the click-to-direct window lasts up to 7 days', () => {
    const last = new Date('2026-10-01T10:00:00Z');
    const expiry = computeWindowExpiry({ lastClientMessageAt: last, clickToDirect: true });
    expect(expiry.getTime() - last.getTime()).toBe(7 * STANDARD_WINDOW_MS);
    expect(isWindowOpen(expiry, now)).toBe(true);
  });

  it('the boundary is exclusive: exactly at expiry the window is closed', () => {
    const last = new Date('2026-10-06T12:00:00Z');
    const expiry = computeWindowExpiry({ lastClientMessageAt: last });
    expect(isWindowOpen(expiry, expiry)).toBe(false);
    expect(isWindowOpen(expiry, new Date(expiry.getTime() - 1))).toBe(true);
  });

  it('a new inbound message restarts the window', () => {
    const first = new Date('2026-10-06T12:00:00Z');
    const expired = computeWindowExpiry({ lastClientMessageAt: first });
    expect(isWindowOpen(expired, now)).toBe(false);
    const restarted = computeWindowExpiry({ lastClientMessageAt: now });
    expect(isWindowOpen(restarted, now)).toBe(true);
  });

  it('human-agent eligibility extends to 7 days after the client message', () => {
    const last = new Date('2026-10-02T12:00:00Z'); // 5 days before `now`
    expect(isHumanAgentEligible(last, now)).toBe(true);
    expect(isHumanAgentEligible(new Date('2026-09-29T12:00:00Z'), now)).toBe(false);
    expect(isHumanAgentEligible(null, now)).toBe(false);
  });

  it('decideSend: standard inside the window, human_agent only for humans, blocked otherwise', () => {
    const last = new Date('2026-10-07T11:00:00Z');
    const open = computeWindowExpiry({ lastClientMessageAt: last });
    expect(decideSend({ windowExpiresAt: open, lastClientMessageAt: last, now, humanAuthored: false, humanAgentEnabled: false }))
      .toEqual({ allowed: true, mode: 'STANDARD' });

    const closedOld = new Date('2026-10-01T11:00:00Z'); // > 24h, < 7d
    const closed = computeWindowExpiry({ lastClientMessageAt: closedOld });
    expect(decideSend({ windowExpiresAt: closed, lastClientMessageAt: closedOld, now, humanAuthored: true, humanAgentEnabled: true }))
      .toEqual({ allowed: true, mode: 'HUMAN_AGENT', requiresHumanAuthored: true });

    // the AI must never be allowed to use the human-agent path
    expect(decideSend({ windowExpiresAt: closed, lastClientMessageAt: closedOld, now, humanAuthored: false, humanAgentEnabled: true }).allowed).toBe(false);
    // nor may a human use it when the feature is not approved
    expect(decideSend({ windowExpiresAt: closed, lastClientMessageAt: closedOld, now, humanAuthored: true, humanAgentEnabled: false }).allowed).toBe(false);
    // beyond 7 days there is no path at all
    const tooOld = new Date('2026-09-20T11:00:00Z');
    expect(decideSend({ windowExpiresAt: new Date(0), lastClientMessageAt: tooOld, now, humanAuthored: true, humanAgentEnabled: true }).allowed).toBe(false);
  });
});

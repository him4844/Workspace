/**
 * Instagram webhook authenticity (SPEC §31A(5), docs/08 §3).
 * X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(appSecret, rawBody), compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeSignature(rawBody: Buffer | string, appSecret: string): string {
  const digest = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

export function verifySignature(params: {
  rawBody: Buffer | string;
  header: string | undefined | null;
  appSecret: string;
}): boolean {
  if (!params.header) return false;
  const expected = computeSignature(params.rawBody, params.appSecret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(params.header.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface VerificationQuery {
  'hub.mode'?: string;
  'hub.challenge'?: string;
  'hub.verify_token'?: string;
}

export function verifyHandshake(query: VerificationQuery, verifyToken: string): { ok: boolean; challenge?: string } {
  if (query['hub.mode'] !== 'subscribe') return { ok: false };
  if (query['hub.verify_token'] !== verifyToken) return { ok: false };
  const challenge = query['hub.challenge'];
  if (!challenge) return { ok: false };
  return { ok: true, challenge };
}

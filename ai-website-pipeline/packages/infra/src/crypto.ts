/**
 * Token encryption at rest (SPEC §37, docs/10 §3).
 * AES-256-GCM; key derived from TOKEN_ENCRYPTION_KEY (32 bytes when the value is base64, otherwise SHA-256 of the string).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function deriveKey(secret: string): Buffer {
  const maybeBase64 = /^[A-Za-z0-9+/=]{43,44}$/.test(secret);
  if (maybeBase64) {
    const buf = Buffer.from(secret, 'base64');
    if (buf.length === 32) return buf;
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptSecret(payload: string, secret: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported secret format');
  const [, ivB64, dataB64, tagB64] = parts as [string, string, string, string];
  const key = deriveKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

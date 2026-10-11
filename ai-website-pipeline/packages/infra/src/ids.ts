import { randomBytes } from 'node:crypto';

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * UUIDv7 (RFC 9562 layout): time-ordered, stable across environments.
 * Used for every primary key in the schema (docs/03 conventions).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = now;
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const h = (i: number) => HEX[bytes[i]!]!;
  return (
    `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-` +
    `${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
  );
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

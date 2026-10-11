/**
 * P1-1: `DB_DRIVER=postgres` must not silently become an embedded PGlite database.
 *
 * docs/18 §2.1 targets Postgres in production and `infra/docker-compose.yml` sets
 * `DB_DRIVER=postgres`, but only the PGlite driver exists — there is no `pg` dependency and no
 * node-postgres adapter, and `applyMigrations()` drives the raw PGlite client. Asking for Postgres
 * is therefore a configuration error and has to fail fast, before a PGlite instance (and its data
 * directory) is created.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WppError } from '@wpp/core';
import { assertDbDriverSupported, createDb } from '@wpp/db';

describe('DB_DRIVER support guard (docs/18 §2.1)', () => {
  it('accepts pglite and an unset driver', () => {
    expect(() => assertDbDriverSupported('pglite')).not.toThrow();
    expect(() => assertDbDriverSupported(undefined)).not.toThrow();
  });

  it('refuses postgres with a classified, non-retryable error', () => {
    let err: unknown;
    try {
      assertDbDriverSupported('postgres');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WppError);
    const failure = err as WppError;
    expect(failure.code).toBe('DB_DRIVER_UNSUPPORTED');
    expect(failure.errorClass).toBe('VALIDATION');
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toMatchObject({ driver: 'postgres' });
    // The message has to be actionable on its own: an operator reading one log line must know
    // which driver was asked for, why it failed and what to do instead.
    expect(failure.message).toMatch(/DB_DRIVER="postgres"/);
    expect(failure.message).toMatch(/not implemented/);
    expect(failure.message).toMatch(/PGlite/);
    expect(failure.message).toMatch(/Refusing to fall back/i);
  });

  it('throws from createDb before creating any data directory', async () => {
    const dir = join(tmpdir(), `wpp-driver-guard-${process.pid}-${Date.now()}`);
    await expect(createDb({ driver: 'postgres', dataDir: dir })).rejects.toMatchObject({
      code: 'DB_DRIVER_UNSUPPORTED',
    });
    // The old behaviour opened `.pglite` right here; the guard must run first.
    expect(existsSync(dir)).toBe(false);
  });

  it('still opens an in-memory PGlite database for the supported drivers', async () => {
    const handle = await createDb({ memory: true });
    const rows = await handle.pglite.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows.rows[0]?.ok).toBe(1);
    await handle.close();

    const explicit = await createDb({ driver: 'pglite', memory: true });
    expect(explicit.pglite).toBeDefined();
    await explicit.close();
  });
});

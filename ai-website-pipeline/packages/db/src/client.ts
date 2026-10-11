/**
 * DB handle (docs/18 §2.1 targets Postgres in prod and PGlite in dev/CI; as of P0–P4 only the
 * PGlite driver is implemented, and `assertDbDriverSupported` says so loudly rather than silently
 * substituting an embedded database).
 * Only this package writes SQL; other packages use repositories.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { SQL } from 'drizzle-orm';
import { WppError } from '@wpp/core';
import { schema } from './schema.js';

function makeDb(client: PGlite) {
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof makeDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pglite: PGlite;
  close(): Promise<void>;
}

/** Accepted values of `DB_DRIVER` (packages/infra/src/config.ts). */
export type DbDriver = 'pglite' | 'postgres';

export interface CreateDbOptions {
  dataDir?: string;
  memory?: boolean;
  /**
   * `config.DB_DRIVER`. Pass it, or an unsupported driver cannot be detected: callers that only
   * pass `dataDir` used to get a PGlite database even when the deployment asked for Postgres.
   */
  driver?: DbDriver;
}

/**
 * Only the PGlite driver exists. There is no `pg` dependency, no node-postgres adapter, and
 * `applyMigrations()` talks to the raw PGlite client (`handle.pglite.exec`). `infra/docker-compose.yml`
 * nevertheless sets `DB_DRIVER=postgres` and points `DATABASE_URL` at a Postgres service.
 *
 * Before this guard, every production caller computed
 * `dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined`, so `postgres` arrived here
 * as "no dataDir" and quietly opened an embedded `.pglite` database: the process looked healthy,
 * served traffic and wrote rows that no other process could ever read. Failing fast is the honest
 * behaviour until a real driver lands — the same discipline `config.ts` already applies to
 * production secrets, and the same one the worker applies to unimplemented job types.
 */
export function assertDbDriverSupported(driver: DbDriver | undefined): void {
  if (driver === undefined || driver === 'pglite') return;
  throw new WppError(
    'DB_DRIVER_UNSUPPORTED',
    `DB_DRIVER="${driver}" is not implemented: only the PGlite driver exists (no "pg" dependency, ` +
      'no node-postgres adapter, and applyMigrations() uses the raw PGlite client). ' +
      'Set DB_DRIVER=pglite for local dev/CI, or implement the Postgres driver first. ' +
      'Refusing to fall back to an embedded PGlite database silently.',
    'VALIDATION',
    { driver },
  );
}

export async function createDb(opts: CreateDbOptions = {}): Promise<DbHandle> {
  assertDbDriverSupported(opts.driver);
  const pglite = opts.memory ? new PGlite() : new PGlite(opts.dataDir ?? '.pglite');
  // PGlite exposes waitReady in some versions; awaiting guards against races in others.
  const maybeReady = (pglite as unknown as { waitReady?: Promise<void> }).waitReady;
  if (maybeReady) await maybeReady;
  const db = makeDb(pglite);
  return {
    db,
    pglite,
    close: async () => { await pglite.close(); },
  };
}

/**
 * Execute raw SQL and normalise the result shape across drivers (drizzle returns
 * `{ rows }` for pglite and node-postgres alike; we defend against both anyway).
 */
export async function rawRows<T = Record<string, unknown>>(ex: Executor, query: SQL): Promise<T[]> {
  const res = (await ex.execute(query)) as unknown;
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object' && Array.isArray((res as { rows?: unknown[] }).rows)) {
    return (res as { rows: T[] }).rows;
  }
  return [];
}

export async function rawOne<T = Record<string, unknown>>(ex: Executor, query: SQL): Promise<T | null> {
  const rows = await rawRows<T>(ex, query);
  return rows.length > 0 ? rows[0]! : null;
}

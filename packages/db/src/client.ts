/**
 * DB handle (docs/18 §2.1: Postgres in prod, PGlite in dev/CI).
 * Only this package writes SQL; other packages use repositories.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { SQL } from 'drizzle-orm';
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

export async function createDb(opts: { dataDir?: string; memory?: boolean } = {}): Promise<DbHandle> {
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

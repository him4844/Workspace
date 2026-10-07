import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from './client.js';

/**
 * Forward-only SQL migrations (docs/15 §3). Applied file-by-file, recorded in schema_migrations.
 * Uses the raw PGlite client because migration files contain multiple statements.
 */
export async function applyMigrations(handle: DbHandle, migrationsDir = 'db/migrations'): Promise<string[]> {
  const client = handle.pglite;
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRes = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.version));
  const newly: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(migrationsDir, file), 'utf8');
    await client.exec(sqlText);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    newly.push(file);
  }
  return newly;
}

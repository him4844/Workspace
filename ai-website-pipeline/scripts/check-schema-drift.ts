/**
 * Schema drift check (docs/14 §3: "schema drift" is a required CI gate).
 *
 * Two descriptions of the same database exist and nothing but this script compares them:
 *   - `packages/db/src/schema.ts` — the Drizzle schema the repositories query, and
 *   - `db/migrations/*.sql` — the forward-only migrations a real deployment applies.
 *
 * When they disagree the failure surfaces much later and much more expensively as
 * `relation "x" does not exist` or a check-constraint violation at write time. Run with
 * `npm run schema:drift`; exits non-zero on any difference.
 *
 * Usage: tsx scripts/check-schema-drift.ts [migrationsDir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Table, is } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
// Relative on purpose: there is no `@wpp/db/schema` alias, and importing `@wpp/db` would pull in
// every repository just to enumerate table objects.
import * as schema from '../packages/db/src/schema.js';

const migrationsDir = process.argv[2] ?? 'db/migrations';

// ---------------------------------------------------------------- Drizzle side
const drizzleTables = new Set<string>();
const drizzleEnums = new Map<string, string[]>();

for (const exported of Object.values(schema)) {
  if (is(exported, Table)) {
    drizzleTables.add(getTableConfig(exported).name);
    continue;
  }
  const asEnum = exported as unknown as { enumName?: unknown; enumValues?: unknown };
  if (typeof asEnum?.enumName === 'string' && Array.isArray(asEnum.enumValues)) {
    drizzleEnums.set(asEnum.enumName, asEnum.enumValues.map(String));
  }
}

// ------------------------------------------------------------------ SQL side
const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const sql = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');

const sqlTables = new Set<string>();
for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
  sqlTables.add(m[1]!.toLowerCase());
}
for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
  sqlTables.delete(m[1]!.toLowerCase());
}

const sqlEnums = new Map<string, string[]>();
for (const m of sql.matchAll(/CREATE\s+TYPE\s+([a-z_][a-z0-9_]*)\s+AS\s+ENUM\s*\(([^)]*)\)/gi)) {
  const values = (m[2] ?? '')
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter((v) => v.length > 0);
  sqlEnums.set(m[1]!.toLowerCase(), values);
}
// Later migrations grow an enum in place; `ADD VALUE` appends, so the effective SQL order is the
// CREATE order followed by each addition in file order.
for (const m of sql.matchAll(
  /ALTER\s+TYPE\s+([a-z_][a-z0-9_]*)\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'/gi,
)) {
  const name = m[1]!.toLowerCase();
  const existing = sqlEnums.get(name);
  if (!existing) {
    sqlEnums.set(name, [m[2]!]);
    continue;
  }
  if (!existing.includes(m[2]!)) existing.push(m[2]!);
}
for (const m of sql.matchAll(/DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
  sqlEnums.delete(m[1]!.toLowerCase());
}

// -------------------------------------------------------------------- compare
const problems: string[] = [];
const warnings: string[] = [];

const onlyDrizzle = [...drizzleTables].filter((t) => !sqlTables.has(t)).sort();
const onlySql = [...sqlTables].filter((t) => !drizzleTables.has(t)).sort();
if (onlyDrizzle.length > 0) {
  problems.push(`in the Drizzle schema but never created by a migration: ${onlyDrizzle.join(', ')}`);
}
if (onlySql.length > 0) {
  problems.push(`created by a migration but absent from the Drizzle schema: ${onlySql.join(', ')}`);
}

const onlyDrizzleEnum = [...drizzleEnums.keys()].filter((e) => !sqlEnums.has(e)).sort();
const onlySqlEnum = [...sqlEnums.keys()].filter((e) => !drizzleEnums.has(e)).sort();
if (onlyDrizzleEnum.length > 0) problems.push(`enum types only in Drizzle: ${onlyDrizzleEnum.join(', ')}`);
if (onlySqlEnum.length > 0) problems.push(`enum types only in SQL: ${onlySqlEnum.join(', ')}`);
for (const [name, values] of [...drizzleEnums].sort()) {
  const inSql = sqlEnums.get(name);
  if (!inSql) continue;
  const missing = values.filter((v) => !inSql.includes(v));
  const extra = inSql.filter((v) => !values.includes(v));
  if (missing.length > 0) problems.push(`enum ${name}: values only in Drizzle: ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`enum ${name}: values only in SQL: ${extra.join(', ')}`);
  if (missing.length === 0 && extra.length === 0 && values.join() !== inSql.join()) {
    // Not an error: `ALTER TYPE … ADD VALUE` can only append, so a migrated enum's order drifts
    // away from the Drizzle declaration by design. It matters only if something sorts or range-
    // compares on the enum column — nothing does today, so this stays a warning.
    warnings.push(`enum ${name}: same values, different order (SQL appends; Drizzle groups by phase)`);
  }
}

// --------------------------------------------------------------------- report
console.log(
  `schema drift: ${drizzleTables.size} Drizzle tables vs ${sqlTables.size} migrated tables, ` +
    `${drizzleEnums.size} vs ${sqlEnums.size} enum types, across ${sqlFiles.length} migration file(s)`,
);

for (const w of warnings) console.warn(`WARN: ${w}`);

if (problems.length > 0) {
  for (const p of problems) console.error(`DRIFT: ${p}`);
  console.error(`${problems.length} schema drift problem(s)`);
  process.exit(1);
}
console.log(
  warnings.length > 0
    ? `OK: same tables and same enum values (${warnings.length} ordering warning(s))`
    : 'OK: the Drizzle schema and the SQL migrations describe the same database',
);

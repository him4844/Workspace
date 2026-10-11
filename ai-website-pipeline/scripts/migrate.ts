import { applyMigrations, createDb } from '@wpp/db';
import { loadConfig } from '@wpp/infra';

const config = loadConfig();
const handle = await createDb({ dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined });
const applied = await applyMigrations(handle);
console.log(applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'No new migrations.');
await handle.close();

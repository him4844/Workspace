/** Worker entrypoint: config → db → migrate → orchestrator loop. */
import { applyMigrations, createDb } from '@wpp/db';
import { createLogger, loadConfig, uuidv7 } from '@wpp/infra';
import { runLoop } from './orchestrator.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const handle = await createDb({ dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined });
  const applied = await applyMigrations(handle);
  if (applied.length > 0) logger.info({ applied }, 'migrations applied');

  const workerId = `worker-${uuidv7().slice(0, 8)}`;
  const controller = new AbortController();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    controller.abort();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runLoop({ db: handle.db, config, logger, workerId }, { signal: controller.signal });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker failed to start:', err);
  process.exit(1);
});

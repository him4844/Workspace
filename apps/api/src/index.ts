/** API entrypoint: config → db → migrate → serve (and the worker loop when embedded). */
import { createDb, applyMigrations } from '@wpp/db';
import { createLogger, loadConfig, uuidv7 } from '@wpp/infra';
import { resolveLlmClient } from '../../worker/src/services/llm.js';
import { runLoop } from '../../worker/src/orchestrator.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const handle = await createDb({ dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined });
  const applied = await applyMigrations(handle);
  if (applied.length > 0) logger.info({ applied }, 'migrations applied');

  const app = await buildApp({ db: handle.db, config, logger });
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  logger.info({ port: config.API_PORT, simulator: config.CHANNEL_SIMULATOR_ENABLED }, 'api listening');

  // PGlite cannot be shared between processes (single embedded database), so in dev the
  // orchestrator runs in this process; with PostgreSQL the worker runs as its own service.
  const workerController = new AbortController();
  const embeddedWorker = config.EMBEDDED_WORKER || config.DB_DRIVER === 'pglite';
  if (embeddedWorker) {
    const workerId = `embedded-${uuidv7().slice(0, 8)}`;
    const resolved = await resolveLlmClient(config, logger);
    logger.info({ workerId, llm: resolved?.defaultProvider ?? 'none', model: resolved?.defaultModel ?? null }, 'embedded worker loop starting');
    void runLoop(
      { db: handle.db, config, logger, workerId, llm: resolved?.client ?? null, artifactsRoot: 'data' },
      { signal: workerController.signal },
    ).catch((err) => {
      logger.error({ err }, 'embedded worker loop stopped unexpectedly');
    });
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    workerController.abort();
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('api failed to start:', err);
  process.exit(1);
});

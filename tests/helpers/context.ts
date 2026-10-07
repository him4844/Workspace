/**
 * Test harness: an in-memory PGlite database with migrations applied.
 * Each call gets its own isolated database (docs/14 §6).
 */
import { applyMigrations, createDb, type DbHandle } from '@wpp/db';
import { configFrom, type Config } from '@wpp/infra';
import type { FastifyInstance } from 'fastify';

export interface TestContext {
  handle: DbHandle;
  config: Config;
  close(): Promise<void>;
}

export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const handle = await createDb({ memory: true });
  await applyMigrations(handle);
  const config = configFrom({
    NODE_ENV: 'test',
    DB_DRIVER: 'pglite',
    CHANNEL_SIMULATOR_ENABLED: 'true',
    WEBHOOK_REQUIRE_SIGNATURE: 'true',
    IG_APP_SECRET: 'test-app-secret',
    IG_VERIFY_TOKEN: 'test-verify-token',
    INTERNAL_API_TOKEN: 'test-internal-token',
    LOG_LEVEL: 'silent',
    ...env,
  });
  return {
    handle,
    config,
    close: async () => {
      await handle.close();
    },
  };
}

export async function buildTestApp(ctx: TestContext): Promise<FastifyInstance> {
  const { buildApp } = await import('../../apps/api/src/app.js');
  const { createLogger } = await import('@wpp/infra');
  return buildApp({ db: ctx.handle.db, config: ctx.config, logger: createLogger('silent') });
}

export function silentLogger() {
  const noop = () => {};
  const logger: Record<string, unknown> = {};
  logger.info = noop; logger.warn = noop; logger.error = noop; logger.debug = noop;
  logger.child = () => logger;
  return logger as never;
}

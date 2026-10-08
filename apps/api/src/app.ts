/**
 * Fastify application (docs/07). Phase 1 routes:
 *  - /webhooks/instagram        GET verification handshake, POST signed events
 *  - /dev/simulator/*           dev-only channel (CHANNEL_SIMULATOR_ENABLED)
 *  - /api/v1/*                  inspection + internal send + specification/change-request endpoints
 *  - /, /simulator           dev console (HTML, simulator channel only)
 *  - /healthz, /readyz
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Db } from '@wpp/db';
import type { Config } from '@wpp/infra';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerSimulatorRoutes } from './routes/simulator.js';
import { registerInspectorRoutes } from './routes/inspector.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSimulatorConsoleRoutes } from './routes/simulator-console.js';
import { registerSpecRoutes } from './routes/spec.js';

export interface AppDeps {
  db: Db;
  config: Config;
  logger: Logger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // The logger is injected; the instance is typed as the default FastifyInstance so
  // route modules do not need to thread the pino generic through every signature.
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  }) as unknown as FastifyInstance;

  // Raw body is required for HMAC signature verification, so application/json is
  // parsed manually and the raw buffer kept on the request (docs/07 §3).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    (req as { rawBody?: Buffer }).rawBody = raw;
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const err = (error ?? {}) as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode ?? 500;
    const code = err.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    void reply.status(status).send({ ok: false, error: { code, message: err.message ?? 'unexpected error' } });
  });

  await registerHealthRoutes(app, deps);
  await registerWebhookRoutes(app, deps);
  await registerSimulatorRoutes(app, deps);
  await registerInspectorRoutes(app, deps);
  await registerSpecRoutes(app, deps);
  await registerSimulatorConsoleRoutes(app, deps);

  return app;
}

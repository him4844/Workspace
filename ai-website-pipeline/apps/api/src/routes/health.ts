import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';

export async function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, data: { status: 'alive' } }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      const migrations = await deps.db.execute(sql`SELECT count(*)::int AS n FROM schema_migrations`);
      const n = (Array.isArray(migrations) ? migrations : ((migrations as { rows?: unknown[] }).rows ?? [])) as Array<{ n: number }>;
      return reply.send({ ok: true, data: { status: 'ready', migrations: n[0]?.n ?? 0 } });
    } catch (err) {
      return reply.status(503).send({
        ok: false,
        error: { code: 'NOT_READY', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
}

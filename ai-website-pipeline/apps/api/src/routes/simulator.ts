/**
 * Dev-only simulator channel (docs/08 §8, D-013). Disabled unless CHANNEL_SIMULATOR_ENABLED.
 * It builds an Instagram-shaped payload and pushes it through the SAME parsing + ingestion
 * path as real webhooks, so tests exercise production code rather than a parallel mock.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { schema, queueRepo, identityRepo } from '@wpp/db';
import { getConnectionForChannel, getDefaultOrgId, turnJobType, turnJobTypeByState } from '../services/context.js';
import type { AppDeps } from '../app.js';

const InboundSchema = z.object({
  senderId: z.string().min(1),
  text: z.string().min(1).max(1000),
  username: z.string().optional(),
  mid: z.string().optional(),
  at: z.string().datetime().optional(),
});

export async function registerSimulatorRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  // Auth lives in apps/api/src/auth.ts: one root-level guard registers the /api/v1 token check
  // (constant-time) and the /dev/simulator flag + loopback check for the whole app.

  /** Inject a client DM as if it came from Instagram. */
  app.post('/dev/simulator/inbound', async (request, reply) => {
    const parsed = InboundSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: parsed.error.message } });
    }
    const orgId = await getDefaultOrgId(db);
    const connection = await getConnectionForChannel(db, 'SIMULATOR');
    const payload = buildSimulatorPayload({
      accountId: connection.id,
      senderId: parsed.data.senderId,
      username: parsed.data.username,
      text: parsed.data.text,
      mid: parsed.data.mid,
      at: parsed.data.at ? new Date(parsed.data.at) : undefined,
    });
    const events = parseInstagramWebhook(payload as never);
    if (events.length === 0) {
      return reply.status(500).send({ ok: false, error: { code: 'PARSE_FAILED', message: 'simulator payload did not parse' } });
    }
    const result = await ingestInboundEvent(db, {
      orgId,
      connectionId: connection.id,
      channel: 'SIMULATOR',
      event: events[0]!,
      turnJobType: turnJobType(config),
      turnJobTypeByState: turnJobTypeByState(config),
    });
    return reply.send({ ok: true, data: result });
  });

  /** The simulator outbox = outbound messages persisted by the platform. */
  app.get('/dev/simulator/outbox', async (request, reply) => {
    const q = request.query as { conversationId?: string };
    const condition = q.conversationId
      ? and(eq(schema.messages.direction, 'OUTBOUND'), eq(schema.messages.conversationId, q.conversationId))
      : eq(schema.messages.direction, 'OUTBOUND');
    const rows = await db
      .select({
        id: schema.messages.id,
        conversationId: schema.messages.conversationId,
        status: schema.messages.status,
        text: schema.messages.text,
        sentAt: schema.messages.sentAt,
        errorCode: schema.messages.errorCode,
      })
      .from(schema.messages)
      .where(condition)
      .orderBy(asc(schema.messages.createdAt))
      .limit(200);
    return reply.send({ ok: true, data: { count: rows.length, messages: rows } });
  });

  app.get('/dev/simulator/stats', async (_request, reply) => {
    const [jobs, conversations, pending] = await Promise.all([
      queueRepo.jobStats(db),
      identityRepo.conversationOverview(db, { limit: 20 }),
      db.execute(sql`SELECT count(*)::int AS n FROM messages WHERE direction = 'OUTBOUND' AND status = 'QUEUED'`),
    ]);
    const pendingRows = (Array.isArray(pending) ? pending : ((pending as { rows?: unknown[] }).rows ?? [])) as Array<{ n: number }>;
    return reply.send({ ok: true, data: { jobs, conversations, pendingOutbound: pendingRows[0]?.n ?? 0, llm: config.LLM_PROVIDER } });
  });
}

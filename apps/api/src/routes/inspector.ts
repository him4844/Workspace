/**
 * Minimal inspection API — the COMMON_RULES requirement that every phase's result
 * be inspectable by a human before the Team Panel (Phase 7) exists.
 * Auth: X-Internal-Token header (real sessions + RBAC arrive in Phase 7).
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import {
  getConversation, getProject, identityRepo, listMessages, listOpenTasks,
  listProjects, listTransitions, obsRepo, queueRepo, schema,
} from '@wpp/db';
import { hoursUntilExpiry } from '@wpp/core';
import type { AppDeps } from '../app.js';

export async function registerInspectorRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1')) return;
    const token = request.headers['x-internal-token'];
    if (token !== config.INTERNAL_API_TOKEN) {
      return reply.status(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'X-Internal-Token required' } });
    }
  });

  app.get('/api/v1/projects', async (_request, reply) => {
    const rows = await listProjects(db, { limit: 100 });
    return reply.send({
      ok: true,
      data: rows.map((p) => ({
        id: p.id, name: p.name, state: p.state, type: p.projectType,
        clientId: p.clientId, conversationId: p.conversationId,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
      })),
    });
  });

  app.get('/api/v1/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(db, id);
    if (!project) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } });
    const [transitions, timeline, tasks] = await Promise.all([
      listTransitions(db, id),
      obsRepo.listEvents(db, id, 100),
      listOpenTasks(db, id),
    ]);
    const conversation = project.conversationId ? await getConversation(db, project.conversationId) : null;
    return reply.send({
      ok: true,
      data: {
        project,
        conversation,
        window: conversation
          ? {
              lastClientMessageAt: conversation.lastClientMessageAt,
              windowExpiresAt: conversation.windowExpiresAt,
              hoursLeft: hoursUntilExpiry(conversation.windowExpiresAt),
            }
          : null,
        transitions,
        timeline,
        openTasks: tasks.filter((t) => t.status === 'OPEN'),
      },
    });
  });

  app.get('/api/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await getConversation(db, id);
    if (!conversation) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'conversation not found' } });
    const messages = await listMessages(db, id, { limit: 200 });
    return reply.send({ ok: true, data: { conversation, messages } });
  });

  app.get('/api/v1/agent-runs', async (request, reply) => {
    const q = request.query as { projectId?: string };
    const runs = await obsRepo.listAgentRuns(db, { projectId: q.projectId, limit: 100 });
    return reply.send({ ok: true, data: runs });
  });

  app.get('/api/v1/jobs', async (request, reply) => {
    const q = request.query as { status?: string };
    const [jobs, stats] = await Promise.all([queueRepo.listJobs(db, { status: q.status, limit: 100 }), queueRepo.jobStats(db)]);
    return reply.send({ ok: true, data: { stats, jobs } });
  });

  /**
   * Internal send endpoint for the team. Phase 7 puts sessions + RBAC in front of it;
   * until then X-Internal-Token is the gate. Sending is queued, then the worker
   * applies the messaging-window guard before it reaches the channel.
   */
  app.post('/api/v1/conversations/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { text?: string; humanAuthored?: boolean };
    if (!body?.text) return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: 'text is required' } });
    const conversation = await getConversation(db, id);
    if (!conversation) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'conversation not found' } });

    const { message } = await identityRepo.insertMessage(db, {
      conversationId: id,
      projectId: null,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      text: body.text.slice(0, 1000),
      humanAuthored: body.humanAuthored ?? true,
    });
    const { job } = await queueRepo.enqueueJob(db, {
      orgId: conversation.orgId,
      type: 'SEND_OUTBOUND',
      projectId: null,
      payload: { messageId: message.id, conversationId: id },
      idempotencyKey: `send:${message.id}`,
    });
    return reply.send({ ok: true, data: { messageId: message.id, jobId: job.id } });
  });

  app.get('/api/v1/messages', async (request, reply) => {
    const q = request.query as { conversationId?: string };
    if (!q.conversationId) return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: 'conversationId required' } });
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, q.conversationId))
      .orderBy(asc(schema.messages.createdAt));
    return reply.send({ ok: true, data: rows });
  });
}

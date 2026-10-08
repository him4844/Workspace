/**
 * Instagram webhook endpoint (SPEC §31, §31A, §41; docs/07 §3).
 *   GET  → Meta verification handshake (hub.mode/hub.challenge/hub.verify_token)
 *   POST → signed event delivery; verifies X-Hub-Signature-256 over the RAW body,
 *          dedupes, normalises, persists and enqueues — then acks fast.
 */
import type { FastifyInstance } from 'fastify';
import { channelsRepo, obsRepo } from '@wpp/db';
import { ingestInboundEvent, parseInstagramWebhook, verifyHandshake, verifySignature } from '@wpp/channels';
import type { AppDeps } from '../app.js';
import { getDefaultOrgId, getConnectionForChannel, turnJobType } from '../services/context.js';

export async function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  app.get('/webhooks/instagram', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const result = verifyHandshake(
      { 'hub.mode': q['hub.mode'], 'hub.challenge': q['hub.challenge'], 'hub.verify_token': q['hub.verify_token'] },
      config.IG_VERIFY_TOKEN,
    );
    if (!result.ok) {
      request.log.warn({ query: q }, 'webhook verification handshake rejected');
      return reply.status(403).send({ ok: false, error: { code: 'VERIFY_FAILED', message: 'verification failed' } });
    }
    return reply.status(200).type('text/plain').send(result.challenge);
  });

  app.post('/webhooks/instagram', async (request, reply) => {
    const rawBody = (request as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    const signature = request.headers['x-hub-signature-256'] as string | undefined;

    if (config.WEBHOOK_REQUIRE_SIGNATURE) {
      const valid = verifySignature({ rawBody, header: signature, appSecret: config.IG_APP_SECRET });
      if (!valid) {
        const orgId = await getDefaultOrgId(db);
        await obsRepo.recordEvent(db, {
          orgId,
          type: 'SECURITY_ALERT',
          severity: 'CRITICAL',
          payload: { reason: 'invalid webhook signature', hasHeader: Boolean(signature) },
        });
        return reply.status(403).send({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'signature verification failed' } });
      }
    }

    const payload = request.body as { object?: string; entry?: Array<{ id?: string; time?: number; messaging?: Array<{ message?: { mid?: string }; sender?: { id?: string } }> }> };
    const orgId = await getDefaultOrgId(db);

    // One webhook POST may contain several entries; each is deduped on its own id.
    const eventIds = collectEventIds(payload);
    const seenEventIds = new Set<string>();
    let processed = 0;
    let duplicates = 0;

    for (const eventId of eventIds) {
      const rec = await channelsRepo.recordWebhookEvent(db, {
        channel: 'INSTAGRAM',
        externalEventId: eventId,
        signatureValid: config.WEBHOOK_REQUIRE_SIGNATURE ? true : false,
        payload,
      });
      if (rec.duplicate) {
        duplicates += 1;
        seenEventIds.add(eventId);
        await obsRepo.recordEvent(db, { orgId, type: 'WEBHOOK_DUPLICATE', payload: { eventId } });
        continue;
      }
      await obsRepo.recordEvent(db, { orgId, type: 'WEBHOOK_RECEIVED', payload: { eventId } });
    }

    // Only events that were not already seen are ingested; a replayed delivery must not
    // re-enter the conversation engine at all (SPEC §41 — at-least-once delivery).
    const events = parseInstagramWebhook(payload as never);
    const connection = await getConnectionForChannel(db, 'INSTAGRAM');

    for (const event of events) {
      if (seenEventIds.has(event.externalEventId)) continue;
      // Message-level unique index makes this safe even if two events carry the same mid (§41).
      const result = await ingestInboundEvent(db, {
        orgId,
        connectionId: connection.id,
        channel: 'INSTAGRAM',
        event,
        turnJobType: turnJobType(config),
      });
      if (result.duplicate) duplicates += 1;
      else processed += 1;
    }

    return reply.status(200).send({ ok: true, data: { processed, duplicates } });
  });
}

function collectEventIds(payload: { entry?: Array<{ messaging?: Array<{ message?: { mid?: string } }> }> }): string[] {
  const ids: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const item of entry.messaging ?? []) {
      const mid = item.message?.mid;
      if (mid) ids.push(mid);
    }
  }
  // Events without a mid (postbacks/reactions) are deduped by the message-level unique index instead.
  return ids.length > 0 ? ids : [`batch_${Date.now()}_${Math.random().toString(36).slice(2)}`];
}

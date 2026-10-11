import { and, eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { channelConnections, webhookEvents } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import type { ChannelType } from '@wpp/core';

/** Returns the connection, or null when no connection exists for the channel yet. */
export async function getActiveConnection(ex: Executor, channel: ChannelType) {
  const rows = await ex
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.channel, channel), eq(channelConnections.status, 'ACTIVE')))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureConnection(
  ex: Executor,
  params: {
    orgId: string;
    channel: ChannelType;
    externalAccountId?: string | null;
    displayName?: string | null;
    accessTokenEnc?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string[];
  },
) {
  const existing = await getActiveConnection(ex, params.channel);
  if (existing) return existing;
  const id = uuidv7();
  await ex.insert(channelConnections).values({
    id,
    orgId: params.orgId,
    channel: params.channel,
    externalAccountId: params.externalAccountId ?? null,
    displayName: params.displayName ?? null,
    accessTokenEnc: params.accessTokenEnc ?? null,
    tokenExpiresAt: params.tokenExpiresAt ?? null,
    scopes: params.scopes ?? [],
  });
  const created = await ex.select().from(channelConnections).where(eq(channelConnections.id, id)).limit(1);
  return created[0]!;
}

export async function getConnectionById(ex: Executor, id: string) {
  const rows = await ex.select().from(channelConnections).where(eq(channelConnections.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listConnections(ex: Executor) {
  return ex.select().from(channelConnections);
}

/**
 * Idempotent webhook inbox (SPEC §41). Returns { duplicate: true } when this event
 * was already received, without touching anything else.
 */
export async function recordWebhookEvent(
  ex: Executor,
  params: { channel: ChannelType; externalEventId: string; signatureValid: boolean; payload: unknown },
): Promise<{ duplicate: boolean; id: string }> {
  const id = uuidv7();
  const inserted = await ex
    .insert(webhookEvents)
    .values({
      id,
      channel: params.channel,
      externalEventId: params.externalEventId,
      signatureValid: params.signatureValid,
      payload: params.payload as object,
    })
    .onConflictDoNothing({ target: [webhookEvents.channel, webhookEvents.externalEventId] })
    .returning({ id: webhookEvents.id });
  if (inserted.length === 0) return { duplicate: true, id: '' };
  return { duplicate: false, id };
}

export async function markWebhookProcessed(ex: Executor, id: string, error?: string): Promise<void> {
  await ex
    .update(webhookEvents)
    .set({ processedAt: new Date(), processingError: error ?? null })
    .where(eq(webhookEvents.id, id));
}

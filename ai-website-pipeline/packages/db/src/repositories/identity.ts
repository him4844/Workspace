import { and, asc, count, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { clientIdentities, clients, conversationState, conversations, messages } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import type { ChannelType, MessageDirection, MessageStatus } from '@wpp/core';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type ClientIdentityRow = typeof clientIdentities.$inferSelect;

// ---------------------------------------------------------------- clients

export async function findIdentity(ex: Executor, channel: ChannelType, externalId: string) {
  const rows = await ex
    .select()
    .from(clientIdentities)
    .where(and(eq(clientIdentities.channel, channel), eq(clientIdentities.externalId, externalId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getClient(ex: Executor, id: string) {
  const rows = await ex.select().from(clients).where(eq(clients.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the client behind a channel identity, creating both on first contact.
 * Two different external ids can never resolve to the same conversation (SPEC §32).
 */
export async function resolveClientByIdentity(
  ex: Executor,
  params: { orgId: string; channel: ChannelType; externalId: string; username?: string | null; displayName?: string | null },
): Promise<{ client: ClientRow; identity: ClientIdentityRow; created: boolean }> {
  const existing = await findIdentity(ex, params.channel, params.externalId);
  if (existing) {
    const client = await getClient(ex, existing.clientId);
    return { client: client!, identity: existing, created: false };
  }

  const clientId = uuidv7();
  await ex.insert(clients).values({
    id: clientId,
    orgId: params.orgId,
    displayName: params.displayName ?? params.username ?? params.externalId,
  });

  const identityId = uuidv7();
  const inserted = await ex
    .insert(clientIdentities)
    .values({
      id: identityId,
      clientId,
      channel: params.channel,
      externalId: params.externalId,
      username: params.username ?? null,
      displayName: params.displayName ?? null,
    })
    .onConflictDoNothing({ target: [clientIdentities.channel, clientIdentities.externalId] })
    .returning();

  const identity = inserted[0] ?? (await findIdentity(ex, params.channel, params.externalId))!;
  const client = await getClient(ex, identity.clientId);
  return { client: client!, identity, created: true };
}

// ---------------------------------------------------------------- conversations

export async function findOrCreateConversation(
  ex: Executor,
  params: { orgId: string; clientId: string; connectionId: string; channel: ChannelType; externalThreadId: string },
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const found = await ex
    .select()
    .from(conversations)
    .where(and(eq(conversations.connectionId, params.connectionId), eq(conversations.externalThreadId, params.externalThreadId)))
    .limit(1);
  if (found.length > 0) return { conversation: found[0]!, created: false };

  const id = uuidv7();
  const inserted = await ex
    .insert(conversations)
    .values({
      id,
      orgId: params.orgId,
      clientId: params.clientId,
      connectionId: params.connectionId,
      channel: params.channel,
      externalThreadId: params.externalThreadId,
    })
    .onConflictDoNothing({ target: [conversations.connectionId, conversations.externalThreadId] })
    .returning();

  if (inserted.length > 0) {
    await ex.insert(conversationState).values({ conversationId: inserted[0]!.id }).onConflictDoNothing();
    return { conversation: inserted[0]!, created: true };
  }
  const again = await ex
    .select()
    .from(conversations)
    .where(and(eq(conversations.connectionId, params.connectionId), eq(conversations.externalThreadId, params.externalThreadId)))
    .limit(1);
  return { conversation: again[0]!, created: false };
}

export async function getConversation(ex: Executor, id: string) {
  const rows = await ex.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listConversations(ex: Executor, opts: { limit?: number } = {}) {
  return ex.select().from(conversations).orderBy(desc(conversations.createdAt)).limit(opts.limit ?? 50);
}

/**
 * Track the client's last message (SPEC §31A: needed for the 24h window warning).
 * windowExpiresAt is computed by the caller (pure window math from @wpp/core).
 */
export async function touchInbound(ex: Executor, conversationId: string, at: Date, windowExpiresAt: Date): Promise<void> {
  await ex
    .update(conversations)
    .set({ lastClientMessageAt: at, windowExpiresAt, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export async function touchOutbound(ex: Executor, conversationId: string, at: Date): Promise<void> {
  await ex
    .update(conversations)
    .set({ lastBusinessMessageAt: at, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// ---------------------------------------------------------------- messages

export interface InsertMessageInput {
  conversationId: string;
  projectId?: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  channelMessageId?: string | null;
  clientIdentityId?: string | null;
  text?: string | null;
  attachments?: unknown[];
  quickReplyPayload?: string | null;
  agentRunId?: string | null;
  draft?: boolean;
  humanAuthored?: boolean;
  sentAt?: Date | null;
  receivedAt?: Date | null;
  errorCode?: string | null;
  errorDetail?: string | null;
}

/** Idempotent inbound insert: a duplicate (conversation_id, channel_message_id) is a no-op (§41). */
export async function insertMessage(
  ex: Executor,
  input: InsertMessageInput,
): Promise<{ message: MessageRow; duplicate: boolean }> {
  const id = uuidv7();
  const inserted = await ex
    .insert(messages)
    .values({
      id,
      conversationId: input.conversationId,
      projectId: input.projectId ?? null,
      direction: input.direction,
      status: input.status,
      channelMessageId: input.channelMessageId ?? null,
      clientIdentityId: input.clientIdentityId ?? null,
      text: input.text ?? null,
      attachments: (input.attachments ?? []) as object[],
      quickReplyPayload: input.quickReplyPayload ?? null,
      agentRunId: input.agentRunId ?? null,
      draft: input.draft ?? false,
      humanAuthored: input.humanAuthored ?? false,
      sentAt: input.sentAt ?? null,
      receivedAt: input.receivedAt ?? null,
      errorCode: input.errorCode ?? null,
      errorDetail: input.errorDetail ?? null,
    })
    .onConflictDoNothing({ target: [messages.conversationId, messages.channelMessageId] })
    .returning();

  if (inserted.length > 0) return { message: inserted[0]!, duplicate: false };

  const existing = await ex
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, input.conversationId), eq(messages.channelMessageId, input.channelMessageId!)))
    .limit(1);
  return { message: existing[0]!, duplicate: true };
}

export async function getMessage(ex: Executor, id: string) {
  const rows = await ex.select().from(messages).where(eq(messages.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listMessages(ex: Executor, conversationId: string, opts: { limit?: number } = {}) {
  return ex
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(opts.limit ?? 200);
}

/**
 * The most recent `limit` messages of a conversation, oldest first.
 *
 * `listMessages` deliberately pages from the beginning (audit/panel use); every *runtime*
 * decision (which turn are we in, what did the client just say, are we waiting for an answer)
 * must look at the newest messages, not at the first 40 ever exchanged (Phase 2 fix).
 */
export async function listRecentMessages(ex: Executor, conversationId: string, limit = 40) {
  const rows = await ex
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function markMessageSent(ex: Executor, id: string, channelMessageId?: string | null, at = new Date()): Promise<void> {
  await ex
    .update(messages)
    .set({ status: 'SENT', sentAt: at, channelMessageId: channelMessageId ?? undefined, errorCode: null, errorDetail: null })
    .where(eq(messages.id, id));
}

export async function markMessageFailed(ex: Executor, id: string, code: string, detail: string): Promise<void> {
  await ex.update(messages).set({ status: 'FAILED', errorCode: code, errorDetail: detail }).where(eq(messages.id, id));
}

export async function markMessageSendBlocked(ex: Executor, id: string, reason: string): Promise<void> {
  await ex
    .update(messages)
    .set({ status: 'SEND_BLOCKED', errorCode: 'WINDOW_CLOSED', errorDetail: reason })
    .where(eq(messages.id, id));
}

export async function pendingOutbound(ex: Executor, conversationId?: string) {
  const where = conversationId
    ? and(eq(messages.direction, 'OUTBOUND'), eq(messages.status, 'QUEUED'), eq(messages.conversationId, conversationId))
    : and(eq(messages.direction, 'OUTBOUND'), eq(messages.status, 'QUEUED'));
  return ex.select().from(messages).where(where).orderBy(asc(messages.createdAt));
}

/** The "minimal inspection" view required by COMMON_RULES before the Team Panel exists. */
export async function conversationOverview(ex: Executor, opts: { limit?: number } = {}) {
  const rows = await ex
    .select({
      conversationId: conversations.id,
      clientId: conversations.clientId,
      channel: conversations.channel,
      externalThreadId: conversations.externalThreadId,
      lastClientMessageAt: conversations.lastClientMessageAt,
      windowExpiresAt: conversations.windowExpiresAt,
      // Counting through a join keeps the projection honest (a correlated subquery over the
      // aliased table is not portable across drivers) — docs/14 §7 expects real numbers here.
      messageCount: count(messages.id),
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.createdAt))
    .limit(opts.limit ?? 50);
  return rows;
}

export { inArray, isNull, ne, or };

/** Attach an inbound message to its project after the project record exists. */
export async function attachMessageToProject(ex: Executor, messageId: string, projectId: string): Promise<void> {
  await ex.update(messages).set({ projectId }).where(eq(messages.id, messageId));
}

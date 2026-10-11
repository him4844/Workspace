/**
 * Outbound send pipeline (SPEC §31A, §41; docs/08 §4-§5).
 *
 * Every outbound message follows the same path regardless of who created it
 * (echo placeholder, future Requirements Agent, or a human in the panel):
 *   window guard → adapter send → status/audit update → human fallback task when blocked.
 */
import type { Db } from '@wpp/db';
import {
  attachMessageToProject, consumeSendRateLimit, findOpenProjectForConversation, getConnectionById, getConversation,
  getMessage, identityRepo, markMessageFailed, markMessageSent, markMessageSendBlocked, obsRepo, queueRepo,
} from '@wpp/db';
import { decryptSecret, type Config, type Logger } from '@wpp/infra';
import { decideSend, WppError } from '@wpp/core';
import { sendInstagramMessage, simulatorAdapter } from '@wpp/channels';

export interface OutboundDeps {
  db: Db;
  config: Config;
  logger: Logger;
}

export type OutboundOutcome =
  | { status: 'SENT'; channelMessageId: string | null }
  | { status: 'SEND_BLOCKED'; reason: string }
  | { status: 'FAILED'; code: string; detail: string; retryable: boolean }
  | { status: 'RATE_LIMITED'; retryAfterMs: number }
  | { status: 'SKIPPED'; reason: string };

export async function sendOutboundMessage(deps: OutboundDeps, messageId: string, opts: { jobId?: string } = {}): Promise<OutboundOutcome> {
  const { db, config, logger } = deps;
  const message = await getMessage(db, messageId);
  if (!message) return { status: 'SKIPPED', reason: 'message not found' };
  if (message.direction !== 'OUTBOUND') return { status: 'SKIPPED', reason: 'not an outbound message' };
  if (message.status === 'SENT' || message.status === 'DELIVERED' || message.status === 'READ') {
    return { status: 'SKIPPED', reason: `already ${message.status}` };
  }

  const conversation = await getConversation(db, message.conversationId);
  if (!conversation) return { status: 'SKIPPED', reason: 'conversation not found' };

  // A human may compose a message without naming a project; the open project of the
  // conversation is the right owner, and attaching it keeps the project timeline complete.
  let projectId = message.projectId;
  if (!projectId) {
    const project = await findOpenProjectForConversation(db, conversation.id);
    if (project) {
      projectId = project.id;
      await attachMessageToProject(db, messageId, project.id);
    }
  }

  const decision = decideSend({
    windowExpiresAt: conversation.windowExpiresAt,
    lastClientMessageAt: conversation.lastClientMessageAt,
    humanAuthored: message.humanAuthored,
    humanAgentEnabled: config.HUMAN_AGENT_TAG_ENABLED,
  });

  if (!decision.allowed) {
    await markMessageSendBlocked(db, messageId, decision.message);
    await obsRepo.recordEvent(db, {
      orgId: conversation.orgId,
      projectId,
      type: 'MESSAGE_SEND_BLOCKED',
      actorType: 'SYSTEM',
      severity: 'MAJOR',
      payload: { messageId, windowExpiresAt: conversation.windowExpiresAt },
    });
    // §31A design consequence: a blocked send is never silent — a human gets a task.
    await obsRepo.createTask(db, {
      orgId: conversation.orgId,
      projectId,
      type: 'MANUAL_SEND',
      title: 'Messaging window closed — contact the client another way',
      reason: decision.message,
      description: `Draft not sent: "${(message.text ?? '').slice(0, 160)}"`,
      suggestedAction: 'Wait for a new client message, use the human_agent path if eligible, or contact the client by another channel.',
      priority: 'MAJOR',
    });
    logger.warn({ messageId, windowExpiresAt: conversation.windowExpiresAt }, 'send blocked: window closed');
    return { status: 'SEND_BLOCKED', reason: decision.message };
  }

  const connection = await getConnectionById(db, conversation.connectionId);
  if (!connection) return { status: 'FAILED', code: 'NO_CONNECTION', detail: 'conversation has no channel connection', retryable: false };

  // §31A: real Instagram sends are paced per connection. The durable fixed-window counter is
  // shared by concurrent workers; a rate-limited message stays QUEUED and resumes at the provider
  // window instead of failing or silently disappearing. Simulator sends intentionally bypass it.
  if (connection.channel === 'INSTAGRAM') {
    const rate = await consumeSendRateLimit(db, connection.id, config.SEND_RATE_PER_MINUTE);
    if (!rate.allowed) {
      if (opts.jobId) {
        throw new WppError(
          'SEND_RATE_LIMITED',
          `Instagram send rate limit reached; retry after ${rate.retryAfterMs}ms`,
          'RETRYABLE', undefined, rate.retryAfterMs,
        );
      }
      const runAt = new Date(Date.now() + rate.retryAfterMs + 1_000);
      await queueRepo.enqueueJob(db, {
        orgId: conversation.orgId,
        projectId,
        type: 'SEND_OUTBOUND',
        payload: { messageId, conversationId: conversation.id },
        idempotencyKey: `send-rate-limit:${messageId}`,
        runAt,
      });
      logger.warn({ messageId, connectionId: connection.id, retryAfterMs: rate.retryAfterMs, runAt }, 'Instagram send queued behind per-connection rate limit');
      return { status: 'RATE_LIMITED', retryAfterMs: rate.retryAfterMs };
    }
  }

  let result: { ok: boolean; channelMessageId?: string | null; errorCode?: string; errorDetail?: string; blocked?: boolean };

  if (connection.channel === 'SIMULATOR') {
    result = await simulatorAdapter.send(connection.id, { recipientExternalId: conversation.externalThreadId ?? '', text: message.text ?? '' });
  } else if (connection.channel === 'INSTAGRAM') {
    const token = connection.accessTokenEnc
      ? decryptSecret(connection.accessTokenEnc, config.TOKEN_ENCRYPTION_KEY)
      : null;
    result = await sendInstagramMessage(
      {
        baseUrl: config.IG_GRAPH_BASE,
        accessToken: token,
        accountId: connection.externalAccountId ?? config.IG_BUSINESS_ACCOUNT_ID ?? 'me',
        humanAgentTagEnabled: config.HUMAN_AGENT_TAG_ENABLED,
      },
      { recipientExternalId: conversation.externalThreadId ?? '' },
      { recipientExternalId: conversation.externalThreadId ?? '', text: message.text ?? '', humanAuthored: message.humanAuthored },
      { useHumanAgentTag: decision.mode === 'HUMAN_AGENT' },
    );
  } else {
    return { status: 'FAILED', code: 'UNSUPPORTED_CHANNEL', detail: `channel ${connection.channel} not implemented in Phase 1`, retryable: false };
  }

  if (result.ok) {
    await markMessageSent(db, messageId, result.channelMessageId ?? null);
    await identityRepo.touchOutbound(db, conversation.id, new Date());
    await obsRepo.recordEvent(db, {
      orgId: conversation.orgId,
      projectId: message.projectId,
      type: 'MESSAGE_OUTBOUND',
      actorType: message.humanAuthored ? 'HUMAN' : 'SYSTEM',
      payload: { messageId, mode: decision.mode, channelMessageId: result.channelMessageId ?? null },
    });
    return { status: 'SENT', channelMessageId: result.channelMessageId ?? null };
  }

  if (result.blocked) {
    await markMessageSendBlocked(db, messageId, result.errorDetail ?? 'blocked by channel');
    await obsRepo.createTask(db, {
      orgId: conversation.orgId,
      projectId,
      type: 'MANUAL_SEND',
      title: `Channel blocked the message (${result.errorCode})`,
      reason: result.errorDetail ?? 'platform rule',
      priority: 'MAJOR',
    });
    return { status: 'SEND_BLOCKED', reason: result.errorDetail ?? 'blocked by channel' };
  }

  await markMessageFailed(db, messageId, result.errorCode ?? 'UNKNOWN', result.errorDetail ?? '');
  return { status: 'FAILED', code: result.errorCode ?? 'UNKNOWN', detail: result.errorDetail ?? '', retryable: true };
}

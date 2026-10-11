/**
 * Instagram webhook payload → channel-independent ConversationEvents.
 * Payload shape per Meta docs (entry[].messaging[] for Instagram Login).
 * Defensive: malformed entries are skipped, never crash the webhook path.
 */
import type { ConversationEvent } from '../events.js';

export interface InstagramWebhookPayload {
  object?: string;
  entry?: InstagramEntry[];
}

export interface InstagramEntry {
  id?: string;
  time?: number;
  messaging?: InstagramMessaging[];
}

export interface InstagramMessaging {
  sender?: { id?: string; username?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: unknown[];
    is_deleted?: boolean;
    reply_to?: { mid?: string };
  };
  postback?: { mid?: string; title?: string; payload?: string };
  reaction?: { mid?: string; action?: string; emoji?: string };
  read?: { mid?: string };
  optin?: { ref?: string };
}

let seq = 0;
function fallbackId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

/**
 * Extract events. Echo messages (messages the business sent, echoed back by Meta)
 * are ignored here: our own outbound rows are authoritative.
 */
export function parseInstagramWebhook(payload: InstagramWebhookPayload): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return events;

  for (const entry of payload.entry) {
    const recipientAccountId = entry.id ?? null;
    for (const item of entry.messaging ?? []) {
      const senderId = item.sender?.id;
      if (!senderId) continue;
      const occurredAt = new Date((item.timestamp ?? entry.time ?? Date.now() / 1000) * 1000);
      const base = {
        channel: 'INSTAGRAM' as const,
        senderExternalId: senderId,
        recipientAccountId,
        senderUsername: item.sender?.username ?? null,
        occurredAt,
      };

      if (item.message && item.message.is_echo === true) continue;

      if (item.message && item.message.is_deleted === true) continue;

      if (item.message) {
        const mid = item.message.mid ?? fallbackId('ig_mid');
        const hasText = typeof item.message.text === 'string';
        const hasAttachments = Array.isArray(item.message.attachments) && item.message.attachments.length > 0;
        events.push({
          ...base,
          externalEventId: mid,
          kind: item.message.quick_reply ? 'QUICK_REPLY' : hasText ? 'TEXT' : hasAttachments ? 'ATTACHMENT' : 'TEXT',
          text: item.message.text ?? null,
          attachments: item.message.attachments ?? [],
          quickReplyPayload: item.message.quick_reply?.payload ?? null,
        });
        continue;
      }

      if (item.postback) {
        events.push({
          ...base,
          externalEventId: item.postback.mid ?? fallbackId('ig_postback'),
          kind: 'POSTBACK',
          text: item.postback.title ?? null,
          quickReplyPayload: item.postback.payload ?? null,
        });
        continue;
      }

      if (item.reaction) {
        events.push({
          ...base,
          externalEventId: item.reaction.mid ?? fallbackId('ig_reaction'),
          kind: 'REACTION',
          text: item.reaction.emoji ?? null,
          quickReplyPayload: item.reaction.action ?? null,
        });
        continue;
      }

      if (item.read) {
        events.push({
          ...base,
          externalEventId: item.read.mid ?? fallbackId('ig_seen'),
          kind: 'SEEN',
        });
        continue;
      }

      if (item.optin) {
        events.push({
          ...base,
          externalEventId: fallbackId('ig_optin'),
          kind: 'OPTIN',
          quickReplyPayload: item.optin.ref ?? null,
        });
      }
    }
  }
  return events;
}

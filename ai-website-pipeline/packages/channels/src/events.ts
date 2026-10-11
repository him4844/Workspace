/**
 * Channel-independent conversation events (SPEC §31).
 * Agents and the conversation engine only ever see these shapes — never raw Instagram payloads.
 */
import type { ChannelType, MessageDirection } from '@wpp/core';

export type ConversationEventKind =
  | 'TEXT' | 'ATTACHMENT' | 'QUICK_REPLY' | 'POSTBACK' | 'REACTION' | 'SEEN' | 'OPTIN';

export interface ConversationEvent {
  channel: ChannelType;
  /** stable id of the inbound event, used for dedupe (Instagram `mid`, simulator `sim_*`) */
  externalEventId: string;
  /** sender's channel-scoped id (Instagram IGSID; simulator client id) */
  senderExternalId: string;
  /** recipient account id (our IG professional account; simulator connection account) */
  recipientAccountId?: string | null;
  senderUsername?: string | null;
  kind: ConversationEventKind;
  text?: string | null;
  attachments?: unknown[];
  quickReplyPayload?: string | null;
  occurredAt: Date;
  /** raw payload retained for audit (stored in webhook_events) */
  raw?: unknown;
}

export interface OutboundMessage {
  recipientExternalId: string;
  text: string;
  quickReplies?: string[];
  humanAuthored?: boolean;
}

export interface SendResult {
  ok: boolean;
  channelMessageId?: string | null;
  errorCode?: string;
  errorDetail?: string;
  /** true when the failure is a platform rule (window closed) rather than a transient error */
  blocked?: boolean;
}

export interface ChannelAdapter {
  readonly channel: ChannelType;
  send(connectionId: string, message: OutboundMessage): Promise<SendResult>;
}

export interface ConversationEventEnvelope {
  direction: MessageDirection;
}

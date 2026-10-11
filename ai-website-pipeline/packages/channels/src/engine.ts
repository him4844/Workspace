/**
 * Conversation Engine (SPEC §31, §32, §41): normalize → persist → enqueue, atomically.
 *
 * Guarantees implemented here:
 *  - two clients can never mix (identity resolution by (channel, external id));
 *  - a replayed message creates nothing (unique conversation+mid, idempotent job key);
 *  - every inbound message updates the client-message timestamp that drives the 24h window;
 *  - project creation follows the explicit state machine (T01 create, T02 → INTAKE);
 *  - event + job writes commit in the same transaction as the message (docs/01 §5).
 */
import type { Db, Executor } from '@wpp/db';
import { obsRepo, channelsRepo, identityRepo, projectsRepo, queueRepo } from '@wpp/db';
import { computeWindowExpiry, detectProjectTypeHint, type ChannelType, type JobType, type ProjectState } from '@wpp/core';
import type { ConversationEvent } from './events.js';

export interface IngestResult {
  duplicate: boolean;
  clientCreated: boolean;
  projectCreated: boolean;
  clientId: string;
  conversationId: string;
  projectId: string;
  messageId: string;
  jobId?: string;
  projectState?: string;
}

export interface IngestOptions {
  /** job to schedule for this turn; Phase 1 uses ECHO_REPLY, Phase 2 switches to REQUIREMENTS_TURN */
  turnJobType?: JobType;
  /**
   * Phase 3: the job that answers a client message depends on the project's state — during
   * CLIENT_REVIEW the client is answering the specification summary, not the questionnaire.
   */
  turnJobTypeByState?: Partial<Record<ProjectState, JobType>>;
  /** when true, no follow-up job is enqueued (used by replay/tests) */
  skipJobs?: boolean;
}

export async function ingestInboundEvent(
  db: Db,
  params: {
    orgId: string;
    connectionId: string;
    channel: ChannelType;
    event: ConversationEvent;
    /** which job answers this turn: ECHO_REPLY without an LLM, REQUIREMENTS_TURN with one (§5) */
    turnJobType?: JobType;
  /**
   * Phase 3: the job that answers a client message depends on the project's state — during
   * CLIENT_REVIEW the client is answering the specification summary, not the questionnaire.
   */
  turnJobTypeByState?: Partial<Record<ProjectState, JobType>>;
  },
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { orgId, connectionId, channel, event } = params;
  const defaultTurnJob = params.turnJobType ?? options.turnJobType ?? 'ECHO_REPLY';
  const stateJobMap = params.turnJobTypeByState ?? options.turnJobTypeByState;

  return db.transaction(async (tx: Executor) => {
    // 1. identity resolution (creates the client on first contact)
    const { client, identity, created: clientCreated } = await identityRepo.resolveClientByIdentity(tx, {
      orgId,
      channel,
      externalId: event.senderExternalId,
      username: event.senderUsername ?? null,
    });

    // 2. conversation per (connection, thread)
    const { conversation, created: conversationCreated } = await identityRepo.findOrCreateConversation(tx, {
      orgId,
      clientId: client.id,
      connectionId,
      channel,
      externalThreadId: event.senderExternalId,
    });

    // 3. message (idempotent). A duplicate event id = a replay: stop here, create nothing else.
    const { message, duplicate } = await identityRepo.insertMessage(tx, {
      conversationId: conversation.id,
      direction: 'INBOUND',
      status: 'RECEIVED',
      channelMessageId: event.externalEventId,
      clientIdentityId: identity.id,
      text: event.text ?? null,
      attachments: event.attachments ?? [],
      quickReplyPayload: event.quickReplyPayload ?? null,
      receivedAt: event.occurredAt,
    });

    if (duplicate) {
      return {
        duplicate: true,
        clientCreated: false,
        projectCreated: false,
        clientId: client.id,
        conversationId: conversation.id,
        projectId: '',
        messageId: message.id,
      };
    }

    // 4. window bookkeeping (§31A: needed for the 24h warning + send guard)
    await identityRepo.touchInbound(tx, conversation.id, event.occurredAt, computeWindowExpiry({ lastClientMessageAt: event.occurredAt }));

    // 5. project: reuse the open one, or create via the state machine
    let project = await projectsRepo.findOpenProjectForConversation(tx, conversation.id);
    let projectCreated = false;
    if (!project) {
      project = await projectsRepo.createProject(tx, {
        orgId,
        clientId: client.id,
        conversationId: conversation.id,
        name: null,
        // best effort from the first message (§7); the client's answer to `website_type.type`
        // overwrites this later through the requirements handler.
        projectType: detectProjectTypeHint(event.text),
      });
      projectCreated = true;
      // audit row for creation (T01) — self-transition kept explicit for the timeline
      await projectsRepo.applyTransition(tx, {
        projectId: project.id,
        transitionId: 'T01',
        context: {},
        actorType: 'SYSTEM',
        meta: { messageId: message.id, channel },
      });
      await obsRepo.recordEvent(tx, {
        orgId,
        projectId: project.id,
        type: 'PROJECT_CREATED',
        payload: { clientId: client.id, conversationId: conversation.id, channel },
      });
    }

    // 6. move NEW → INTAKE on the first processed inbound message (T02)
    if (project.state === 'NEW') {
      await projectsRepo.applyTransition(tx, {
        projectId: project.id,
        transitionId: 'T02',
        context: { hasInboundMessage: true },
        actorType: 'CLIENT',
        meta: { messageId: message.id },
      });
      project = (await projectsRepo.getProject(tx, project.id))!;
    }

    // 7. link the message to the project (message arrived before the project existed)
    if (message.projectId !== project.id) {
      const { attachMessageToProject } = await import('@wpp/db');
      await attachMessageToProject(tx, message.id, project.id);
    }

    await obsRepo.recordEvent(tx, {
      orgId,
      projectId: project.id,
      type: 'MESSAGE_INBOUND',
      actorType: 'CLIENT',
      actorId: identity.id,
      payload: { messageId: message.id, kind: event.kind, textLength: (event.text ?? '').length, conversationCreated },
    });

    // 8. schedule the next turn (idempotent per message)
    let jobId: string | undefined;
    if (!options.skipJobs) {
      const turnJobType = stateJobMap?.[project.state as ProjectState] ?? defaultTurnJob;
      const { job } = await queueRepo.enqueueJob(tx, {
        orgId,
        type: turnJobType,
        projectId: project.id,
        payload: { conversationId: conversation.id, messageId: message.id },
        idempotencyKey: `${turnJobType.toLowerCase()}:${message.id}`,
      });
      jobId = job.id;
    }

    return {
      duplicate: false,
      clientCreated,
      projectCreated,
      clientId: client.id,
      conversationId: conversation.id,
      projectId: project.id,
      messageId: message.id,
      jobId,
      projectState: project.state,
    };
  });
}

/**
 * Record the raw webhook before parsing: dedupe at the event level (§41).
 * Returns duplicate=true when Meta re-delivered an event we already have.
 */
export async function recordInboundWebhook(
  db: Db,
  params: { channel: ChannelType; externalEventId: string; signatureValid: boolean; payload: unknown },
): Promise<{ duplicate: boolean; id: string }> {
  return channelsRepo.recordWebhookEvent(db, params);
}

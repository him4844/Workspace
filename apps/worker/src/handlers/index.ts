/**
 * Job handlers. One per job type; the orchestrator routes by type.
 * Handlers may only touch state through repositories + the orchestrator's transition API.
 */
import type { JobRow } from '@wpp/db';
import { identityRepo, obsRepo, projectsRepo } from '@wpp/db';
import { WppError, type JobType } from '@wpp/core';
import { sendOutboundMessage } from '../services/outbound.js';
import { requirementsTurn } from './requirements.js';
import { inactivityCheck } from './inactivity.js';
import type { HandlerContext } from '../orchestrator.js';

export type JobHandler = (ctx: HandlerContext, job: JobRow) => Promise<void>;

/**
 * Phase 1 placeholder for the Requirements Agent: acknowledge the client's message.
 * Phase 2 replaces this handler with the real agent turn (question selection,
 * field updates, completeness) — the job type stays `REQUIREMENTS_TURN` from then on.
 */
const echoReply: JobHandler = async (ctx, job) => {
  const payload = job.payload as { conversationId?: string; messageId?: string };
  if (!job.projectId || !payload.conversationId || !payload.messageId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'ECHO_REPLY requires projectId, conversationId, messageId', 'VALIDATION');
  }

  // A retry must not create a second reply: the job id links the outbound message to its turn.
  const runId = await obsRepo.startAgentRun(ctx.db, {
    agentType: 'REQUIREMENTS',
    projectId: job.projectId,
    conversationId: payload.conversationId,
    jobId: job.id,
    provider: 'none',
    model: 'phase1-echo-template',
    inputSummary: { phase1Placeholder: true, inboundMessageId: payload.messageId },
  });

  try {
    const existing = await identityRepo.listRecentMessages(ctx.db, payload.conversationId, 200);
    const alreadyReplied = existing.some((m) => m.direction === 'OUTBOUND' && m.agentRunId === job.id);

    if (!alreadyReplied) {
      const { message } = await identityRepo.insertMessage(ctx.db, {
        conversationId: payload.conversationId,
        projectId: job.projectId,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        text: ctx.config.ECHO_REPLY_TEMPLATE,
        agentRunId: job.id,
      });
      await sendOutboundMessage(ctx, message.id);
    }

    await obsRepo.finishAgentRun(ctx.db, runId, { status: 'SUCCESS', nextAction: 'AWAIT_CLIENT', provider: 'none', model: 'phase1-echo-template' });
    await obsRepo.recordEvent(ctx.db, {
      orgId: job.orgId,
      projectId: job.projectId,
      type: 'AGENT_RUN_FINISHED',
      actorType: 'AI_AGENT',
      payload: { jobType: job.type, runId, placeholder: true },
    });
  } catch (err) {
    await obsRepo.finishAgentRun(ctx.db, runId, {
      status: 'FAILED',
      errorCode: err instanceof WppError ? err.code : 'INTERNAL_ERROR',
      errorDetail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};

/** Manual/queued outbound messages (team sends, drafts) — same window guard as agents. */
const sendOutbound: JobHandler = async (ctx, job) => {
  const payload = job.payload as { messageId?: string };
  if (!payload.messageId) throw new WppError('INVALID_JOB_PAYLOAD', 'SEND_OUTBOUND requires messageId', 'VALIDATION');
  const outcome = await sendOutboundMessage(ctx, payload.messageId);
  if (outcome.status === 'FAILED' && outcome.retryable) {
    throw new WppError(outcome.code, outcome.detail, 'RETRYABLE');
  }
};

/** Job types declared for later phases fail loudly instead of being silently dropped. */
const notImplemented = (phase: string): JobHandler => async (_ctx, job) => {
  throw new WppError('NOT_IMPLEMENTED_IN_PHASE', `${job.type} arrives in ${phase}`, 'HUMAN_REQUIRED');
};

export const HANDLERS: Partial<Record<JobType, JobHandler>> = {
  ECHO_REPLY: echoReply,
  SEND_OUTBOUND: sendOutbound,
  REQUIREMENTS_TURN: requirementsTurn,
  SPEC_GENERATE: notImplemented('Phase 3'),
  SPEC_REVISE: notImplemented('Phase 3'),
  SPEC_AUDIT: notImplemented('Phase 4'),
  CLIENT_INTENT_PARSE: notImplemented('Phase 3'),
  CLIENT_APPROVAL_TIMEOUT: notImplemented('Phase 3'),
  BUILD_RUN: notImplemented('Phase 5'),
  CODE_CHECK: notImplemented('Phase 6'),
  INACTIVITY_CHECK: inactivityCheck,
  TOKEN_REFRESH: notImplemented('Phase 5'),
};

export { echoReply, sendOutbound };

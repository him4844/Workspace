/**
 * CLIENT_INTENT_PARSE — the client's reply during specification review (SPEC §18, §19, §10A).
 *
 * This is the handler that runs the human-chosen TWO-STEP approval:
 *
 *   step 1  the Specification handler sent the client summary  → state CLIENT_REVIEW
 *   step 2  the client replied → we send the explicit approve/change question, and only THEN
 *           does an inbound message count as a decision.
 *
 * Safety rules that make a wrong approval structurally unlikely:
 *   - approvals are decided by keyword when the text is an unambiguous answer (no model call);
 *   - otherwise the agent classifies, and a confidence below the configured threshold becomes
 *     UNCLEAR → exactly one clarifying question, never a silent approval;
 *   - an approval is recorded only together with the exact `source_message_id` (§10A discipline),
 *     and `client_approvals.source_message_id` is unique, so a retry cannot double-approve;
 *   - the approved version is LOCKED (§19); every later change goes through a Change Request (§35);
 *   - client text that tries to instruct the agent is flagged (§38) and still treated as content.
 */
import type { JobRow } from '@wpp/db';
import { and, eq } from 'drizzle-orm';
import {
  agentConfigRepo, identityRepo, obsRepo, orgRepo, projectsRepo, queueRepo, schema, specsRepo,
} from '@wpp/db';
import { decideApproval, deriveApprovalStep, looksLikeInjectionClientSafe, WppError } from '@wpp/core';
import {
  buildIntentProjectDataSafe, buildIntentRunInput, buildIntentTaskBlock, renderApprovalRequest,
  runAgentTurn, type ClientIntent,
} from '@wpp/agents';
import { effectiveModel } from '../services/llm.js';
import type { HandlerContext } from '../orchestrator.js';
import { sendOutboundMessage } from '../services/outbound.js';

/** Safe re-export for tests: the injection heuristic used on review messages (§38). */
export const __looksLikeInjection = looksLikeInjectionClientSafe;

export async function clientIntentParse(ctx: HandlerContext, job: JobRow): Promise<void> {
  const payload = job.payload as { conversationId?: string; messageId?: string };
  if (!job.projectId || !payload.conversationId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'CLIENT_INTENT_PARSE requires projectId and conversationId', 'VALIDATION');
  }
  const { db, config, logger } = ctx;
  const projectId = job.projectId;
  const conversationId = payload.conversationId;

  const project = await projectsRepo.getProject(db, projectId);
  if (!project) throw new WppError('PROJECT_NOT_FOUND', `project ${projectId} does not exist`, 'VALIDATION');

  const version = await specsRepo.getCurrentSpecVersion(db, projectId);
  if (!version) {
    // Nothing to approve yet: the safest answer is to let the requirements pipeline continue.
    logger.warn({ projectId }, 'CLIENT_INTENT_PARSE without a spec version — falling back to the requirements turn');
    await queueRepo.enqueueJob(db, {
      orgId: project.orgId,
      type: 'REQUIREMENTS_TURN',
      projectId,
      payload: { conversationId, messageId: payload.messageId ?? null },
      idempotencyKey: `requirements-turn-fallback:${payload.messageId ?? job.id}`,
    });
    return;
  }

  const messages = await identityRepo.listRecentMessages(db, conversationId, 40);
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'INBOUND') ?? null;
  const text = (lastInbound?.text ?? '').trim();
  const step = deriveApprovalStep({
    summarySentAt: version.summarySentAt,
    approvalRequestedAt: version.approvalRequestedAt,
    decidedAt: version.status === 'LOCKED' ? version.lockedAt : null,
  });

  if (!lastInbound) return;

  const injectionSuspected = looksLikeInjectionClientSafe(text);
  if (injectionSuspected) {
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SECURITY_ALERT', actorType: 'CLIENT', severity: 'MINOR',
      payload: { messageId: lastInbound.id, jobId: job.id, handled: 'as-content', stage: 'spec-review' },
    });
  }

  // ---------------------------------------------------------------- classify
  const threshold = (await orgRepo.getConfigValue<number>(db, 'spec.approval_confidence_threshold')) ?? 0.85;
  const agentIntent = await classifyWithAgent(ctx, {
    project, projectId, conversationId, version, messages, job,
  });
  const decision = decideApproval({ text, agentIntent: agentIntent.intent, threshold });

  await obsRepo.recordEvent(db, {
    orgId: project.orgId, projectId, type: 'HUMAN_ACTION', actorType: 'CLIENT',
    payload: {
      stage: 'spec-review', step, source: decision.source,
      intent: decision.intent, confidence: decision.confidence,
      agentIntent: agentIntent.intent?.intent ?? null, messageId: lastInbound.id,
    },
  });

  // ---------------------------------------------------------------- step 1 → send the approval question
  if (step === 'AWAIT_SUMMARY_ACK' && decision.intent !== 'REQUEST_CHANGES') {
    const question = renderApprovalRequest({ approveLabel: undefined, requestChangesLabel: undefined });
    const { message } = await identityRepo.insertMessage(db, {
      conversationId, projectId, direction: 'OUTBOUND', status: 'QUEUED', text: question, agentRunId: null,
    });
    await sendOutboundMessage(ctx, message.id);
    await specsRepo.markApprovalRequested(db, version.id, message.id);
    await scheduleApprovalTimeout(ctx, { projectId, conversationId, versionId: version.id });
    logger.info({ projectId, versionId: version.id }, 'approval question sent (step 2 of two-step approval)');
    return;
  }

  // ---------------------------------------------------------------- the client asked for changes
  if (decision.intent === 'REQUEST_CHANGES') {
    const changeItems = agentIntent.intent?.changeItems ?? [];
    await specsRepo.recordClientApproval(db, {
      orgId: project.orgId,
      projectId,
      specVersionId: version.id,
      decision: 'REQUEST_CHANGES',
      sourceMessageId: lastInbound.id,
      confidence: decision.confidence,
      classification: decision.source,
      changeItems,
      rawText: text,
    });
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'APPROVAL_RECORDED', actorType: 'CLIENT',
      payload: { decision: 'REQUEST_CHANGES', specVersionId: version.id, messageId: lastInbound.id, changeItems },
    });

    await cancelApprovalTimeouts(ctx, projectId);
    const changeText = [text, ...changeItems.map((c: { description: string }) => `- ${c.description}`)].join('\n');
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId, transitionId: 'T08', context: {}, actorType: 'CLIENT',
        meta: { specVersionId: version.id, messageId: lastInbound.id },
      });
    });
    await queueRepo.enqueueJob(db, {
      orgId: project.orgId,
      type: 'SPEC_REVISE',
      projectId,
      payload: { conversationId, messageId: lastInbound.id, changeText, changeItems, specVersionId: version.id },
      idempotencyKey: `spec-revise:${version.id}:${lastInbound.id}`,
    });
    logger.info({ projectId, versionId: version.id, items: changeItems.length }, 'client requested spec changes');
    return;
  }

  // ---------------------------------------------------------------- the client approved
  if (decision.intent === 'APPROVE') {
    const approval = await specsRepo.recordClientApproval(db, {
      orgId: project.orgId,
      projectId,
      specVersionId: version.id,
      decision: 'APPROVE',
      sourceMessageId: lastInbound.id,
      confidence: decision.confidence,
      classification: decision.source,
      rawText: text,
    });

    const alreadyLocked = version.status === 'LOCKED';
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId,
        transitionId: 'T10',
        // §10A discipline for approvals too: no approval without a real client message.
        context: { hasClientApproval: Boolean(approval?.sourceMessageId) },
        actorType: 'CLIENT',
        meta: { specVersionId: version.id, messageId: lastInbound.id, approvalId: approval?.id ?? null },
      });
    });
    // §19: the approved version becomes immutable from here on.
    await specsRepo.lockSpecVersion(db, version.id, { at: new Date() });
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'APPROVAL_RECORDED', actorType: 'CLIENT',
      payload: { decision: 'APPROVE', specVersionId: version.id, version: version.version, messageId: lastInbound.id, confidence: decision.confidence },
    });
    if (!alreadyLocked) {
      await cancelApprovalTimeouts(ctx, projectId);
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SPEC_LOCKED', actorType: 'SYSTEM',
        payload: { specVersionId: version.id, version: version.version },
      });
      // §20/§21: the approval is the moment the Spec Auditor takes over (T11, JOB-triggered).
      // The approved version starts a fresh audit cycle: its revision budget is its own, so a
      // later client change request can never be blocked by an exhausted earlier loop.
      await queueRepo.enqueueJob(db, {
        orgId: project.orgId,
        type: 'SPEC_AUDIT',
        projectId,
        payload: { conversationId, specVersionId: version.id, cycleKey: version.id },
        idempotencyKey: `spec-audit:${version.id}`,
      });
      const thanks = await orgRepo.getConfigValue<string>(db, 'spec.approved_message');
      if (thanks) {
        const { message } = await identityRepo.insertMessage(db, {
          conversationId, projectId, direction: 'OUTBOUND', status: 'QUEUED', text: thanks, agentRunId: null,
        });
        await sendOutboundMessage(ctx, message.id);
      }
    }
    logger.info({ projectId, version: version.version, versionId: version.id }, 'specification approved and locked');
    return;
  }

  // ---------------------------------------------------------------- unclear → one clarifying question
  const clarifyKey = 'spec.clarify';
  const clarifications = await projectsRepo.getLoopCounter(db, projectId, 'spec', clarifyKey);
  const maxClarifications = (await orgRepo.getConfigValue<number>(db, 'spec.max_clarifications')) ?? 2;

  if (clarifications >= maxClarifications) {
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: `Client reply unclear ${clarifications}× at specification review`,
      reason: `Last message: "${text.slice(0, 200)}"`,
      suggestedAction: 'Read the conversation and decide for the client (approve or collect the changes), then continue the pipeline.',
      aiReport: { specVersionId: version.id, messageId: lastInbound.id, agentIntent },
    });
    return;
  }

  await projectsRepo.incrementLoopCounter(db, projectId, 'spec', clarifyKey);
  const clarifyText = 'Kechirasiz, to‘g‘ri tushunish uchun aniqlashtirib olsam: yuqoridagi tavsifni *tasdiqlaymizmi* yoki biror narsani *o‘zgartirish* kerakmi?';
  const { message } = await identityRepo.insertMessage(db, {
    conversationId, projectId, direction: 'OUTBOUND', status: 'QUEUED', text: clarifyText, agentRunId: null,
  });
  await sendOutboundMessage(ctx, message.id);
  logger.info({ projectId, clarifications }, 'asked the client to clarify their approval answer');
}

// ---------------------------------------------------------------- helpers

interface IntentAgentResult {
  intent: ClientIntent | null;
  runId: string | null;
}

/**
 * The agent reads the client's message with the summary context. A missing provider is NOT a
 * failure here: the keyword path already handled the common answers, and an unresolvable reply
 * simply becomes UNCLEAR (one clarifying question) — that is the safe direction.
 */
async function classifyWithAgent(
  ctx: HandlerContext,
  params: {
    project: { orgId: string; projectType: string | null };
    projectId: string;
    conversationId: string;
    version: { id: string; version: number; clientSummaryMd: string | null };
    messages: Array<{ id: string; direction: string; text: string | null; createdAt: Date | null }>;
    job: JobRow;
  },
): Promise<IntentAgentResult> {
  const { db } = ctx;
  const agentConfig = await agentConfigRepo.getActiveAgentConfig(db, params.project.orgId, 'SPECIFICATION');
  if (!agentConfig || !ctx.llm) return { intent: null, runId: null };

  const runId = await obsRepo.startAgentRun(db, {
    agentType: 'SPECIFICATION',
    projectId: params.projectId,
    conversationId: params.conversationId,
    jobId: params.job.id,
    provider: agentConfig.version.provider ?? null,
    model: effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL) ?? agentConfig.version.model,
    configVersionId: agentConfig.version.id,
    inputSummary: { task: 'client-intent', specVersion: params.version.version },
  });

  const clientMessages = params.messages.slice(-8).map((m) => ({
    id: m.direction === 'INBOUND' ? m.id : undefined,
    at: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
    text: `${m.direction === 'INBOUND' ? 'CLIENT' : 'US'}: ${m.text ?? '[attachment]'}`,
  }));

  const envelope = await runAgentTurn(
    { client: ctx.llm!, systemInstructions: agentConfig.version.systemInstructions, logger: ctx.logger },
    buildIntentRunInput({
      task: buildIntentTaskBlock(),
      projectData: buildIntentProjectDataSafe({
        specVersion: params.version.version,
        clientSummaryMd: params.version.clientSummaryMd ?? '',
      }),
      clientMessages,
      outputSchema: agentConfig.version.outputSchema,
      model: effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL) ?? agentConfig.version.model,
      maxOutputTokens: 400,
      timeoutMs: 20_000,
    }),
  );

  const usage = 'usage' in envelope ? envelope.usage : undefined;
  await obsRepo.finishAgentRun(db, runId, {
    status: envelope.status === 'SUCCESS' ? 'SUCCESS' : envelope.status,
    errorCode: envelope.status === 'FAILED' ? envelope.errorCode : null,
    errorDetail: envelope.status === 'FAILED' ? envelope.message : envelope.status === 'NEEDS_REVIEW' ? envelope.reason : null,
    provider: usage?.provider ?? null,
    model: usage?.model ?? effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL),
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    costUsd: usage?.costUsd !== undefined ? String(usage.costUsd) : null,
  });
  await obsRepo.recordEvent(db, {
    orgId: params.project.orgId, projectId: params.projectId, type: 'AGENT_RUN_FINISHED', actorType: 'AI_AGENT',
    payload: { jobType: params.job.type, runId, status: envelope.status, task: 'client-intent' },
  });
  if (usage) {
    await agentConfigRepo.recordLlmUsage(db, {
      orgId: params.project.orgId, projectId: params.projectId, agentRunId: runId,
      provider: usage.provider, model: usage.model,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd,
    });
  }
  return { intent: envelope.status === 'SUCCESS' ? envelope.output : null, runId };
}

/**
 * The round is over (approved, or changes requested): every pending reminder timer for this project
 * is obsolete. Cancel them explicitly — a timer that fires after the decision would park itself on a
 * state mismatch and clutter the queue (§21: no stray jobs, no fake activity).
 */
async function cancelApprovalTimeouts(ctx: HandlerContext, projectId: string): Promise<void> {
  const rows = await ctx.db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, 'PENDING'), eq(schema.jobs.type, 'CLIENT_APPROVAL_TIMEOUT')));
  for (const job of rows.filter((row) => row.projectId === projectId)) {
    await ctx.db
      .update(schema.jobs)
      .set({ status: 'DONE', updatedAt: new Date(), lastError: 'cancelled: the approval round is over' })
      .where(eq(schema.jobs.id, job.id));
  }
}

async function scheduleApprovalTimeout(
  ctx: HandlerContext,
  params: { projectId: string; conversationId: string; versionId: string },
): Promise<void> {
  const hours = (await orgRepo.getConfigValue<number>(ctx.db, 'spec.approval_reminder_hours')) ?? 48;
  const project = await projectsRepo.getProject(ctx.db, params.projectId);
  if (!project) return;
  await queueRepo.replacePendingJob(ctx.db, {
    orgId: project.orgId,
    type: 'CLIENT_APPROVAL_TIMEOUT',
    projectId: params.projectId,
    payload: { conversationId: params.conversationId, specVersionId: params.versionId },
    runAt: new Date(Date.now() + hours * 3600 * 1000),
    idempotencyKey: `spec-approval-timeout:${params.versionId}`,
  });
}

/**
 * CLIENT_APPROVAL_TIMEOUT — one polite reminder, then a human task (§21: bounded, never a loop).
 */
export async function clientApprovalTimeout(ctx: HandlerContext, job: JobRow): Promise<void> {
  const payload = job.payload as { conversationId?: string; specVersionId?: string };
  if (!job.projectId || !payload.conversationId || !payload.specVersionId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'CLIENT_APPROVAL_TIMEOUT requires projectId, conversationId, specVersionId', 'VALIDATION');
  }
  const { db } = ctx;
  const project = await projectsRepo.getProject(db, job.projectId);
  if (!project) return;
  const version = await specsRepo.getSpecVersion(db, payload.specVersionId);
  if (!version) return;
  // The client already decided (or approved): nothing to remind about.
  if (version.status === 'LOCKED' || version.status === 'APPROVED' || version.status === 'SUPERSEDED' || version.status === 'CHANGES_REQUESTED') return;

  const messages = await identityRepo.listRecentMessages(db, payload.conversationId, 50);
  const last = messages.at(-1);
  if (!last) return;
  if (last.direction === 'INBOUND') {
    // The client replied but the intent turn has not run yet: let the pipeline handle it.
    return;
  }

  const reminders = await projectsRepo.getLoopCounter(db, job.projectId, 'spec', 'approval_reminders');
  const maxReminders = (await orgRepo.getConfigValue<number>(db, 'spec.approval_max_reminders')) ?? 1;
  if (reminders >= maxReminders) {
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId: job.projectId, type: 'CLIENT_SILENT', priority: 'MAJOR',
      title: 'Client silent after the specification summary',
      reason: `No decision on specification v${version.version} after ${reminders} reminder(s).`,
      suggestedAction: 'Contact the client through another channel; the 24h messaging window may also be closing.',
      aiReport: { specVersionId: version.id, reminders },
    });
    return;
  }

  await projectsRepo.incrementLoopCounter(db, job.projectId, 'spec', 'approval_reminders');
  const text = 'Eslatma 🙂 Yuqorida yuborilgan qisqacha tavsif bo‘yicha javobingizni kutayapman: tasdiqlaymizmi yoki biror narsani o‘zgartiramizmi?';
  const { message } = await identityRepo.insertMessage(db, {
    conversationId: payload.conversationId, projectId: job.projectId, direction: 'OUTBOUND', status: 'QUEUED', text, agentRunId: null,
  });
  await sendOutboundMessage(ctx, message.id);
}

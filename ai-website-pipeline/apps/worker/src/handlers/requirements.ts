/**
 * REQUIREMENTS_TURN — the Requirements Agent turn (SPEC §5–§13, §38, §42, §49–§51).
 *
 * Division of labour (docs/06 §1):
 *   - packages/core decides WHICH field to ask and WHETHER requirements are complete;
 *   - packages/agents phrases the question and extracts structured values;
 *   - this handler persists everything, applies state transitions through the one
 *     orchestrator API, and schedules the next turn.
 *
 * Guards worth knowing:
 *   - the model's field updates pass through `planFieldUpdates` (§10A: client truth needs a
 *     client message; AI inference can never overwrite client truth silently);
 *   - a model that answers COMPLETE while the deterministic engine says otherwise is ignored;
 *   - if no LLM is configured the handler degrades to the Phase 1 acknowledgment instead of
 *     leaving the client unanswered.
 */
import type { JobRow } from '@wpp/db';
import {
  agentConfigRepo, createArtifact, identityRepo, obsRepo, orgRepo,
  projectsRepo, questionnairesRepo, queueRepo, requirementsRepo,
} from '@wpp/db';
import {
  computeCompleteness, mergeQuestionnaires, normaliseProjectType, planFieldUpdates, planNextQuestion,
  toFieldStates, WppError, type OpenContradiction, type QuestionPlan,
  type QuestionnaireDefinition, type RequirementFieldState, type RequirementStatus,
} from '@wpp/core';
import {
  buildProjectDataBlock, buildRequirementsRunInput, buildTaskBlock, fallbackQuestionText,
  looksLikeInjection, runAgentTurn, toClientMessage, type AgentEnvelope, type RequirementsTurn, parseReasoningEffort } from '@wpp/agents';
import { writeArtifact } from '@wpp/infra';
import { effectiveModel } from '../services/llm.js';
import { createDailyBudgetGuard } from '../services/llm-budget.js';
import type { HandlerContext } from '../orchestrator.js';
import { sendOutboundMessage } from '../services/outbound.js';

const SCOPE = 'requirements';
const CLARIFICATION_REASONS = new Set(['CLARIFY_VAGUE', 'CONTRADICTION']);

export async function requirementsTurn(ctx: HandlerContext, job: JobRow): Promise<void> {
  const payload = job.payload as { conversationId?: string; messageId?: string };
  if (!job.projectId || !payload.conversationId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'REQUIREMENTS_TURN requires projectId and conversationId', 'VALIDATION');
  }
  const { db, config, logger } = ctx;
  const conversationId = payload.conversationId;
  const projectId = job.projectId;

  const project = await projectsRepo.getProject(db, projectId);
  if (!project) throw new WppError('PROJECT_NOT_FOUND', `project ${projectId} does not exist`, 'VALIDATION');

  const conversation = await identityRepo.getConversation(db, conversationId);
  if (!conversation) throw new WppError('CONVERSATION_NOT_FOUND', `conversation ${conversationId} does not exist`, 'VALIDATION');

  // ---------------------------------------------------------------- 1. requirements version + fields
  const sources = await questionnairesRepo.loadQuestionnaireSources(db, project.projectType ?? null);
  if (!sources) {
    throw new WppError('QUESTIONNAIRE_MISSING', 'no GENERAL questionnaire seeded — run `npm run seed`', 'HUMAN_REQUIRED');
  }
  const questionnaire = mergeQuestionnaires(sources.general, sources.packages);

  let version = await requirementsRepo.getCurrentRequirementVersion(db, projectId);
  if (!version) {
    version = await requirementsRepo.createRequirementVersion(db, {
      projectId,
      questionnaireSchemaVersion: questionnaire.schemaVersion,
    });
  }
  // Fields are seeded from the merged questionnaire; when the project type becomes known
  // mid-interview the package fields are added without touching what is already answered.
  await requirementsRepo.seedFieldsFromQuestionnaire(db, version.id, questionnaire);

  const fieldRows = await requirementsRepo.listRequirementFields(db, version.id);
  const fieldStates: RequirementFieldState[] = toFieldStates(
    fieldRows.map((f) => ({
      fieldPath: f.fieldPath,
      category: f.category,
      value: f.value,
      status: f.status as RequirementStatus,
      priority: f.priority,
      mandatory: f.mandatory,
      note: f.note,
    })),
  );
  const contradictionRows = await requirementsRepo.listContradictions(db, projectId);
  const openContradictions: OpenContradiction[] = contradictionRows.map((c) => ({
    fieldA: c.fieldA,
    fieldB: c.fieldB,
    severity: (c.severity === 'CRITICAL' || c.severity === 'MAJOR' ? 'MAJOR' : 'MINOR'),
    status: c.status as OpenContradiction['status'],
  }));

  // ---------------------------------------------------------------- 2. limits and counters (config, §10)
  const maxQuestions = (await orgRepo.getConfigValue<number>(db, 'loop.requirements.max_questions')) ?? 40;
  const maxClarifications = (await orgRepo.getConfigValue<number>(db, 'loop.requirements.max_clarifications_per_field')) ?? 2;
  const questionsAsked = await projectsRepo.getLoopCounter(db, projectId, SCOPE, 'questions_asked');
  const clarificationsByField: Record<string, number> = {};
  for (const f of fieldRows) {
    const count = await projectsRepo.getLoopCounter(db, projectId, `${SCOPE}.clarify`, f.fieldPath);
    if (count > 0) clarificationsByField[f.fieldPath] = count;
  }

  const completeness = computeCompleteness({
    fields: fieldStates,
    contradictions: openContradictions,
    questionnaire,
    hasInternalSummary: Boolean(version.summaryArtifactId),
  });

  const plan = planNextQuestion({
    questionnaire,
    fields: fieldStates,
    contradictions: openContradictions,
    counters: { questionsAsked, clarificationsByField },
    limits: { maxQuestions, maxClarificationsPerField: maxClarifications },
  });

  // The prompt must name the field the model is asked to WORD, and the field this turn actually
  // SENDS is the one the engine picks AFTER the client's answer is applied (`engineStop`, §8).
  // The client's last message answers `version.pendingFieldPath`, so projecting that single field
  // as answered reproduces the post-turn plan without a second LLM call (unaffordable on the free
  // tier — see PHASE_REPORTS/evidence/phase4-prompt-sizes.txt). Until this, the prompt named the
  // PRE-turn plan while the handler sent the POST-turn one, so the two could never agree: the
  // field guard below fired on every turn of every run (24-30 times in the recorded evidence) and
  // the model's own wording was always thrown away in favour of the questionnaire text — §10's
  // "the model writes the wording, the planner owns which field" was effectively dead code.
  // If the projection is wrong (the client did not answer the pending field, or volunteered extra
  // updates that change the order) the guard still fires and the deterministic wording goes out,
  // which is the correct degradation — but now it is a signal instead of a constant.
  const pendingFieldPath = version.pendingFieldPath;
  const projectedPlan: QuestionPlan = pendingFieldPath
    ? planNextQuestion({
        questionnaire,
        fields: fieldStates.map((f) => (f.fieldPath === pendingFieldPath && (f.status === 'EMPTY' || f.status === 'UNCLEAR')
          ? { ...f, status: 'CLIENT_CONFIRMED', note: null }
          : f)),
        contradictions: openContradictions,
        counters: { questionsAsked, clarificationsByField },
        limits: { maxQuestions, maxClarificationsPerField: maxClarifications },
      })
    : plan;
  // Only an ASK projection may reach the prompt. A projected STOP would tell the model this is the
  // FINAL turn, and the final-turn contract carries `fieldUpdates: []` — so the client's answer to
  // the still-pending field would never be recorded, completeness would keep blocking on it, and
  // the interview would livelock until MAX_QUESTIONS (reproduced 2026-10-11: `deadline.expected`
  // blocked, 15 identical PREMARKED_COMPLETE_IGNORED events, 104 jobs, exit 1). Guessing "done"
  // is never safe; guessing "which question comes next" is, because the field guard catches a
  // wrong guess. Real completion is decided only by `engineSaysComplete` (§8), which then asks for
  // the internal summary in its own bounded call.
  const promptPlan: QuestionPlan = projectedPlan.kind === 'ASK' ? projectedPlan : plan;

  // ---------------------------------------------------------------- 3. agent configuration (§51)
  const agentConfig = await agentConfigRepo.getActiveAgentConfig(db, project.orgId, 'REQUIREMENTS');
  if (!agentConfig || !ctx.llm) {
    // Honest degradation: without a provider we behave like Phase 1 and say so in the log/event.
    logger.warn({ projectId, hasConfig: Boolean(agentConfig), hasClient: Boolean(ctx.llm) }, 'requirements agent unavailable — falling back to acknowledgment');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MINOR',
      payload: { code: 'REQUIREMENTS_AGENT_NOT_CONFIGURED', jobId: job.id },
    });
    await replyWithTemplate(ctx, job, conversationId, projectId);
    return;
  }

  const messages = await identityRepo.listRecentMessages(db, conversationId, 40);
  const inbound = messages.filter((m) => m.direction === 'INBOUND');
  const lastInbound = inbound.at(-1) ?? null;
  const lastMessage = messages.at(-1) ?? null;
  const injectionSuspected = lastInbound?.text ? looksLikeInjection(lastInbound.text) : false;

  // ---------------------------------------------------------------- 4. the turn itself
  const task = buildTaskBlock(promptPlan, {
    projectType: project.projectType ?? 'UNKNOWN',
    language: config.DEFAULT_LOCALE,
    counters: { questionsAsked, maxQuestions },
    openContradictions: completeness.openContradictions,
    blockingFields: completeness.blockingFields,
  });
  const pendingDefinition = version.pendingFieldPath
    ? questionnaire.fields.find((f) => f.path === version.pendingFieldPath)
    : undefined;
  const projectData = buildProjectDataBlock({
    projectId,
    projectType: project.projectType ?? 'UNKNOWN',
    fields: fieldStates,
    pendingQuestion: pendingDefinition ? { fieldPath: pendingDefinition.path, text: pendingDefinition.question } : null,
    contradictions: contradictionRows
      .filter((c) => c.status === 'OPEN' || c.status === 'CLARIFYING')
      .map((c) => ({ fieldA: c.fieldA, fieldB: c.fieldB, description: c.description, severity: c.severity, status: c.status })),
    vision: (version.vision ?? null) as never,
    counters: { questionsAsked, maxQuestions, clarificationsByField },
  });

  // §10 — minimum interval between questions: never fire two questions at the client within
  // the configured seconds. Deferring here (before the model call) costs no tokens; the
  // resume job — idempotent per outbound message — runs the whole turn the moment the
  // interval has passed, so the client is never left without an answer to their message.
  const minInterval = (await orgRepo.getConfigValue<number>(db, 'requirements.min_question_interval_seconds')) ?? 8;
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'OUTBOUND');
  const lastOutboundAt = lastOutbound?.sentAt ?? lastOutbound?.createdAt ?? null;
  // Only a turn that would actually ask something can be deferred; a COMPLETE turn is
  // handled earlier, and an "already answered" turn asks nothing.
  const wouldAsk = plan.kind === 'ASK' && lastMessage?.direction !== 'OUTBOUND';
  const resumeFrom = (job.payload as { resumeFrom?: string }).resumeFrom ?? null;
  const alreadyWaited = lastOutbound !== undefined && resumeFrom === lastOutbound.id;
  if (wouldAsk && minInterval > 0 && lastOutbound && lastOutboundAt && !alreadyWaited) {
    const ageMs = Date.now() - new Date(lastOutboundAt).getTime();
    if (ageMs < minInterval * 1000) {
      await queueRepo.enqueueJob(db, {
        orgId: job.orgId,
        type: 'REQUIREMENTS_TURN',
        projectId,
        payload: { conversationId, resumeFrom: lastOutbound.id },
        runAt: new Date(new Date(lastOutboundAt).getTime() + minInterval * 1000),
        idempotencyKey: `requirements:resume:${lastOutbound.id}`,
      });
      logger.info({ projectId, conversationId, ageMs, minInterval }, 'question deferred to respect the minimum interval');
      return;
    }
  }

  const { runId, envelope } = await runTurn(ctx, {
    job,
    orgId: project.orgId,
    agentConfig,
    task,
    projectData,
    clientMessages: mapClientMessages(messages),
    inputSummary: { turn: questionsAsked + 1, planKind: plan.kind },
  });

  if (envelope.status === 'FAILED') {
    throw new WppError(envelope.errorCode, envelope.message, envelope.retryable ? 'RETRYABLE' : 'HUMAN_REQUIRED', undefined, envelope.retryAfterMs);
  }
  if (envelope.status === 'NEEDS_REVIEW') {
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: 'Requirements agent output needs review',
      reason: envelope.reason,
      suggestedAction: 'Open the conversation, answer the client manually, then resume the agent.',
    });
    return;
  }

  const turn: RequirementsTurn = envelope.output;

  if (injectionSuspected && lastInbound) {
    // SPEC §38: treated as ordinary content; the flag exists for the team, nothing else changes.
    // Jobs are at-least-once, so the same message must not produce a second alert row.
    const recent = await obsRepo.listEvents(db, projectId, 50);
    const alreadyFlagged = recent.some(
      (e) => e.type === 'SECURITY_ALERT'
        && (e.payload as { kind?: string; messageId?: string }).kind === 'prompt_injection_suspected'
        && (e.payload as { messageId?: string }).messageId === lastInbound.id,
    );
    if (!alreadyFlagged) {
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SECURITY_ALERT', actorType: 'CLIENT', severity: 'MINOR',
        payload: { kind: 'prompt_injection_suspected', messageId: lastInbound.id, handled: 'as-content' },
      });
    }
  }

  // ---------------------------------------------------------------- 5. persist field updates (§10A)
  const validSourceIds = new Set(inbound.map((m) => m.id));
  const currentInboundMessageId = payload.messageId && validSourceIds.has(payload.messageId)
    ? payload.messageId
    : (lastInbound?.id ?? null);
  const currentState = new Map(fieldStates.map((f) => [f.fieldPath, f]));
  const choiceOptions = new Map<string, string[]>(
    questionnaire.fields
      .filter((f) => f.valueType === 'choice' && Array.isArray(f.options) && f.options.length > 0)
      .map((f) => [f.path, f.options as string[]]),
  );
  const applyPlan = planFieldUpdates(
    turn.fieldUpdates.map((u) => ({
      fieldPath: u.fieldPath,
      category: u.category,
      value: u.value,
      status: u.status,
      priority: u.priority,
      sourceMessageId: u.sourceMessageId ?? null,
      note: u.note ?? null,
    })),
    {
      current: currentState,
      knownPaths: new Set(questionnaire.fields.map((f) => f.path)),
      validSourceMessageIds: validSourceIds,
      currentInboundMessageId,
      choiceOptions,
    },
  );

  for (const update of applyPlan.accepted) {
    const definition = questionnaire.fields.find((f) => f.path === update.fieldPath);
    await requirementsRepo.upsertRequirementField(db, version.id, {
      fieldPath: update.fieldPath,
      category: update.category ?? definition?.category ?? 'dynamic',
      value: update.value,
      status: update.status,
      priority: update.priority ?? definition?.priority ?? (definition?.mandatory ? 'MUST' : 'NICE_TO_HAVE'),
      sourceMessageId: update.sourceMessageId ?? null,
      sourceRunId: runId,
      note: update.note ?? null,
      reason: update.downgrade ? 'agent downgrade (note present)' : `agent turn ${questionsAsked + 1}`,
    });
  }
  // §10 (live finding 2026-10-08): the option list decided, not the model's confidence.
  const optionConfirmed = applyPlan.accepted.filter((u) => u.optionConfirmed).map((u) => u.fieldPath);
  if (optionConfirmed.length > 0) {
    logger.info({ projectId, fields: optionConfirmed }, 'choice field confirmed by a declared option (§10 deterministic rule)');
  }
  if (applyPlan.rejected.length > 0) {
    logger.warn({ rejected: applyPlan.rejected }, 'rejected requirement field updates (§10A rules)');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MINOR',
      payload: { code: 'FIELD_UPDATES_REJECTED', count: applyPlan.rejected.length, codes: applyPlan.rejected.map((r) => r.code) },
    });
  }

  // ---------------------------------------------------------------- 5b. website type (§7)
  // The client's answer to `website_type.type` decides which package questionnaire applies.
  const typeUpdate = applyPlan.accepted.find((u) => u.fieldPath === 'website_type.type');
  if (typeUpdate) {
    const detected = normaliseProjectType(typeUpdate.value);
    if (detected !== 'UNKNOWN' && detected !== project.projectType) {
      await projectsRepo.setProjectType(db, projectId, detected);
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'PROJECT_TYPE_DETECTED', actorType: 'AI_AGENT',
        payload: { projectType: detected, previous: project.projectType, source: 'website_type.type', messageId: typeUpdate.sourceMessageId ?? null },
      });
      logger.info({ projectId, projectType: detected }, 'project type detected — package questionnaire applies from the next turn');
    }
  }

  // ---------------------------------------------------------------- 6. contradictions and vision
  for (const contradiction of turn.contradictions) {
    await requirementsRepo.upsertContradiction(db, {
      projectId,
      requirementVersionId: version.id,
      fieldA: contradiction.fieldA,
      fieldB: contradiction.fieldB,
      description: contradiction.description,
      severity: contradiction.severity,
      status: contradiction.status ?? 'OPEN',
    });
  }
  if (turn.contradictions.length > 0) {
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'AI_AGENT', severity: 'INFO',
      payload: { code: 'CONTRADICTIONS_RECORDED', count: turn.contradictions.length, fields: turn.contradictions.map((c) => [c.fieldA, c.fieldB]) },
    });
  }

  // ---------------------------------------------------------------- 7. re-evaluate with fresh data
  const refreshedRows = await requirementsRepo.listRequirementFields(db, version.id);
  const refreshedStates = toFieldStates(
    refreshedRows.map((f) => ({
      fieldPath: f.fieldPath, category: f.category, value: f.value,
      status: f.status as RequirementStatus, priority: f.priority, mandatory: f.mandatory, note: f.note,
    })),
  );
  const refreshedContradictions = await requirementsRepo.listContradictions(db, projectId);
  const openAfter = refreshedContradictions
    .filter((c) => c.status === 'OPEN' || c.status === 'CLARIFYING')
    .map((c) => ({
      fieldA: c.fieldA,
      fieldB: c.fieldB,
      severity: (c.severity === 'CRITICAL' || c.severity === 'MAJOR' ? 'MAJOR' : 'MINOR') as 'MAJOR' | 'MINOR',
      status: c.status as OpenContradiction['status'],
    }));

  const after = computeCompleteness({ fields: refreshedStates, contradictions: openAfter, questionnaire, hasInternalSummary: false });
  await requirementsRepo.setRequirementCompleteness(db, version.id, { completeness: after.score, vision: turn.vision });

  // ---------------------------------------------------------------- 8. ask, complete, or escalate
  const engineSaysComplete = after.readyForSummary;
  const engineStop = planNextQuestion({
    questionnaire,
    fields: refreshedStates,
    contradictions: openAfter,
    counters: { questionsAsked, clarificationsByField },
    limits: { maxQuestions, maxClarificationsPerField: maxClarifications },
  });

  if (turn.turnType === 'COMPLETE' && !engineSaysComplete) {
    // §10 — the AI never decides completeness by feeling.
    logger.warn({ projectId, blocking: after.blockingFields }, 'agent returned COMPLETE but the completeness engine disagrees; continuing the interview');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MINOR',
      payload: { code: 'PREMARKED_COMPLETE_IGNORED', blockingFields: after.blockingFields },
    });
  }

  if (engineSaysComplete) {
    // The last client answer just closed the final mandatory field: ask for the internal
    // summary right away (one extra, tightly bounded agent call) so the client is never
    // asked a meaningless follow-up question and Phase 3 gets its input immediately.
    const summaryTurn = turn.turnType === 'COMPLETE' ? turn : await requestFinalSummary(ctx, {
      job, projectId, conversationId, project, agentConfig, questionnaire,
      fields: refreshedStates,
      counters: { questionsAsked, maxQuestions, clarificationsByField },
      version: version.version, vision: turn.vision,
    });
    if (summaryTurn && summaryTurn.turnType === 'COMPLETE' && summaryTurn.internalSummaryMd) {
      await completeRequirements(ctx, {
        job, projectId, conversationId, versionId: version.id, version: version.version,
        summary: summaryTurn.internalSummaryMd, vision: summaryTurn.vision, completenessScore: after.score,
        runId,
      });
      return;
    }
    // Fallback: the interview is done but no summary was produced — a human closes it.
    logger.warn({ projectId }, 'requirements complete but no internal summary was produced');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MAJOR',
      payload: { code: 'REQUIREMENTS_SUMMARY_MISSING', blockingFields: after.blockingFields },
    });
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: 'Requirements summary could not be generated',
      reason: 'All mandatory fields are confirmed but the agent did not return an internal summary.',
      suggestedAction: 'Write the requirements summary, then re-run the requirements turn.',
      aiReport: { completeness: after.score },
    });
    await replyWithTemplate(ctx, job, conversationId, projectId);
    return;
  }

  if (engineStop.kind === 'STOP' && (engineStop.reason === 'MAX_QUESTIONS' || engineStop.reason === 'NOTHING_LEFT')) {
    // §21/§42: we never loop forever; a human gets the case with the exact reason.
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: 'Requirements interview stalled',
      reason: engineStop.reason === 'MAX_QUESTIONS'
        ? `Question limit reached (${maxQuestions}) with ${after.blockingFields.length} field(s) still open`
        : `No question left, but mandatory fields are still open: ${after.blockingFields.join(', ')}`,
      suggestedAction: 'Continue the conversation manually, then resume the requirements agent.',
      aiReport: { blockingFields: after.blockingFields, completeness: after.score },
    });
    return;
  }

  // should we ask at all this turn? Do not double-ask when the client sent two messages
  // before the worker answered. A model that wrongly answered COMPLETE is ignored: the
  // planner's next question goes out with the deterministic template text instead (§10).
  const modelClaimedComplete = turn.turnType === 'COMPLETE';
  if (!modelClaimedComplete && !shouldAsk(turn, messages)) {
    logger.info({ projectId, conversationId }, 'question already open — field updates applied without a new question');
    return;
  }

  const questionPlan: QuestionPlan = engineStop.kind === 'ASK'
    ? engineStop
    : { kind: 'ASK', fieldPath: turn.question?.fieldPath ?? '', reason: 'NEXT_MANDATORY' };
  // The planner owns WHICH field is asked (§7/§10): the model writes the wording, but a model that
  // asks about a different field would collect an answer for the wrong question — measured live
  // (2026-10-08): the target field was `target_audience.languages` while the sent text asked for a
  // branch count, and the client's answer was stored against the planner's field anyway. When the
  // two disagree the deterministic template (questionnaire text) goes out instead, so the question
  // the client reads and the field the answer fills can never diverge.
  const modelText = modelClaimedComplete ? null : toClientMessage(turn);
  const modelAsksPlannedField = engineStop.kind !== 'ASK' || turn.question?.fieldPath === questionPlan.fieldPath;
  if (modelText && !modelAsksPlannedField) {
    logger.warn(
      {
        projectId, runId,
        plannedField: questionPlan.fieldPath,
        modelField: turn.question?.fieldPath ?? null,
        promptedField: promptPlan.kind === 'ASK' ? promptPlan.fieldPath : null,
        projectedPendingField: pendingFieldPath ?? null,
      },
      'requirements model asked about a different field than the planner — sending the questionnaire wording',
    );
  }
  const text = (modelAsksPlannedField ? modelText : null) ?? fallbackQuestionText(questionPlan);
  await sendQuestion(ctx, { job, conversationId, projectId, text, runId });
  await requirementsRepo.setPendingFieldPath(
    db,
    version.id,
    questionPlan.kind === 'ASK' ? questionPlan.fieldPath : null,
  );

  // loop counters (§10 limits, persisted so restarts cannot un-cap the interview)
  await projectsRepo.incrementLoopCounter(db, projectId, SCOPE, 'questions_asked');
  if (questionPlan.kind === 'ASK' && CLARIFICATION_REASONS.has(questionPlan.reason)) {
    await projectsRepo.incrementLoopCounter(db, projectId, `${SCOPE}.clarify`, questionPlan.fieldPath);
  }

  // §10 first question sent ⇒ INTAKE → REQUIREMENTS_IN_PROGRESS (T03)
  if (project.state === 'INTAKE') {
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId,
        transitionId: 'T03',
        context: { hasInboundMessage: true },
        actorType: 'SYSTEM',
        meta: { runId, fieldPath: questionPlan.kind === 'ASK' ? questionPlan.fieldPath : null },
      });
    });
  }

  await scheduleInactivityCheck(ctx, { job, projectId, conversationId });
}

// ---------------------------------------------------------------- agent turn plumbing

interface AgentConfigRow {
  version: {
    id: string;
    model: string;
    temperature: string | number | null;
    maxOutputTokens: number | null;
    reasoningEffort?: string | null;
    timeoutMs: number | null;
    systemInstructions: string;
    outputSchema: unknown;
  };
}

/**
 * Exactly one agent turn: audit row → LLM (through `runAgentTurn`, which allows at most one
 * repair, docs/06 §5) → audit result → token/cost accounting. Never loops (§21).
 */
async function runTurn(
  ctx: HandlerContext,
  params: {
    job: JobRow;
    orgId: string;
    agentConfig: AgentConfigRow;
    task: string;
    projectData: unknown;
    clientMessages: Array<{ id?: string; at?: string; text: string }>;
    inputSummary: Record<string, unknown>;
  },
): Promise<{ runId: string; envelope: AgentEnvelope<RequirementsTurn> }> {
  const { db, config, logger } = ctx;
  const client = ctx.llm;
  if (!client) throw new WppError('LLM_NOT_CONFIGURED', 'no LLM client was injected', 'HUMAN_REQUIRED');
  const runId = await obsRepo.startAgentRun(db, {
    agentType: 'REQUIREMENTS',
    projectId: params.job.projectId,
    conversationId: (params.job.payload as { conversationId?: string }).conversationId ?? null,
    jobId: params.job.id,
    provider: config.LLM_PROVIDER,
    model: effectiveModel(params.agentConfig.version, ctx.llmRoute, ctx.config.REQUIREMENTS_LLM_MODEL) ?? params.agentConfig.version.model,
    configVersionId: params.agentConfig.version.id,
    inputSummary: params.inputSummary,
  });

  const budgetGuard = createDailyBudgetGuard({ db, orgId: params.orgId, config, provider: client.provider });
  const envelope = await runAgentTurn(
    {
      client,
      systemInstructions: params.agentConfig.version.systemInstructions,
      logger,
      beforeRequest: budgetGuard.beforeRequest,
      afterRequest: budgetGuard.afterRequest,
    },
    buildRequirementsRunInput({
      task: params.task,
      projectData: params.projectData,
      clientMessages: params.clientMessages,
      outputSchema: params.agentConfig.version.outputSchema,
      model: effectiveModel(params.agentConfig.version, ctx.llmRoute, ctx.config.REQUIREMENTS_LLM_MODEL) ?? params.agentConfig.version.model,
      temperature: params.agentConfig.version.temperature ? Number(params.agentConfig.version.temperature) : undefined,
      maxOutputTokens: params.agentConfig.version.maxOutputTokens ?? undefined,
      reasoningEffort: parseReasoningEffort(params.agentConfig.version.reasoningEffort),
      timeoutMs: params.agentConfig.version.timeoutMs ?? undefined,
    }),
  );

  const usage = 'usage' in envelope ? envelope.usage : undefined;
  await obsRepo.finishAgentRun(db, runId, {
    status: envelope.status === 'SUCCESS' ? 'SUCCESS' : envelope.status,
    errorCode: envelope.status === 'FAILED' ? envelope.errorCode : null,
    errorDetail: envelope.status === 'FAILED' ? envelope.message : envelope.status === 'NEEDS_REVIEW' ? envelope.reason : null,
    provider: usage?.provider ?? config.LLM_PROVIDER,
    model: usage?.model ?? effectiveModel(params.agentConfig.version, ctx.llmRoute, ctx.config.REQUIREMENTS_LLM_MODEL),
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    costUsd: usage?.costUsd !== undefined ? String(usage.costUsd) : null,
  });
  await obsRepo.recordEvent(db, {
    orgId: params.orgId, projectId: params.job.projectId, type: 'AGENT_RUN_FINISHED', actorType: 'AI_AGENT',
    payload: {
      jobType: params.job.type,
      runId,
      status: envelope.status,
      repairCount: envelope.status === 'SUCCESS' ? envelope.repairCount : 0,
    },
  });
  if (usage) {
    await agentConfigRepo.recordLlmUsage(db, {
      orgId: params.orgId, projectId: params.job.projectId, agentRunId: runId,
      provider: usage.provider, model: usage.model,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd,
    });
  }
  return { runId, envelope };
}

/**
 * One extra agent call to obtain the internal summary + vision for a project whose mandatory
 * fields are all confirmed. Bounded: at most one call per client turn, no retry loop here.
 */
async function requestFinalSummary(
  ctx: HandlerContext,
  params: {
    job: JobRow;
    projectId: string;
    conversationId: string;
    project: { orgId: string; projectType: string | null };
    agentConfig: AgentConfigRow;
    questionnaire: QuestionnaireDefinition;
    fields: RequirementFieldState[];
    counters: { questionsAsked: number; maxQuestions: number; clarificationsByField: Record<string, number> };
    version: number;
    vision: unknown;
  },
): Promise<RequirementsTurn | null> {
  const stopPlan: QuestionPlan = { kind: 'STOP', reason: 'COMPLETE' };
  const messages = await identityRepo.listRecentMessages(ctx.db, params.conversationId, 40);
  const { envelope } = await runTurn(ctx, {
    job: params.job,
    orgId: params.project.orgId,
    agentConfig: params.agentConfig,
    task: buildTaskBlock(stopPlan, {
      projectType: params.project.projectType ?? 'UNKNOWN',
      language: ctx.config.DEFAULT_LOCALE,
      counters: params.counters,
      openContradictions: 0,
      blockingFields: [],
    }),
    projectData: buildProjectDataBlock({
      projectId: params.projectId,
      projectType: params.project.projectType ?? 'UNKNOWN',
      fields: params.fields,
      pendingQuestion: null,
      contradictions: [],
      vision: params.vision as never,
      counters: params.counters,
    }),
    clientMessages: mapClientMessages(messages),
    inputSummary: { turn: params.counters.questionsAsked + 1, planKind: 'STOP', finalSummary: true },
  });
  return envelope.status === 'SUCCESS' ? envelope.output : null;
}

// ---------------------------------------------------------------- helpers

function shouldAsk(turn: RequirementsTurn, messages: Array<{ direction: string; createdAt?: Date | null }>): boolean {
  if (turn.turnType === 'COMPLETE') return false;
  const last = messages.at(-1);
  // If the last word in the conversation is ours (a question the client has not answered),
  // this turn only records the field updates; the next client message triggers the next question.
  if (last && last.direction === 'OUTBOUND') return false;
  return Boolean(turn.question || turn.turnType === 'ACKNOWLEDGE_AND_ASK');
}

async function sendQuestion(
  ctx: HandlerContext,
  params: { job: JobRow; conversationId: string; projectId: string; text: string; runId: string },
): Promise<void> {
  const { message } = await identityRepo.insertMessage(ctx.db, {
    conversationId: params.conversationId,
    projectId: params.projectId,
    direction: 'OUTBOUND',
    status: 'QUEUED',
    text: params.text,
    agentRunId: params.runId,
  });
  await sendOutboundMessage(ctx, message.id);
}

async function replyWithTemplate(ctx: HandlerContext, job: JobRow, conversationId: string, projectId: string): Promise<void> {
  const messages = await identityRepo.listRecentMessages(ctx.db, conversationId, 200);
  const alreadyReplied = messages.some((m) => m.direction === 'OUTBOUND' && m.agentRunId === job.id);
  if (alreadyReplied) return;
  const { message } = await identityRepo.insertMessage(ctx.db, {
    conversationId,
    projectId,
    direction: 'OUTBOUND',
    status: 'QUEUED',
    text: ctx.config.ECHO_REPLY_TEMPLATE,
    agentRunId: job.id,
  });
  await sendOutboundMessage(ctx, message.id);
}

async function scheduleInactivityCheck(ctx: HandlerContext, params: { job: JobRow; projectId: string; conversationId: string }): Promise<void> {
  const hours = (await orgRepo.getConfigValue<number>(ctx.db, 'requirements.inactivity_reminder_hours')) ?? 24;
  // One live timer per conversation: a new question moves it instead of stacking another job.
  await queueRepo.replacePendingJob(ctx.db, {
    orgId: params.job.orgId,
    type: 'INACTIVITY_CHECK',
    projectId: params.projectId,
    payload: { conversationId: params.conversationId },
    runAt: new Date(Date.now() + hours * 3600 * 1000),
    idempotencyKey: `inactivity:${params.conversationId}`,
  });
}

/** The T05 completion path: summary artifact → completeness → state → courtesy message (§10). */
async function completeRequirements(
  ctx: HandlerContext,
  params: {
    job: JobRow;
    projectId: string;
    conversationId: string;
    versionId: string;
    version: number;
    summary: string;
    vision: unknown;
    completenessScore: number;
    runId: string;
  },
): Promise<void> {
  const { db } = ctx;
  const agenda = ['## Agenda', '', 'This project has completed requirements collection.'].join('\n');
  const content = `${params.summary}\n\n${agenda}\n`;

  const written = writeArtifact(
    { projectId: params.projectId, kind: 'requirements', version: params.version, content, extension: 'md' },
    { rootDir: ctx.artifactsRoot },
  );
  const artifact = await createArtifact(db, {
    orgId: params.job.orgId,
    projectId: params.projectId,
    kind: 'requirements-summary',
    path: written.path,
    sha256: written.sha256,
    sizeBytes: written.sizeBytes,
    mime: 'text/markdown',
    version: params.version,
    createdByRunId: params.runId,
  });

  await requirementsRepo.setRequirementCompleteness(db, params.versionId, {
    completeness: params.completenessScore,
    vision: params.vision,
    summaryArtifactId: artifact.id,
  });

  await db.transaction(async (tx) => {
    await projectsRepo.applyTransition(tx, {
      projectId: params.projectId,
      transitionId: 'T05',
      context: { completeRequirements: true, hasRequirementsSummary: true },
      actorType: 'SYSTEM',
      meta: { requirementVersionId: params.versionId, artifactId: artifact.id },
    });
  });

  // §14 hand-off: requirements are complete → the Specification Agent takes over (T06).
  // Idempotent per requirement version, so a retried job cannot generate two specifications.
  await queueRepo.enqueueJob(db, {
    orgId: params.job.orgId,
    type: 'SPEC_GENERATE',
    projectId: params.projectId,
    payload: { conversationId: params.conversationId, requirementVersionId: params.versionId },
    idempotencyKey: `spec-generate:${params.versionId}`,
  });

  await obsRepo.recordEvent(db, {
    orgId: params.job.orgId,
    projectId: params.projectId,
    type: 'REQUIREMENTS_COMPLETE',
    actorType: 'SYSTEM',
    payload: { requirementVersionId: params.versionId, version: params.version, completeness: params.completenessScore, artifactId: artifact.id },
  });

  // A short courtesy note — NOT an approval request (§10: the single approval happens
  // later, at the Client Summary generated from the Technical Specification).
  const completeMessage = await orgRepo.getConfigValue<string>(db, 'requirements.complete_message');
  if (completeMessage) {
    const { message } = await identityRepo.insertMessage(db, {
      conversationId: params.conversationId,
      projectId: params.projectId,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      text: completeMessage,
      agentRunId: params.runId,
    });
    await sendOutboundMessage(ctx, message.id);
  }
}

/**
 * The client-content block for the prompt. Only CLIENT messages carry an id: a `sourceMessageId`
 * in the agent output must point at something the client actually wrote (§10A).
 */
function mapClientMessages(
  messages: Array<{ id: string; direction: string; text: string | null; createdAt: Date | null }>,
): Array<{ id?: string; at?: string; text: string }> {
  return messages.slice(-12).map((m) => ({
    id: m.direction === 'INBOUND' ? m.id : undefined,
    at: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
    text: `${m.direction === 'INBOUND' ? 'CLIENT' : 'US'}: ${m.text ?? '[attachment]'}`,
  }));
}

/** Exported for tests: the same plan-driven decision used by the handler. */
export { shouldAsk as __shouldAsk };

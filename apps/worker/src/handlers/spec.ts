/**
 * SPEC_GENERATE / SPEC_REVISE — the Specification Agent turn (SPEC §14–§19, §34, §35, §49).
 *
 * Division of labour:
 *   - the model writes the Technical Specification and, from it, the Client Summary;
 *   - deterministic audits in packages/core decide whether that output is *acceptable*:
 *       · `auditTraceability`  — every client-confirmed field is implemented (REQ → SPEC-REQ → AC, §16/§17)
 *       · `auditSummaryConsistency` — the summary cannot name a page/feature the spec does not have (§19)
 *   - one bounded repair attempt fixes audit gaps; a second failure becomes a human task, never a
 *     silently bad specification;
 *   - this handler persists the version, writes both artifacts and sends ONLY the client summary
 *     (the technical specification stays internal, §18).
 *
 * Two-step approval (human decision, 2026-10-08): this handler sends step 1 (the summary).
 * Step 2 — the explicit approve/change question — is sent by the CLIENT_INTENT_PARSE handler after
 * the client replies, so an approval is never requested from someone who has not read anything.
 */
import type { JobRow } from '@wpp/db';
import {
  agentConfigRepo, artifactsRepo, createArtifact, getArtifact, identityRepo, obsRepo, orgRepo,
  projectsRepo, queueRepo, requirementsRepo, specsRepo,
} from '@wpp/db';
import {
  auditSummaryConsistency, auditTraceability, nextSpecVersion, renderSpecMarkdown, WppError,
  type AuditIssue, type ClientSummary, type SpecDocument, type TraceabilityGap,
} from '@wpp/core';
import {
  buildSpecProjectData, buildSpecRunInput, buildSpecTaskBlock, looksLikeInjection, renderSummaryMessage,
  runAgentTurn, type AgentEnvelope, type SpecificationOutput, parseReasoningEffort } from '@wpp/agents';
import { readArtifact, writeArtifact } from '@wpp/infra';
import { effectiveModel } from '../services/llm.js';
import type { HandlerContext } from '../orchestrator.js';
import { sendOutboundMessage } from '../services/outbound.js';

const MAX_TRACEABILITY_REPAIRS = 1;

export async function specGenerate(ctx: HandlerContext, job: JobRow): Promise<void> {
  await specTurn(ctx, job, { mode: 'GENERATE' });
}

export async function specRevise(ctx: HandlerContext, job: JobRow): Promise<void> {
  await specTurn(ctx, job, { mode: 'REVISE' });
}

async function specTurn(ctx: HandlerContext, job: JobRow, opts: { mode: 'GENERATE' | 'REVISE' }): Promise<void> {
  const payload = job.payload as {
    conversationId?: string; messageId?: string; changeItems?: unknown; changeText?: string;
    /** §21: SPEC_REVISE jobs created by the Spec Auditor carry the issues to fix */
    reason?: 'SPEC_AUDIT';
    auditFindings?: AuditIssue[];
    auditAttempt?: number;
    auditMaxAttempts?: number;
    cycleKey?: string;
    specVersionId?: string;
  };
  const isAuditRevision = opts.mode === 'REVISE' && payload.reason === 'SPEC_AUDIT';
  if (!job.projectId || !payload.conversationId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'SPEC_GENERATE requires projectId and conversationId', 'VALIDATION');
  }
  const { db, config, logger } = ctx;
  const { projectId, conversationId } = { projectId: job.projectId, conversationId: payload.conversationId };

  const project = await projectsRepo.getProject(db, projectId);
  if (!project) throw new WppError('PROJECT_NOT_FOUND', `project ${projectId} does not exist`, 'VALIDATION');

  // ---------------------------------------------------------------- 1. source material
  const requirementVersion = await requirementsRepo.getCurrentRequirementVersion(db, projectId);
  if (!requirementVersion) {
    throw new WppError('REQUIREMENTS_MISSING', 'no requirements version to build a specification from', 'HUMAN_REQUIRED');
  }
  const fieldRows = await requirementsRepo.listRequirementFields(db, requirementVersion.id);
  const contradictionRows = await requirementsRepo.listContradictions(db, projectId);
  const requirementsSummaryArtifact = requirementVersion.summaryArtifactId
    ? await getArtifact(db, requirementVersion.summaryArtifactId)
    : null;
  const internalSummaryMd = requirementsSummaryArtifact ? readArtifact(requirementsSummaryArtifact.path) : null;

  // ---------------------------------------------------------------- 2. previous versions (§34)
  const versions = await specsRepo.listSpecVersions(db, projectId);
  const previous = versions.filter((v) => v.status !== 'SUPERSEDED').at(-1) ?? null;

  // §14/§34 idempotency: one specification+client summary per requirements version. A replayed or
  // crash-retried hand-off job must never send the client a second summary of the same thing.
  // A CHANGES_REQUESTED version is the exception — a human retries that deliberately.
  const alreadyBuilt = versions.find(
    (v) => v.requirementVersionId === requirementVersion.id && v.status !== 'CHANGES_REQUESTED',
  );
  if (opts.mode === 'GENERATE' && alreadyBuilt) {
    logger.info(
      { projectId, specVersion: alreadyBuilt.version, status: alreadyBuilt.status, jobId: job.id },
      'specification already exists for this requirements version — nothing to do',
    );
    return;
  }
  const changeText = payload.changeText ?? (isAuditRevision ? '' : previous?.changeRequestText ?? '');

  if (opts.mode === 'REVISE' && !changeText) {
    const approval = (await specsRepo.listClientApprovals(db, projectId)).filter((a) => a.decision === 'REQUEST_CHANGES').at(-1);
    if (!approval) {
      throw new WppError('CHANGE_REQUEST_MISSING', 'SPEC_REVISE requires the client change request text', 'HUMAN_REQUIRED');
    }
  }

  // ---------------------------------------------------------------- 3. agent configuration (§51)
  const agentConfig = await agentConfigRepo.getActiveAgentConfig(db, project.orgId, 'SPECIFICATION');
  if (!agentConfig || !ctx.llm) {
    logger.warn({ projectId, hasConfig: Boolean(agentConfig), hasClient: Boolean(ctx.llm) }, 'specification agent unavailable');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MAJOR',
      payload: { code: 'SPEC_AGENT_NOT_CONFIGURED', jobId: job.id, hint: 'set LLM_PROVIDER / LLM_API_KEY (docs/12 §5, free presets)' },
    });
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: 'Specification cannot be generated: no LLM configured',
      reason: 'SPEC_GENERATE ran without a usable LLM route (LLM_PROVIDER/LLM_API_KEY missing or a paid route blocked by LLM_FREE_ONLY).',
      suggestedAction: 'Configure a free provider preset (config/llm-presets.json) and re-run the SPEC_GENERATE job.',
      aiReport: { jobId: job.id, mode: opts.mode },
    });
    return;
  }

  // ---------------------------------------------------------------- 4. state transition into generation
  // T06 start v1 · T09 client-requested revision · T14 auditor-requested revision (§21).
  const transitionId = opts.mode === 'GENERATE' ? 'T06' : isAuditRevision ? 'T14' : 'T09';
  await db.transaction(async (tx) => {
    await projectsRepo.applyTransition(tx, {
      projectId,
      transitionId,
      context: { hasRequirementsSummary: Boolean(requirementsSummaryArtifact) },
      actorType: 'SYSTEM',
      meta: { jobId: job.id, mode: opts.mode, reason: payload.reason ?? null },
    });
  });

  // The previous version is kept (§34) but stops being "current" as soon as the new one exists.
  if (previous && previous.status !== 'LOCKED') {
    await specsRepo.supersedeSpecVersion(db, previous.id);
  }

  const versionNumber = nextSpecVersion(versions);
  const approvalLabels = await loadLabels(ctx);
  const messages = await identityRepo.listRecentMessages(db, conversationId, 40);
  const clientMessages = mapClientMessages(messages);

  let specVersion = await specsRepo.createSpecVersion(db, {
    orgId: project.orgId,
    projectId,
    version: versionNumber,
    requirementVersionId: requirementVersion.id,
    spec: { meta: { projectType: project.projectType ?? 'UNKNOWN', generatedFromRequirementsVersion: requirementVersion.version }, requirements: [], openQuestions: [] },
    changeRequestText: opts.mode === 'REVISE' ? (changeText || null) : null,
    status: 'DRAFT',
  });

  // ---------------------------------------------------------------- 5. run the agent (with bounded audit repair)
  let repairGaps: TraceabilityGap[] | null = null;
  let output: SpecificationOutput | null = null;
  let runId: string | null = null;
  let lastEnvelope: AgentEnvelope<SpecificationOutput> | null = null;

  for (let attempt = 0; attempt <= MAX_TRACEABILITY_REPAIRS; attempt += 1) {
    const params = {
      projectType: project.projectType ?? 'UNKNOWN',
      requirementsVersion: requirementVersion.version,
      fields: fieldRows.map((f) => ({
        fieldPath: f.fieldPath,
        value: f.value,
        status: f.status,
        priority: f.priority,
        mandatory: f.mandatory,
        category: f.category,
        sourceMessageId: f.sourceMessageId,
      })),
      contradictions: contradictionRows.map((c) => ({
        fieldA: c.fieldA,
        fieldB: c.fieldB,
        description: c.description,
        severity: (c.severity === 'CRITICAL' || c.severity === 'MAJOR' ? 'MAJOR' : 'MINOR') as 'MAJOR' | 'MINOR',
        status: c.status as 'OPEN' | 'CLARIFYING' | 'RESOLVED' | 'ACCEPTED_BY_CLIENT',
      })),
      internalSummaryMd,
      revision:
        opts.mode === 'REVISE'
          ? {
              changeRequestText: changeText,
              changeItems: Array.isArray(payload.changeItems) ? (payload.changeItems as Array<{ description: string }>) : [],
              previousSpec: (previous?.spec ?? null) as SpecDocument | null,
              previousVersion: previous?.version ?? 1,
              auditFindings: isAuditRevision ? payload.auditFindings ?? [] : null,
              auditAttempt: isAuditRevision ? payload.auditAttempt ?? null : null,
              auditMaxAttempts: isAuditRevision ? payload.auditMaxAttempts ?? null : null,
            }
          : null,
      repairGaps,
      language: config.DEFAULT_LOCALE,
      approveLabel: approvalLabels.approve,
      requestChangesLabel: approvalLabels.change,
    };

    runId = await obsRepo.startAgentRun(db, {
      agentType: 'SPECIFICATION',
      projectId,
      conversationId,
      jobId: job.id,
      provider: agentConfig.version.provider ?? null,
      model: effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL) ?? agentConfig.version.model,
      configVersionId: agentConfig.version.id,
      inputSummary: { task: opts.mode === 'REVISE' ? 'revise' : 'generate', attempt, specVersion: versionNumber, requirementsVersion: requirementVersion.version },
    });

    const envelope = await runAgentTurn(
      { client: ctx.llm, systemInstructions: agentConfig.version.systemInstructions, logger },
      buildSpecRunInput({
        task: buildSpecTaskBlock(params),
        projectData: buildSpecProjectData(params),
        clientMessages,
        outputSchema: agentConfig.version.outputSchema,
        model: effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL) ?? agentConfig.version.model,
        temperature: agentConfig.version.temperature ? Number(agentConfig.version.temperature) : undefined,
        // The agent config owns the budget (config as data, §50): a hard floor here made the
        // configured cap meaningless and the call impossible on an 8 000 TPM free tier.
        maxOutputTokens: agentConfig.version.maxOutputTokens ?? 3000,
        reasoningEffort: parseReasoningEffort(agentConfig.version.reasoningEffort),
        timeoutMs: agentConfig.version.timeoutMs ?? undefined,
      }),
    );
    lastEnvelope = envelope;
    const usage = 'usage' in envelope ? envelope.usage : undefined;
    await obsRepo.finishAgentRun(db, runId, {
      status: envelope.status === 'SUCCESS' ? 'SUCCESS' : envelope.status,
      errorCode: envelope.status === 'FAILED' ? envelope.errorCode : null,
      errorDetail: envelope.status === 'FAILED' ? envelope.message : envelope.status === 'NEEDS_REVIEW' ? envelope.reason : null,
      provider: usage?.provider ?? config.LLM_PROVIDER,
      model: usage?.model ?? effectiveModel(agentConfig.version, ctx.llmRoute, ctx.config.SPECIFICATION_LLM_MODEL),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      costUsd: usage?.costUsd !== undefined ? String(usage.costUsd) : null,
    });
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'AGENT_RUN_FINISHED', actorType: 'AI_AGENT',
      payload: { jobType: job.type, runId, status: envelope.status, attempt, repairCount: envelope.status === 'SUCCESS' ? envelope.repairCount : 0 },
    });
    if (usage) {
      await agentConfigRepo.recordLlmUsage(db, {
        orgId: project.orgId, projectId, agentRunId: runId,
        provider: usage.provider, model: usage.model,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd,
      });
    }

    if (envelope.status === 'FAILED') {
      // Retryable provider problems bubble up to the orchestrator (backoff, max attempts).
      throw new WppError(envelope.errorCode, envelope.message, envelope.retryable ? 'RETRYABLE' : 'AI_QUALITY');
    }
    if (envelope.status === 'NEEDS_REVIEW') {
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'AI_AGENT', severity: 'MAJOR',
        payload: { code: 'SPEC_NEEDS_REVIEW', reason: envelope.reason, runId },
      });
      await obsRepo.createTask(db, {
        orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
        title: `Specification v${versionNumber} needs human review`,
        reason: envelope.reason,
        suggestedAction: 'Read the agent run, fix the agent config (config/agent-configs/agents.json) or the source requirements, then re-run SPEC_GENERATE.',
        aiReport: { runId, specVersionId: specVersion.id },
      });
      return;
    }

    output = envelope.output;

    // ---- audits (§16, §17, §19)
    const traceability = auditTraceability(output.spec, params.fields);
    const consistency = auditSummaryConsistency(output.spec, output.clientSummary);
    const summaryProblems = consistency.filter((issue) => issue.kind !== 'SUMMARY_TOO_TECHNICAL');

    if (summaryProblems.length > 0) {
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SPEC_SUMMARY_INCONSISTENT', actorType: 'SYSTEM', severity: 'MAJOR',
        payload: { specVersion: versionNumber, attempt, issues: summaryProblems.map((i) => i.detail) },
      });
    }
    if (consistency.some((i) => i.kind === 'SUMMARY_TOO_TECHNICAL')) {
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SPEC_SUMMARY_INCONSISTENT', actorType: 'SYSTEM', severity: 'MINOR',
        payload: { specVersion: versionNumber, attempt, issues: consistency.filter((i) => i.kind === 'SUMMARY_TOO_TECHNICAL').map((i) => i.detail) },
      });
    }

    if (traceability.ok && summaryProblems.length === 0) break;

    repairGaps = [
      ...traceability.gaps,
      ...summaryProblems.map((issue) => ({ kind: 'UNTRACEABLE' as const, detail: `client summary: ${issue.detail}` })),
    ];
    logger.warn({ projectId, attempt, gaps: repairGaps.length }, 'specification failed the audit — asking for one repair');
  }

  if (!output || !runId) return;

  const finalTraceability = auditTraceability(output.spec, fieldRows.map((f) => ({
    fieldPath: f.fieldPath, value: f.value, status: f.status, priority: f.priority, mandatory: f.mandatory, category: f.category, sourceMessageId: f.sourceMessageId,
  })));
  const finalConsistency = auditSummaryConsistency(output.spec, output.clientSummary);
  const blockingSummaryIssues = finalConsistency.filter((i) => i.kind !== 'SUMMARY_TOO_TECHNICAL');

  if (!finalTraceability.ok || blockingSummaryIssues.length > 0) {
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SPEC_TRACEABILITY_FAILED', actorType: 'SYSTEM', severity: 'MAJOR',
      payload: {
        specVersion: versionNumber,
        specVersionId: specVersion.id,
        coverage: finalTraceability.coverage,
        gaps: finalTraceability.gaps.map((g) => `${g.kind}: ${g.detail}`),
        summaryIssues: blockingSummaryIssues.map((i) => i.detail),
        attempts: MAX_TRACEABILITY_REPAIRS + 1,
      },
    });
    await specsRepo.setSpecStatus(db, specVersion.id, 'CHANGES_REQUESTED');
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: `Specification v${versionNumber} failed the traceability audit`,
      reason: `${finalTraceability.gaps.length} gap(s); coverage ${Math.round(finalTraceability.coverage * 100)}%. First: ${finalTraceability.gaps[0]?.detail ?? blockingSummaryIssues[0]?.detail}`,
      suggestedAction: 'Decide whether the requirement is missing from the spec or the client-confirmed field list; then re-run SPEC_GENERATE.',
      aiReport: { specVersionId: specVersion.id, runId, gaps: finalTraceability.gaps, summaryIssues: blockingSummaryIssues },
    });
    await projectsRepo.applyTransition(db, {
      projectId, transitionId: 'T30', context: { reason: 'SPEC_TRACEABILITY_FAILED' }, actorType: 'SYSTEM',
      meta: { specVersionId: specVersion.id },
    });
    return;
  }

  // ---------------------------------------------------------------- 6. persist the accepted version
  const specMarkdown = renderSpecMarkdown(output.spec, {
    version: versionNumber,
    projectName: project.name,
    traceability: finalTraceability.rows,
  });
  const specArtifact = await writeArtifactRow(ctx, {
    orgId: project.orgId, projectId, kind: 'technical-spec', version: versionNumber,
    content: specMarkdown, runId, extension: 'md',
  });
  const clientSummaryArtifact = await writeArtifactRow(ctx, {
    orgId: project.orgId, projectId, kind: 'client-summary', version: versionNumber,
    content: renderSummaryForClient(output.clientSummary), runId, extension: 'md',
  });

  await specsRepo.setSpecStatus(db, specVersion.id, 'IN_REVIEW', {
    spec: output.spec as unknown as Record<string, unknown>,
    clientSummaryMd: output.clientSummary.markdown,
    specArtifactId: specArtifact.id,
    clientSummaryArtifactId: clientSummaryArtifact.id,
    createdByRunId: runId,
  });
  await specsRepo.insertSpecRequirements(db, specVersion.id, output.spec.requirements);
  await specsRepo.insertAcceptanceCriteria(db, specVersion.id, output.spec);

  await obsRepo.recordEvent(db, {
    orgId: project.orgId, projectId, type: 'SPEC_GENERATED', actorType: 'AI_AGENT',
    payload: {
      specVersionId: specVersion.id, version: versionNumber, mode: opts.mode,
      requirements: output.spec.requirements.length,
      acceptanceCriteria: output.spec.requirements.reduce((n, r) => n + r.acceptanceCriteria.length, 0),
      traceabilityCoverage: finalTraceability.coverage,
      specArtifactId: specArtifact.id, summaryArtifactId: clientSummaryArtifact.id,
    },
  });

  // ---------------------------------------------------------------- 7a. §21: a spec-audit revision goes straight back to the auditor
  // The client approved the *meaning* earlier and the auditor is what guarantees the revision did
  // not change it (client-alignment check) — so nobody is asked to re-approve a corrected document,
  // and the loop stays automatic as §21 requires.
  if (isAuditRevision) {
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId, transitionId: 'T34',
        context: { hasLockedSpecVersion: Boolean(versions.some((v) => v.status === 'LOCKED')) },
        actorType: 'SYSTEM',
        meta: { specVersionId: specVersion.id, reason: 'SPEC_AUDIT_REVISION' },
      });
    });
    await queueRepo.enqueueJob(db, {
      orgId: project.orgId,
      type: 'SPEC_AUDIT',
      projectId,
      payload: {
        conversationId,
        specVersionId: specVersion.id,
        cycleKey: payload.cycleKey ?? null,
      },
      idempotencyKey: `spec-audit:${specVersion.id}`,
    });
    logger.info(
      { projectId, specVersion: versionNumber, versionId: specVersion.id, auditAttempt: payload.auditAttempt ?? null },
      'specification revised for the Spec Auditor — re-auditing',
    );
    return;
  }

  // ---------------------------------------------------------------- 7. step 1 of the two-step approval (§18)
  const summaryText = renderSummaryMessage(output.clientSummary, { withChoices: false });
  const { message } = await identityRepo.insertMessage(db, {
    conversationId, projectId, direction: 'OUTBOUND', status: 'QUEUED', text: summaryText, agentRunId: runId,
  });
  await sendOutboundMessage(ctx, message.id);
  await specsRepo.markSummarySent(db, specVersion.id, message.id);

  await db.transaction(async (tx) => {
    await projectsRepo.applyTransition(tx, {
      projectId, transitionId: 'T07', context: {}, actorType: 'SYSTEM',
      meta: { specVersionId: specVersion.id, summaryMessageId: message.id },
    });
  });

  await obsRepo.recordEvent(db, {
    orgId: project.orgId, projectId, type: 'MESSAGE_OUTBOUND', actorType: 'AI_AGENT',
    payload: { messageId: message.id, kind: 'spec-summary', specVersion: versionNumber },
  });
  logger.info({ projectId, specVersion: versionNumber, versionId: specVersion.id }, 'specification ready for client review');
  void lastEnvelope;
}

// ---------------------------------------------------------------- helpers

async function loadLabels(ctx: HandlerContext): Promise<{ approve: string; change: string }> {
  const approve = (await orgRepo.getConfigValue<string>(ctx.db, 'spec.approve_label')) ?? 'Ha, tasdiqlayman';
  const change = (await orgRepo.getConfigValue<string>(ctx.db, 'spec.request_changes_label')) ?? 'O‘zgartirish kerak';
  return { approve, change };
}

async function writeArtifactRow(
  ctx: HandlerContext,
  params: { orgId: string; projectId: string; kind: 'technical-spec' | 'client-summary'; version: number; content: string; runId: string; extension: string },
): Promise<{ id: string; path: string }> {
  const written = writeArtifact(
    { projectId: params.projectId, kind: params.kind, version: params.version, content: params.content, extension: params.extension },
    { rootDir: ctx.artifactsRoot },
  );
  const artifact = await createArtifact(ctx.db, {
    orgId: params.orgId,
    projectId: params.projectId,
    kind: params.kind,
    path: written.path,
    sha256: written.sha256,
    sizeBytes: written.sizeBytes,
    mime: 'text/markdown',
    version: params.version,
    createdByRunId: params.runId,
  });
  return artifact;
}

/** The summary as a document on disk: the markdown plus the assumptions it showed the client (§18). */
export function renderSummaryForClient(summary: ClientSummary): string {
  const assumptions = summary.assumptionsShown.length > 0
    ? `\n\n## Taxminlar (tasdiqlashingizni so‘raymiz)\n${summary.assumptionsShown.map((a) => `- ${a}`).join('\n')}\n`
    : '\n';
  return `${summary.markdown.trim()}${assumptions}`;
}

function mapClientMessages(
  messages: Array<{ id: string; direction: string; text: string | null; createdAt: Date | null }>,
): Array<{ id?: string; at?: string; text: string }> {
  return messages.slice(-12).map((m) => ({
    id: m.direction === 'INBOUND' ? m.id : undefined,
    at: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
    text: `${m.direction === 'INBOUND' ? 'CLIENT' : 'US'}: ${m.text ?? '[attachment]'}`,
  }));
}

export { looksLikeInjection };

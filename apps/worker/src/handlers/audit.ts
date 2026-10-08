/**
 * SPEC_AUDIT — the Spec Auditor turn (§20) and the §21 revision loop.
 *
 * Flow per attempt:
 *   1. enter SPEC_AUDIT (T11 from CLIENT_APPROVED on the first attempt; the revision re-enters via T34),
 *   2. deterministic audit in `@wpp/core` (`auditSpecStructure`) — reproducible, free, and the model
 *      receives its findings as FACTS,
 *   3. one model call (the auditor's own route, §20/D-037) returning the frozen contract verdict,
 *   4. `mergeAuditVerdict` — the model cannot vote away a structural CRITICAL/MAJOR finding,
 *   5. persist the audit row (attempts are derived from these rows, so a crash cannot lose the budget),
 *   6. branch: PASS → lock the audited version + T12 READY_FOR_BUILD;
 *              FAIL with budget left → T13 SPEC_REVISION_REQUIRED + SPEC_REVISE job carrying the exact issues;
 *              FAIL on the last attempt → T15 BLOCKED + human task that explains WHY (§42) and quotes
 *              every unresolved issue.
 *
 * The client is never asked to re-approve a revision (§21 keeps the loop internal): the auditor's
 * client-alignment check is what guarantees the revision did not change the meaning the client
 * approved — and that check failing is a FAIL like any other.
 */
import type { JobRow } from '@wpp/db';
import {
  agentConfigRepo, auditsRepo, createArtifact, obsRepo, orgRepo,
  projectsRepo, queueRepo, requirementsRepo, specsRepo,
} from '@wpp/db';
import {
  auditSpecStructure, currentSpecVersion, explainAuditBlock, mergeAuditVerdict, WppError,
  type AuditIssue, type ClientSummary, type RequirementFieldInput, type SpecDocument,
} from '@wpp/core';
import {
  buildAuditProjectData, buildAuditRunInput, buildAuditTaskBlock, runAgentTurn,
  type AgentEnvelope, type SpecAuditOutput, parseReasoningEffort } from '@wpp/agents';
import { writeArtifact } from '@wpp/infra';
import { effectiveModel, resolveAuditorLlm } from '../services/llm.js';
import type { HandlerContext } from '../orchestrator.js';

const DEFAULT_MAX_ATTEMPTS = 3;

export async function specAudit(ctx: HandlerContext, job: JobRow): Promise<void> {
  const payload = job.payload as { conversationId?: string; specVersionId?: string; cycleKey?: string };
  if (!job.projectId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'SPEC_AUDIT requires projectId', 'VALIDATION');
  }
  const { db, config, logger } = ctx;
  const projectId = job.projectId;

  const project = await projectsRepo.getProject(db, projectId);
  if (!project) throw new WppError('PROJECT_NOT_FOUND', `project ${projectId} does not exist`, 'VALIDATION');

  // ---------------------------------------------------------------- 0. version + cycle
  const versions = await specsRepo.listSpecVersions(db, projectId);
  const approvedBase = [...versions]
    .filter((v) => v.status === 'LOCKED')
    .sort((a, b) => b.version - a.version)[0] ?? null;
  const cycleBase = (payload.cycleKey ? versions.find((v) => v.id === payload.cycleKey) : null) ?? approvedBase;
  const audited = (payload.specVersionId ? versions.find((v) => v.id === payload.specVersionId) : null)
    ?? approvedBase
    ?? currentSpecVersion(versions);

  if (!audited || !cycleBase) {
    throw new WppError('SPEC_NOT_LOCKED', 'SPEC_AUDIT needs an approved (locked) specification to audit', 'HUMAN_REQUIRED');
  }
  const cycleKey = cycleBase.id;

  // ---------------------------------------------------------------- 1. the auditor's own route (§20)
  const agentConfig = await agentConfigRepo.getActiveAgentConfig(db, project.orgId, 'SPEC_AUDITOR');
  const auditorLlm = await resolveAuditorLlm({ config, llm: ctx.llm, llmRoute: ctx.llmRoute, logger });
  if (!agentConfig || !auditorLlm) {
    logger.warn({ projectId, hasConfig: Boolean(agentConfig), hasClient: Boolean(auditorLlm) }, 'spec auditor unavailable');
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'SYSTEM', severity: 'MAJOR',
      payload: { code: 'SPEC_AUDITOR_NOT_CONFIGURED', jobId: job.id, hint: 'set AUDITOR_LLM_* or LLM_PROVIDER/LLM_API_KEY (docs/12 §5)' },
    });
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: 'Specification cannot be audited: no auditor LLM configured',
      reason: 'SPEC_AUDIT ran without a usable auditor route (AUDITOR_LLM_* and LLM_* are missing or blocked by LLM_FREE_ONLY).',
      suggestedAction: 'Configure the auditor route (config/llm-presets.json + .env, docs/12 §5) and re-run the SPEC_AUDIT job.',
      aiReport: { jobId: job.id, specVersionId: audited.id },
    });
    return;
  }
  const auditorRoute = { provider: auditorLlm.defaultProvider, model: auditorLlm.defaultModel };
  // A scripted run answers with a scripted persona: recording the real auditor model would be a lie
  // in the very row a reviewer trusts (the env pin only applies to a real auditor route).
  const modelPin = auditorRoute.provider === 'scripted' ? null : config.AUDITOR_LLM_MODEL;
  const model = effectiveModel(agentConfig.version, auditorRoute, modelPin) ?? agentConfig.version.model;

  // ---------------------------------------------------------------- 2. enter SPEC_AUDIT (T11)
  if (project.state === 'CLIENT_APPROVED') {
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId, transitionId: 'T11',
        context: { hasLockedSpecVersion: Boolean(approvedBase) },
        actorType: 'SYSTEM',
        meta: { specVersionId: cycleBase.id, jobId: job.id },
      });
    });
  } else if (project.state !== 'SPEC_AUDIT') {
    // The orchestrator parks jobs that the state does not allow; this is the defensive path.
    throw new WppError('WRONG_STATE', `SPEC_AUDIT ran in state ${project.state}`, 'VALIDATION');
  }

  // ---------------------------------------------------------------- 3. the §21 budget (data, not memory)
  const maxAttempts = (await orgRepo.getConfigValue<number>(db, 'loop.spec_audit.max')) ?? DEFAULT_MAX_ATTEMPTS;
  const attempt = (await auditsRepo.countCycleAttempts(db, projectId, cycleKey)) + 1;

  // ---------------------------------------------------------------- 4. source material
  const requirementVersion = await requirementsRepo.getCurrentRequirementVersion(db, projectId);
  if (!requirementVersion) {
    throw new WppError('REQUIREMENTS_MISSING', 'no requirements version to audit against', 'HUMAN_REQUIRED');
  }
  const fieldRows = await requirementsRepo.listRequirementFields(db, requirementVersion.id);
  const contradictionRows = await requirementsRepo.listContradictions(db, projectId);
  const fields: RequirementFieldInput[] = fieldRows.map((f) => ({
    fieldPath: f.fieldPath, value: f.value, status: f.status as RequirementFieldInput['status'],
    priority: f.priority, mandatory: f.mandatory, category: f.category, sourceMessageId: f.sourceMessageId,
  }));
  const spec = audited.spec as unknown as SpecDocument;
  const clientSummary: ClientSummary = { markdown: audited.clientSummaryMd ?? '', assumptionsShown: [] };
  const previousAudit = attempt > 1 ? await auditsRepo.getLatestAudit(db, projectId) : null;
  const previousIssues = previousAudit ? auditsRepo.issuesFromVerdict(previousAudit.verdict) : null;

  // ---------------------------------------------------------------- 5. deterministic audit first
  const structural = auditSpecStructure({ spec, summary: clientSummary, fields });

  // ---------------------------------------------------------------- 6. the model's judgement (§20)
  const runId = await obsRepo.startAgentRun(db, {
    agentType: 'SPEC_AUDITOR',
    projectId,
    conversationId: payload.conversationId ?? null,
    jobId: job.id,
    provider: auditorRoute.provider,
    model,
    configVersionId: agentConfig.version.id,
    inputSummary: {
      task: 'audit', attempt, maxAttempts, specVersion: audited.version,
      structuralFindings: structural.findings.length, cycleKey,
    },
  });

  const params = {
    projectType: project.projectType ?? 'UNKNOWN',
    auditAttempt: attempt,
    maxAttempts,
    specVersion: audited.version,
    spec,
    clientSummary,
    requirementsVersion: requirementVersion.version,
    fields,
    contradictions: contradictionRows.map((c) => ({
      fieldA: c.fieldA, fieldB: c.fieldB, description: c.description,
      severity: (c.severity === 'CRITICAL' || c.severity === 'MAJOR' ? 'MAJOR' : 'MINOR') as 'MAJOR' | 'MINOR',
      status: c.status as 'OPEN' | 'CLARIFYING' | 'RESOLVED' | 'ACCEPTED_BY_CLIENT',
    })),
    structuralIssues: structural.findings.map(({ category: _category, ...issue }) => issue) as AuditIssue[],
    structuralChecks: checksFromStructural(structural.findings),
    previousIssues,
    language: config.DEFAULT_LOCALE,
  };

  const envelope: AgentEnvelope<SpecAuditOutput> = await runAgentTurn(
    { client: auditorLlm.client, systemInstructions: agentConfig.version.systemInstructions, logger },
    buildAuditRunInput({
      task: buildAuditTaskBlock(params),
      projectData: buildAuditProjectData(params),
      clientMessages: [],
      outputSchema: agentConfig.version.outputSchema,
      model,
      temperature: agentConfig.version.temperature !== null && agentConfig.version.temperature !== undefined
        ? Number(agentConfig.version.temperature)
        : 0,
      maxOutputTokens: Math.max(agentConfig.version.maxOutputTokens ?? 2000, 2000),
      reasoningEffort: parseReasoningEffort(agentConfig.version.reasoningEffort),
      timeoutMs: agentConfig.version.timeoutMs ?? undefined,
    }),
  );

  const usage = 'usage' in envelope ? envelope.usage : undefined;
  await obsRepo.finishAgentRun(db, runId, {
    status: envelope.status === 'SUCCESS' ? 'SUCCESS' : envelope.status,
    errorCode: envelope.status === 'FAILED' ? envelope.errorCode : null,
    errorDetail: envelope.status === 'FAILED' ? envelope.message : envelope.status === 'NEEDS_REVIEW' ? envelope.reason : null,
    provider: usage?.provider ?? auditorRoute.provider,
    model: usage?.model ?? model,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    costUsd: usage?.costUsd !== undefined ? String(usage.costUsd) : null,
  });
  if (usage) {
    await agentConfigRepo.recordLlmUsage(db, {
      orgId: project.orgId, projectId, agentRunId: runId,
      provider: usage.provider, model: usage.model,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd,
    });
  }

  if (envelope.status === 'FAILED') {
    // Provider trouble: the orchestrator retries with backoff — an audit that never ran must not PASS.
    throw new WppError(envelope.errorCode, envelope.message, envelope.retryable ? 'RETRYABLE' : 'AI_QUALITY');
  }
  if (envelope.status === 'NEEDS_REVIEW') {
    await obsRepo.recordEvent(db, {
      orgId: project.orgId, projectId, type: 'SYSTEM_ERROR', actorType: 'AI_AGENT', severity: 'MAJOR',
      payload: { code: 'SPEC_AUDIT_NEEDS_REVIEW', reason: envelope.reason, runId, attempt },
    });
    await obsRepo.createTask(db, {
      orgId: project.orgId, projectId, type: 'HUMAN_REVIEW', priority: 'MAJOR',
      title: `Spec Auditor produced no usable verdict for v${audited.version} (attempt ${attempt}/${maxAttempts})`,
      reason: envelope.reason,
      suggestedAction: 'Read the agent run. Either fix the auditor agent config (config/agent-configs/agents.json) / auditor route, or audit the specification manually.',
      aiReport: { runId, specVersionId: audited.id, attempt, structuralFindings: structural.findings },
    });
    return;
  }

  // ---------------------------------------------------------------- 7. merge + persist (§20)
  const verdict = mergeAuditVerdict(structural, envelope.output);
  await auditsRepo.recordAudit(db, {
    orgId: project.orgId,
    projectId,
    specVersionId: audited.id,
    cycleKey,
    attempt,
    maxAttempts,
    status: verdict.status,
    score: verdict.score,
    verdict: {
      status: verdict.status, score: verdict.score,
      criticalIssues: verdict.criticalIssues, warnings: verdict.warnings,
      missingRequirements: verdict.missingRequirements, contradictions: verdict.contradictions,
      ambiguities: verdict.ambiguities, recommendations: verdict.recommendations,
      checks: verdict.checks,
      // provenance, so a later reader knows exactly how this verdict was reached
      auditMode: 'STRUCTURAL+MODEL',
      structuralForcedFail: verdict.structuralForcedFail,
      modelFailed: verdict.modelFailed,
      modelStatus: envelope.output.status,
      modelScore: envelope.output.score,
    },
    structuralFindings: structural.findings,
    structuralForcedFail: verdict.structuralForcedFail,
    modelFailed: verdict.modelFailed,
    provider: usage?.provider ?? auditorRoute.provider,
    model: usage?.model ?? model,
    agentRunId: runId,
  });

  const reportArtifact = await writeAuditArtifact(ctx, {
    orgId: project.orgId, projectId, runId,
    version: audited.version, attempt, maxAttempts, verdict, structural, model, provider: auditorRoute.provider,
  });

  await obsRepo.recordEvent(db, {
    orgId: project.orgId, projectId, type: 'SPEC_AUDIT_RESULT', actorType: 'AI_AGENT',
    severity: verdict.status === 'PASS' ? 'MINOR' : 'MAJOR',
    payload: {
      specVersionId: audited.id, specVersion: audited.version, cycleKey, attempt, maxAttempts,
      status: verdict.status, score: verdict.score,
      structuralForcedFail: verdict.structuralForcedFail, modelFailed: verdict.modelFailed,
      critical: verdict.criticalIssues.length, missing: verdict.missingRequirements.length,
      contradictions: verdict.contradictions.length, ambiguities: verdict.ambiguities.length,
      warnings: verdict.warnings.length, checks: verdict.checks,
      artifactId: reportArtifact.id, runId,
    },
  });

  // ---------------------------------------------------------------- 8. branch (§21)
  if (verdict.status === 'PASS') {
    // The audited version is the one the build will use: it must be the locked, immutable spec (§34).
    if (audited.status !== 'LOCKED') {
      await specsRepo.lockSpecVersion(db, audited.id, { at: new Date() });
      await obsRepo.recordEvent(db, {
        orgId: project.orgId, projectId, type: 'SPEC_LOCKED', actorType: 'SYSTEM',
        payload: { specVersionId: audited.id, version: audited.version, by: 'SPEC_AUDIT_PASS', cycleKey, attempt },
      });
    }
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId, transitionId: 'T12', context: {}, actorType: 'SYSTEM',
        meta: { specVersionId: audited.id, score: verdict.score, attempt },
      });
    });
    logger.info({ projectId, version: audited.version, attempt, score: verdict.score }, 'spec audit PASS — ready for build');
    return;
  }

  // FAIL
  const budget = { attempt, maxAttempts };
  if (attempt < maxAttempts) {
    const payloadForRevision = {
      conversationId: payload.conversationId ?? null,
      specVersionId: audited.id,
      cycleKey,
      reason: 'SPEC_AUDIT',
      auditAttempt: attempt,
      auditFindings: verdict.allIssues,
      auditReportArtifactId: reportArtifact.id,
      changeText: renderFindingsAsChangeText(verdict.allIssues, audited.version, attempt, maxAttempts),
    };
    await db.transaction(async (tx) => {
      await projectsRepo.applyTransition(tx, {
        projectId, transitionId: 'T13',
        context: { loopAttempts: attempt, maxLoopAttempts: maxAttempts },
        actorType: 'SYSTEM',
        meta: { specVersionId: audited.id, attempt, issues: verdict.allIssues.length },
      });
    });
    await queueRepo.enqueueJob(db, {
      orgId: project.orgId,
      type: 'SPEC_REVISE',
      projectId,
      payload: payloadForRevision,
      idempotencyKey: `spec-revise:audit:${cycleKey}:${attempt}`,
    });
    logger.warn({ projectId, version: audited.version, attempt, maxAttempts, issues: verdict.allIssues.length }, 'spec audit FAIL — revision requested');
    return;
  }

  const reason = explainAuditBlock(verdict.allIssues, budget);
  await obsRepo.createTask(db, {
    orgId: project.orgId,
    projectId,
    type: 'HUMAN_REVIEW',
    priority: 'CRITICAL',
    title: `Specification still fails the audit after ${attempt} attempt(s) — project blocked`,
    reason,
    description: renderFindingsAsChangeText(verdict.allIssues, audited.version, attempt, maxAttempts),
    suggestedAction:
      'Decide as a human: fix the requirements/specification with the client, accept a documented exception, or rescope. '
      + 'Then either continue from SPEC_REVISION_REQUIRED or send the project back to the client.',
    aiReport: {
      specVersionId: audited.id, specVersion: audited.version, cycleKey, attempt, maxAttempts,
      score: verdict.score, checks: verdict.checks, issues: verdict.allIssues,
      artifactId: reportArtifact.id, runId, structuralForcedFail: verdict.structuralForcedFail, modelFailed: verdict.modelFailed,
    },
  });
  await obsRepo.recordEvent(db, {
    orgId: project.orgId, projectId, type: 'TASK_CREATED', actorType: 'AI_AGENT', severity: 'CRITICAL',
    payload: { kind: 'SPEC_AUDIT_BLOCKED', attempt, maxAttempts, cycleKey, artifactId: reportArtifact.id },
  });
  await db.transaction(async (tx) => {
    await projectsRepo.applyTransition(tx, {
      projectId, transitionId: 'T15',
      context: { loopAttempts: attempt, maxLoopAttempts: maxAttempts, reason },
      actorType: 'SYSTEM',
      meta: { specVersionId: audited.id, attempt, issues: verdict.allIssues.length },
    });
  });
  logger.error({ projectId, version: audited.version, attempt, issues: verdict.allIssues.length }, 'spec audit FAIL on the last attempt — project BLOCKED, human task created');
}

// ---------------------------------------------------------------- helpers

/** The deterministic dimension states, per the categories that produced findings. */
function checksFromStructural(findings: Array<{ category: string; severity: string }>) {
  const failed = new Set(findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'MAJOR').map((f) => f.category));
  return {
    completeness: failed.has('COMPLETENESS') ? ('FAIL' as const) : ('PASS' as const),
    consistency: failed.has('CONSISTENCY') ? ('FAIL' as const) : ('PASS' as const),
    ambiguity: failed.has('AMBIGUITY') ? ('FAIL' as const) : ('PASS' as const),
    codingReadiness: failed.has('CODING_READINESS') ? ('FAIL' as const) : ('PASS' as const),
    clientAlignment: failed.has('CLIENT_ALIGNMENT') ? ('FAIL' as const) : ('PASS' as const),
  };
}

/** The revision brief: what the Specification Agent must fix, issue by issue (§21). */
export function renderFindingsAsChangeText(issues: AuditIssue[], version: number, attempt: number, maxAttempts: number): string {
  const header = [
    `The Spec Auditor rejected specification v${version} (audit ${attempt} of ${maxAttempts}).`,
    'Fix exactly these issues; do not change anything else and do not change the meaning the client approved.',
  ];
  const lines = issues.map(
    (issue) =>
      `- [${issue.severity}] ${issue.code}: ${issue.description}`
      + `${issue.specRequirementCode ? ` (requirement ${issue.specRequirementCode})` : ''}`
      + `${issue.suggestedFix ? ` → fix: ${issue.suggestedFix}` : ''}`,
  );
  return [...header, ...lines].join('\n');
}

async function writeAuditArtifact(
  ctx: HandlerContext,
  params: {
    orgId: string; projectId: string; runId: string; version: number; attempt: number; maxAttempts: number;
    verdict: ReturnType<typeof mergeAuditVerdict>;
    structural: ReturnType<typeof auditSpecStructure>;
    model: string; provider: string;
  },
): Promise<{ id: string; path: string }> {
  const v = params.verdict;
  const md = [
    `# Spec audit — v${params.version}, attempt ${params.attempt}/${params.maxAttempts}`,
    '',
    `**Verdict: ${v.status}** — score ${v.score}/100 (auditor ${params.provider}/${params.model})`,
    '',
    `checks: completeness=${v.checks.completeness} consistency=${v.checks.consistency} ambiguity=${v.checks.ambiguity} codingReadiness=${v.checks.codingReadiness} clientAlignment=${v.checks.clientAlignment}`,
    `deterministic findings: ${params.structural.findings.length} (worst ${params.structural.worst ?? 'none'}), score cap ${params.structural.scoreCap}`,
    `structural-forced fail: ${v.structuralForcedFail}; model said FAIL: ${v.modelFailed}`,
    '',
    section('Critical issues', v.criticalIssues),
    section('Missing requirements', v.missingRequirements),
    section('Contradictions', v.contradictions),
    section('Ambiguities', v.ambiguities),
    section('Warnings', v.warnings),
    v.recommendations.length > 0 ? `## Recommendations\n${v.recommendations.map((r) => `- ${r}`).join('\n')}\n` : '',
  ].filter(Boolean).join('\n');

  const written = writeArtifact(
    { projectId: params.projectId, kind: 'spec-audit', version: params.version, label: `a${params.attempt}`, content: md, extension: 'md' },
    { rootDir: ctx.artifactsRoot },
  );
  const artifact = await createArtifact(ctx.db, {
    orgId: params.orgId,
    projectId: params.projectId,
    kind: 'spec-audit',
    path: written.path,
    sha256: written.sha256,
    sizeBytes: written.sizeBytes,
    mime: 'text/markdown',
    version: params.version,
    createdByRunId: params.runId,
  });
  return { id: artifact.id, path: written.path };
}

function section(title: string, issues: AuditIssue[]): string {
  if (issues.length === 0) return '';
  const lines = issues.map(
    (issue) => `- **${issue.severity} / ${issue.code}** — ${issue.description}`
      + `${issue.specRequirementCode ? ` _(${issue.specRequirementCode})_` : ''}`
      + `${issue.suggestedFix ? `\n  - fix: ${issue.suggestedFix}` : ''}`,
  );
  return `## ${title}\n${lines.join('\n')}\n`;
}

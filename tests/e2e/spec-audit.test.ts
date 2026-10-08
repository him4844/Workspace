/**
 * Phase 4 acceptance, end to end through the real pipeline (§20, §21, §42):
 *
 *   CLIENT_APPROVED → SPEC_AUDIT job → deterministic audit + scripted auditor model →
 *   merged verdict → PASS ⇒ T12 READY_FOR_BUILD
 *                  → FAIL (budget left) ⇒ T13 SPEC_REVISION_REQUIRED → SPEC_REVISE → T34 → re-audit
 *                  → FAIL on the last attempt ⇒ T15 BLOCKED + CRITICAL human task quoting the issues
 *
 * Only the network call is scripted. The state machine, the audit rules in @wpp/core, the merge
 * policy, the §21 budget (derived from the audit rows), the artifacts and the human task are all
 * the real ones. The scripted auditor's mode is selected per test, so each acceptance check below
 * is a separate, honest scenario.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import {
  artifactsRepo, auditsRepo, identityRepo, obsRepo, projectsRepo, requirementsRepo, schema, specsRepo,
} from '@wpp/db';
import { auditSpecStructure, type SpecDocument } from '@wpp/core';
import { readArtifact } from '@wpp/infra';
import { tick } from '../../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../../apps/api/src/services/context.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';
import { createRouterLlm, RESTAURANT_PERSONA, readPrompt, seedPhase2 } from '../helpers/phase3.js';
import type { ScriptedAuditMode } from '@wpp/testing';

describe('phase 4 spec auditor (end to end)', () => {
  let ctx: TestContext;
  let artifactsRoot: string;
  let orgId: string;
  let connectionId: string;
  let llm: ReturnType<typeof createRouterLlm>;
  let conversationId: string;
  let projectId: string;

  beforeEach(async () => {
    ctx = await createTestContext({ DEFAULT_LOCALE: 'uz', ECHO_REPLY_TEMPLATE: 'Rahmat! Tez orada javob beraman.' });
    artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-artifacts-'));
    orgId = await seedPhase2(ctx);
    connectionId = (await getConnectionForChannel(ctx.handle.db, 'SIMULATOR')).id;
    llm = createRouterLlm();
  });

  afterEach(async () => {
    await ctx.close();
    rmSync(artifactsRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- harness (same shape as phase 3)

  async function send(text: string, mid: string, senderId = 'igsid_audit_client'): Promise<void> {
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId, text, mid });
    const [event] = parseInstagramWebhook(payload as never);
    await ingestInboundEvent(ctx.handle.db, {
      orgId, connectionId, channel: 'SIMULATOR', event: event!,
      turnJobType: 'REQUIREMENTS_TURN',
      turnJobTypeByState: { CLIENT_REVIEW: 'CLIENT_INTENT_PARSE', CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE' },
    });
  }

  async function pullForward(types: string[]): Promise<boolean> {
    const rows = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.status, 'PENDING'));
    const future = rows.filter((r) => types.includes(r.type) && r.runAt.getTime() > Date.now() + 200);
    if (future.length === 0) return false;
    for (const job of future) {
      await ctx.handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job.id));
    }
    return true;
  }

  async function tickOnce(): Promise<{ empty: boolean }> {
    const result = await tick(
      { db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'test-worker', llm, artifactsRoot },
      { maxJobs: 1 },
    );
    return { empty: result.empty };
  }

  async function parkJobs(types?: string[]): Promise<void> {
    if (!types || types.length === 0) return;
    const rows = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.status, 'PENDING'));
    for (const job of rows.filter((r) => types.includes(r.type))) {
      await ctx.handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.jobs.id, job.id));
    }
  }

  async function advance(types = ['REQUIREMENTS_TURN', 'CLIENT_INTENT_PARSE', 'SPEC_AUDIT'], opts: { park?: string[] } = {}): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const { empty } = await tickOnce();
      await parkJobs(opts.park);
      if (!empty) continue;
      const pulled = await pullForward(types);
      if (!pulled) return;
    }
  }

  const lastOutbound = async (): Promise<string> => {
    const messages = await identityRepo.listMessages(ctx.handle.db, conversationId);
    return messages.filter((m) => m.direction === 'OUTBOUND').at(-1)?.text ?? '';
  };

  const outboundCount = async (): Promise<number> =>
    (await identityRepo.listMessages(ctx.handle.db, conversationId)).filter((m) => m.direction === 'OUTBOUND').length;

  /** Interview → specification → two-step approval → locked v1 sitting in CLIENT_APPROVED. */
  async function runToApproval(): Promise<{ versionId: string; version: number }> {
    await send('Salom! Osh Baraka restorani uchun sayt kerak', 'mid_first');
    await advance();
    const [conversation] = await ctx.handle.db.select().from(schema.conversations).limit(1);
    conversationId = conversation!.id;
    projectId = (await projectsRepo.findOpenProjectForConversation(ctx.handle.db, conversationId))!.id;

    for (let turn = 1; turn <= 60; turn += 1) {
      const project = await projectsRepo.getProject(ctx.handle.db, projectId);
      if (project!.state !== 'REQUIREMENTS_IN_PROGRESS') break;
      const messages = await identityRepo.listMessages(ctx.handle.db, conversationId);
      const last = messages.at(-1);
      if (!last || last.direction !== 'OUTBOUND') break;
      const fieldPath = /([a-z_]+(?:\.[a-z_]+)+)\s*:/i.exec(last.text ?? '')?.[1] ?? 'unknown';
      const answer = RESTAURANT_PERSONA[fieldPath] ?? 'Ha, shunday bo‘lsin';
      await send(`${fieldPath}: ${Array.isArray(answer) ? answer.join(', ') : String(answer)}`, `mid_turn_${turn}`);
      await advance(['REQUIREMENTS_TURN'], { park: ['SPEC_GENERATE', 'SPEC_REVISE'] });
    }

    await advance(['SPEC_GENERATE', 'SPEC_REVISE'], { park: ['SPEC_AUDIT'] });
    await send('Ha, hammasi tushunarli', 'mid_ack');
    await advance(['CLIENT_INTENT_PARSE'], { park: ['SPEC_AUDIT'] });
    await send('Ha, tasdiqlayman', 'mid_approve');
    await advance(['CLIENT_INTENT_PARSE'], { park: ['SPEC_AUDIT'] });

    const locked = await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId);
    expect(locked).not.toBeNull();
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))!.state).toBe('CLIENT_APPROVED');
    return { versionId: locked!.id, version: locked!.version };
  }

  const transitions = async (): Promise<string[]> =>
    (await projectsRepo.listTransitions(ctx.handle.db, projectId)).map((t) => t.transitionId);

  /** oldest first — the repository returns newest first for the inspector */
  const auditRows = async () =>
    (await auditsRepo.listAuditsForProject(ctx.handle.db, projectId)).sort((a, b) => a.attempt - b.attempt);

  // ---------------------------------------------------------------- checks

  it('a good specification gets PASS and reaches READY_FOR_BUILD (§20, T11/T12)', async () => {
    const { versionId, version } = await runToApproval();
    const messagesBefore = await outboundCount();

    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    // 1. the auditor ran, on its own route, and entered through T11
    expect(await transitions()).toEqual(expect.arrayContaining(['T10', 'T11', 'T12']));
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('READY_FOR_BUILD');

    // 2. one audit row: PASS, attempts 1/3, cycle = the approved version, checks all PASS
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.status).toBe('PASS');
    expect(audit.attempt).toBe(1);
    expect(audit.maxAttempts).toBe(3);
    expect(audit.cycleKey).toBe(versionId);
    expect(audit.specVersionId).toBe(versionId);
    const verdict = audit.verdict as { status: string; score: number; checks: Record<string, string>; auditMode: string };
    expect(verdict.status).toBe('PASS');
    expect(verdict.score).toBeGreaterThanOrEqual(70);
    expect(Object.values(verdict.checks).every((state) => state === 'PASS')).toBe(true);
    expect(verdict.auditMode).toBe('STRUCTURAL+MODEL');

    // 3. the audit is an artifact and an event, and the audited version is the locked build source
    const events = await obsRepo.listEvents(ctx.handle.db, projectId, 200);
    const result = events.find((e) => e.type === 'SPEC_AUDIT_RESULT');
    expect(result).toBeDefined();
    expect(result!.payload).toMatchObject({ status: 'PASS', attempt: 1, specVersion: version });
    const artifacts = await ctx.handle.db.select().from(schema.artifacts).where(eq(schema.artifacts.projectId, projectId));
    const report = artifacts.find((a) => a.kind === 'spec-audit');
    expect(report).toBeDefined();
    expect(readArtifact(report!.path) ?? '').toContain('**Verdict: PASS**');
    const current = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(current!.status).toBe('LOCKED');

    // 4. the auditor used its own route and saw structured data, not a transcript of instructions
    const auditCall = llm.calls.find((c) => readPrompt(c).task.startsWith('Audit specification'));
    expect(auditCall).toBeDefined();
    const auditPrompt = readPrompt(auditCall!);
    const auditData = auditPrompt.projectData as unknown as {
      specification: { requirements: unknown[] };
      clientApprovedSummary: { markdown: string };
      deterministicFindings: unknown[];
      previousAuditIssues: unknown;
    };
    expect(auditData.specification.requirements.length).toBeGreaterThan(0);
    expect(auditData.clientApprovedSummary.markdown.length).toBeGreaterThan(0);
    expect(auditData.previousAuditIssues).toBeNull();

    // 5. no human, no client round-trip: auditing is internal (§21)
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks).toEqual([]);
    expect(await outboundCount()).toBe(messagesBefore);
    // the only outbound after the approval question is the configurable thank-you, not an audit report
    expect(await lastOutbound()).toContain('Spetsifikatsiya tasdiqlandi');
  });

  it('deliberate gaps (a confirmed field with no requirement, an unmeasurable "beautiful") get a FAIL with specific issues — even when the model says PASS', async () => {
    const { versionId } = await runToApproval();

    // Sabotage the stored specification the way a bad generation would: drop the requirement that
    // implemented a client-confirmed field and add a MUST criterion nobody can verify.
    const stored = await specsRepo.getSpecVersion(ctx.handle.db, versionId);
    const spec = stored!.spec as unknown as SpecDocument;
    const snapshot = await requirementsRepo.listCurrentRequirementSnapshot(ctx.handle.db, projectId);
    const victim = snapshot.fields.find((f) => f.status === 'CLIENT_CONFIRMED' && f.fieldPath.startsWith('pages.'))!
      ?? snapshot.fields.find((f) => f.status === 'CLIENT_CONFIRMED')!;
    const sabotaged: SpecDocument = {
      ...spec,
      requirements: [
        ...spec.requirements.filter((r) => r.originReqField !== victim.fieldPath),
        {
          code: 'SPEC-REQ-900', originReqField: null, section: 'UI/UX Requirements', title: 'Design',
          description: 'The site must look beautiful', priority: 'MUST',
          acceptanceCriteria: [{ code: 'AC-900', text: 'The design looks beautiful', testable: true, verificationHint: 'VISUAL' }],
        },
      ],
    };
    await ctx.handle.db.update(schema.specVersions).set({ spec: sabotaged as unknown as object }).where(eq(schema.specVersions.id, versionId));

    // the scripted model answers PASS; the deterministic findings must still force the FAIL
    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    const audit = audits.find((a) => a.attempt === 1)!;
    expect(audit.status).toBe('FAIL');
    expect(audit.structuralForcedFail).toBe(true);
    expect(audit.modelFailed).toBe(false);
    const verdict = audit.verdict as {
      status: string; score: number; missingRequirements: Array<{ code: string }>;
      ambiguities: Array<{ code: string; description: string }>; checks: Record<string, string>; modelStatus: string;
    };
    expect(verdict.status).toBe('FAIL');
    expect(verdict.modelStatus).toBe('PASS');
    expect(verdict.score).toBeLessThanOrEqual(60); // capped by the MAJOR/CRITICAL findings
    expect(verdict.missingRequirements.map((i) => i.code)).toContain('MISSING_SPEC_REQ');
    const ambiguity = verdict.ambiguities.find((i) => i.code === 'AMBIGUOUS_REQUIREMENT');
    expect(ambiguity).toBeDefined();
    expect(ambiguity!.description).toContain('"beautiful"');
    expect(ambiguity!.description).toContain('SPEC-REQ-900');
    expect(verdict.checks.completeness).toBe('FAIL');
    expect(verdict.checks.ambiguity).toBe('FAIL');

    // §21: the failure opened a revision with the exact issues, and the re-audit passed
    expect(await transitions()).toEqual(expect.arrayContaining(['T13', 'T14', 'T34', 'T12']));
    expect(audits.map((a) => a.attempt)).toEqual([1, 2]);
    expect(audits.find((a) => a.attempt === 2)!.status).toBe('PASS');
    // the second attempt was told what the first one complained about
    const secondCall = llm.calls.filter((c) => readPrompt(c).task.startsWith('Audit specification')).at(-1)!;
    expect((readPrompt(secondCall).projectData as unknown as { previousAuditIssues: unknown[] }).previousAuditIssues.length).toBeGreaterThan(0);
    const versions = await specsRepo.listSpecVersions(ctx.handle.db, projectId);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const revision = versions.at(-1)!;
    expect(revision.changeRequestText).toContain('MISSING_SPEC_REQ');
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))!.state).toBe('READY_FOR_BUILD');
  });

  it('FAIL with budget left revises the spec and re-audits without waking the client (§21)', async () => {
    llm = createRouterLlm({ auditMode: 'fail-first' satisfies ScriptedAuditMode });
    const { versionId } = await runToApproval();
    const messagesBefore = await outboundCount();

    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    const audits = await auditRows();
    expect(audits.map((a) => a.status)).toEqual(['FAIL', 'PASS']);
    expect(audits.map((a) => a.attempt)).toEqual([1, 2]);
    expect(audits.every((a) => a.cycleKey === versionId)).toBe(true);

    // the loop's own transitions: T13 (revision required) → T14 (generate) → T34 (re-audit) → T12
    expect(await transitions()).toEqual(expect.arrayContaining(['T11', 'T13', 'T14', 'T34', 'T12']));
    expect(await transitions()).not.toContain('T08'); // no client change request was involved

    const versions = await specsRepo.listSpecVersions(ctx.handle.db, projectId);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    // the approved base stays on record; the audited revision becomes the locked build source
    expect(versions[0]!.status).toBe('LOCKED');
    expect(versions[1]!.status).toBe('LOCKED');
    expect((await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId))!.version).toBe(2);

    // the client was never asked to re-approve a correction of an already approved meaning
    expect(await outboundCount()).toBe(messagesBefore);
    expect((await specsRepo.listClientApprovals(ctx.handle.db, projectId)).map((a) => a.decision)).toEqual(['APPROVE']);
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))!.state).toBe('READY_FOR_BUILD');

    // the revision agent received the issues, and the first FAIL is quoted in the revision brief
    const reviseCall = llm.calls.find((c) => readPrompt(c).task.includes('REVISION'));
    expect(reviseCall).toBeDefined();
    const revisePrompt = readPrompt(reviseCall!);
    expect(revisePrompt.task).toContain('SPEC-AUDIT REVISION');
    expect(revisePrompt.task).toContain('AMBIGUOUS_REQUIREMENT');
  });

  it('three failures stop the loop, block the project and create a human task with the exact issues (§21, §42)', async () => {
    llm = createRouterLlm({ auditMode: 'fail-all' satisfies ScriptedAuditMode });
    const { versionId } = await runToApproval();

    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    const audits = await auditRows();
    expect(audits.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(audits.every((a) => a.status === 'FAIL')).toBe(true);
    expect(audits.every((a) => a.maxAttempts === 3)).toBe(true);

    // the loop stopped exactly at the ceiling: T13 twice, then T15 — never a fourth attempt
    const t = await transitions();
    expect(t.filter((id) => id === 'T13')).toHaveLength(2);
    expect(t.filter((id) => id === 'T15')).toHaveLength(1);
    expect(t.filter((id) => id === 'SPEC_AUDIT' as unknown as string)).toHaveLength(0);
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('BLOCKED');
    expect(project!.blockedFrom).toBe('SPEC_AUDIT');
    const pendingAudits = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .filter((j) => j.type === 'SPEC_AUDIT' && (j.status === 'PENDING' || j.status === 'PARKED'));
    expect(pendingAudits).toEqual([]);

    // §42: the human gets WHY, and every unresolved issue verbatim
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.type).toBe('HUMAN_REVIEW');
    expect(task.priority).toBe('CRITICAL');
    expect(task.reason).toContain('limit 3');
    expect(task.reason).toContain('A human must decide');
    expect(task.reason).toContain('AMBIGUOUS_REQUIREMENT');
    expect(task.description).toContain('audit 3 of 3');
    expect(task.suggestedAction).toContain('rescope');
    const report = task.aiReport as { issues: Array<{ code: string }>; attempt: number; score: number };
    expect(report.attempt).toBe(3);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(70);

    // a blocked project is not quietly rebuilt: no pipeline job is waiting to move it on
    // (an INACTIVITY_CHECK timer may still be scheduled — that one only observes, it never resumes)
    const pendingPipelineJobs = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .filter((j) => j.status === 'PENDING' || j.status === 'PARKED')
      .filter((j) => ['SPEC_AUDIT', 'SPEC_REVISE', 'SPEC_GENERATE', 'CLIENT_INTENT_PARSE'].includes(j.type))
      .map((j) => `${j.type}:${j.status}`);
    expect(pendingPipelineJobs).toEqual([]);
  });

  it('a revision that changes the approved meaning fails on client alignment (§20)', async () => {
    llm = createRouterLlm({ auditMode: 'alignment' satisfies ScriptedAuditMode });
    await runToApproval();

    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    const audits = await auditRows();
    const verdict = audits[0]!.verdict as { contradictions: Array<{ code: string }>; checks: Record<string, string>; status: string };
    expect(audits[0]!.status).toBe('FAIL');
    expect(verdict.contradictions.map((i) => i.code)).toContain('CLIENT_ALIGNMENT_FAILURE');
    expect(verdict.checks.clientAlignment).toBe('FAIL');
    expect((await transitions())).toContain('T13');

    // the alignment failure blocks the project after the ceiling, with the reason a human can act on
    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);
    const task = (await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)))[0]!;
    expect(task.reason).toContain('CLIENT_ALIGNMENT_FAILURE');
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))!.state).toBe('BLOCKED');
  });

  it('the deterministic audit alone flags the gaps §20 names (fast, measurable, language-independent)', async () => {
    // A direct check of the rule, not of the pipeline: this is what makes the acceptance check
    // reproducible on any model, in any language.
    const fields = await (async () => {
      await runToApproval();
      const snapshot = await requirementsRepo.listCurrentRequirementSnapshot(ctx.handle.db, projectId);
      return snapshot.fields.map((f) => ({
        fieldPath: f.fieldPath, value: f.value, status: f.status, priority: f.priority,
        mandatory: f.mandatory, category: f.category, sourceMessageId: f.sourceMessageId,
      }));
    })();
    const version = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    const spec = version!.spec as unknown as SpecDocument;
    const summary = { markdown: version!.clientSummaryMd ?? '', assumptionsShown: [] };

    const clean = auditSpecStructure({ spec, summary, fields });
    expect(clean.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'MAJOR')).toEqual([]);

    const withGap = auditSpecStructure({
      spec: {
        ...spec,
        requirements: spec.requirements.map((r, index) =>
          index === 0
            ? { ...r, description: 'The interface must be modern and fast', acceptanceCriteria: [{ code: 'AC-X', text: 'It feels fast', testable: true, verificationHint: 'MANUAL' }] }
            : r,
        ),
      },
      summary,
      fields,
    });
    const gap = withGap.findings.find((f) => f.code === 'AMBIGUOUS_REQUIREMENT');
    expect(gap?.severity).toBe('MAJOR');
    expect(gap?.description).toContain('"modern"');
    expect(gap?.description).toContain('"fast"');
  });
});

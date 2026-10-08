/**
 * Phase 4 acceptance, end to end through the real pipeline (docs/14 §3):
 *
 *   CLIENT_APPROVED → SPEC_AUDIT job → deterministic audit (packages/core) →
 *   Spec Auditor agent (scripted LLM, own route) → mergeAuditVerdict → spec_audits row + artifact →
 *   PASS ⇒ T12 READY_FOR_BUILD | FAIL ⇒ T13 SPEC_REVISION_REQUIRED → T14 SPEC_GENERATE →
 *   T34 re-audit → … | ceiling ⇒ T15 BLOCKED + human task (§21/§42).
 *
 * Only the network call is scripted. Prompt assembly, the frozen-contract validation, the
 * deterministic audit, the merge policy, the §21 attempt counter (persisted rows), the state
 * machine, the artifacts and the human-task escalation all run for real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { auditsRepo, artifactsRepo, identityRepo, obsRepo, projectsRepo, schema, specsRepo } from '@wpp/db';
import { tick } from '../../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../../apps/api/src/services/context.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';
import { createRouterLlm, RESTAURANT_PERSONA, seedPhase2, type ScriptedAuditMode } from '../helpers/phase3.js';

describe('phase 4 spec audit (end to end)', () => {
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

  // ---------------------------------------------------------------- harness

  /** The scripted auditor must be chosen BEFORE the first tick: the router is built per mode. */
  function useAuditMode(mode: ScriptedAuditMode): void {
    llm = createRouterLlm({ auditMode: mode });
  }

  async function send(text: string, mid: string, senderId = 'igsid_audit_client'): Promise<void> {
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId, text, mid });
    const [event] = parseInstagramWebhook(payload as never);
    await ingestInboundEvent(ctx.handle.db, {
      orgId,
      connectionId,
      channel: 'SIMULATOR',
      event: event!,
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

  /**
   * Run the pipeline to quiescence. `park` holds the listed job types out of the way — the pipeline
   * would run them immediately, which is correct behaviour but not always what the scenario wants to
   * observe. Parked types must also be left out of `types`, otherwise the deferred-job pull would
   * release exactly the job that was parked.
   */
  async function advance(types = ['REQUIREMENTS_TURN', 'CLIENT_INTENT_PARSE', 'SPEC_AUDIT', 'SPEC_REVISE'], opts: { park?: string[] } = {}): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      const { empty } = await tickOnce();
      await parkJobs(opts.park);
      if (!empty) continue;
      const pulled = await pullForward(types);
      if (!pulled) return;
    }
  }

  const outboundCount = async (): Promise<number> =>
    (await identityRepo.listMessages(ctx.handle.db, conversationId)).filter((m) => m.direction === 'OUTBOUND').length;

  const transitions = async (): Promise<string[]> =>
    (await projectsRepo.listTransitions(ctx.handle.db, projectId)).map((t) => t.transitionId);

  const jobRows = async () => ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId));

  const taskRows = async () => ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));

  /**
   * Full run up to the point where the approved specification is locked.
   * `stopBeforeAudit` leaves the SPEC_AUDIT job parked, so a test can look at (or sabotage) the
   * approved document before the auditor reads it.
   */
  async function runToApproval(opts: { stopBeforeAudit?: boolean } = {}): Promise<void> {
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
      await advance(['REQUIREMENTS_TURN'], { park: ['SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT'] });
    }

    // specification (Phase 3 hand-off), then the two-step client approval (§19)
    await advance(['SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT'], { park: ['SPEC_AUDIT'] });
    await send('Ha, hammasi tushunarli', 'mid_ack');
    await advance(['CLIENT_INTENT_PARSE'], { park: ['SPEC_AUDIT', 'SPEC_REVISE'] });
    await send('Ha, tasdiqlayman', 'mid_approve');
    // The approval locks the version and enqueues SPEC_AUDIT (T11). Normally the audit leg runs here;
    // with `stopBeforeAudit` the job stays parked (and out of the pull list, or the pull would release
    // it) so a test can inspect — or sabotage — the approved document first.
    await (opts.stopBeforeAudit
      ? advance(['CLIENT_INTENT_PARSE'], { park: ['SPEC_AUDIT', 'SPEC_REVISE'] })
      : advance(['CLIENT_INTENT_PARSE', 'SPEC_AUDIT', 'SPEC_REVISE']));
  }

  // ---------------------------------------------------------------- tests

  it('a good specification gets PASS and reaches READY_FOR_BUILD (§20, T11/T12)', async () => {
    useAuditMode('pass');
    await runToApproval();

    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('READY_FOR_BUILD');
    expect(await transitions()).toEqual(expect.arrayContaining(['T10', 'T11', 'T12']));

    const audits = await auditsRepo.listAuditsForProject(ctx.handle.db, projectId);
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.attempt).toBe(1);
    expect(audit.status).toBe('PASS');
    expect(audit.score).toBeGreaterThanOrEqual(70);
    expect(audit.cycleKey).toBe((await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId))!.id);

    // the five §20 dimensions are answered separately, and a PASS cannot hide a failed dimension
    const checks = auditsRepo.checksFromVerdict(audit.verdict);
    expect(checks).not.toBeNull();
    for (const value of Object.values(checks!)) expect(value).toBe('PASS');

    // the audited version is the locked one — the build source is both approved and audited
    const locked = await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId);
    expect(locked!.version).toBe(1);

    // auditability: one artifact + one event per attempt, and the human queue stays empty
    const artifacts = await artifactsRepo.listArtifacts(ctx.handle.db, projectId);
    expect(artifacts.some((a) => a.kind === 'spec-audit' && a.path.includes('/spec-audit/'))).toBe(true);
    const events = await obsRepo.listEvents(ctx.handle.db, projectId, 500);
    expect(events.filter((e) => e.type === 'SPEC_AUDIT_RESULT')).toHaveLength(1);
    expect(await taskRows()).toHaveLength(0);
  });

  it('a FAIL with budget left revises the specification and re-audits it without waking the client (§21)', async () => {
    useAuditMode('fail-first');
    await runToApproval({ stopBeforeAudit: true });
    // the client approved (T10) and the audit job is parked: from here the loop is internal
    const outboundBeforeAudit = await outboundCount();
    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    // one revision cycle: FAIL(1) → T13 → T14 → T34 → PASS(2) → T12
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('READY_FOR_BUILD');
    const ids = await transitions();
    for (const id of ['T11', 'T13', 'T14', 'T34', 'T12']) expect(ids).toContain(id);

    const audits = await auditsRepo.listAuditsForProject(ctx.handle.db, projectId);
    expect(audits.map((a) => a.attempt)).toEqual([2, 1]); // newest first
    expect(audits.map((a) => a.status).sort()).toEqual(['FAIL', 'PASS']);
    expect(new Set(audits.map((a) => a.cycleKey)).size).toBe(1); // one audit cycle, keyed by the approved version

    // the revision became a new version and the audited one is what the build would start from
    const versions = await specsRepo.listSpecVersions(ctx.handle.db, projectId);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const locked = await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId);
    expect(locked!.version).toBe(2);

    // the revision job carries the auditor's exact issues, and the client was never asked to re-approve
    const jobs = await jobRows();
    const revise = jobs.filter((j) => j.type === 'SPEC_REVISE');
    expect(revise.length).toBeGreaterThanOrEqual(1);
    const payload = revise.at(-1)!.payload as { reason?: string; auditFindings?: unknown[] };
    expect(payload.reason).toBe('SPEC_AUDIT');
    expect((payload.auditFindings ?? []).length).toBeGreaterThan(0);

    // §21 keeps the loop internal: not a single message reached the client during FAIL → revise → PASS
    expect(await outboundCount()).toBe(outboundBeforeAudit);
    expect(await taskRows()).toHaveLength(0);
  });

  it('three failures stop the loop, block the project and create a human task with the exact issues (§21, §42)', async () => {
    useAuditMode('fail-all');
    await runToApproval();

    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('BLOCKED');
    expect(project!.blockedFrom).toBe('SPEC_AUDIT');

    const audits = await auditsRepo.listAuditsForProject(ctx.handle.db, projectId);
    expect(audits.map((a) => a.attempt).sort()).toEqual([1, 2, 3]);
    expect(audits.every((a) => a.status === 'FAIL')).toBe(true);

    const ids = await transitions();
    expect(ids.filter((t) => t === 'T15')).toHaveLength(1);

    const tasks = await taskRows();
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.type).toBe('HUMAN_REVIEW');
    expect(task.priority).toBe('CRITICAL');
    // §42: WHY a human is needed, and the issues themselves — not "something went wrong"
    expect(task.reason ?? '').toMatch(/3 time\(s\)/);
    expect(task.reason ?? '').toMatch(/limit 3/);
    const issues = auditsRepo.issuesFromVerdict(audits[0]!.verdict);
    expect(issues.length).toBeGreaterThan(0);
    expect(task.reason ?? '').toContain(issues[0]!.code);

    // automation stopped: no audit or revision job is left to run
    const jobs = await jobRows();
    expect(jobs.some((j) => (j.type === 'SPEC_AUDIT' || j.type === 'SPEC_REVISE') && j.status === 'PENDING')).toBe(false);
  });

  it('a revision that changes the approved meaning fails on client alignment (§20)', async () => {
    useAuditMode('alignment');
    await runToApproval();

    const audits = await auditsRepo.listAuditsForProject(ctx.handle.db, projectId);
    expect(audits.length).toBeGreaterThan(0);
    const first = audits.at(-1)!;
    expect(first.status).toBe('FAIL');
    const checks = auditsRepo.checksFromVerdict(first.verdict);
    expect(checks!.clientAlignment).toBe('FAIL');

    const issues = auditsRepo.issuesFromVerdict(first.verdict) as Array<{ code: string }>;
    expect(issues.some((i) => i.code === 'CLIENT_ALIGNMENT_FAILURE')).toBe(true);
    // the alignment failure is recorded where an inconsistency belongs
    const contradictions = (first.verdict as { contradictions?: Array<{ code: string }> }).contradictions ?? [];
    expect(contradictions.some((c) => c.code === 'CLIENT_ALIGNMENT_FAILURE')).toBe(true);
  });

  it('the deterministic audit overrules the model: gaps are a FAIL with specific issues even when the model says PASS', async () => {
    useAuditMode('pass');
    await runToApproval({ stopBeforeAudit: true });

    // The client approved (T10, version LOCKED) and the SPEC_AUDIT job is parked. Sabotage the
    // approved document the way a careless agent would: a confirmed field loses its requirement,
    // and an unmeasurable criterion ("beautiful") creeps in. Both are exactly the gaps §20 names.
    const locked = await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId);
    const spec = locked!.spec as { requirements: Array<Record<string, unknown>> };
    const kept = spec.requirements.filter((r) => r.originReqField !== 'payments.needed');
    const sabotaged = {
      ...spec,
      requirements: [
        ...kept,
        {
          code: 'SPEC-REQ-900',
          title: 'Design quality',
          description: 'The design must be beautiful and modern for every visitor.',
          section: 'UI/UX Requirements',
          priority: 'MUST',
          originReqField: 'design.style',
          acceptanceCriteria: [
            { code: 'AC-900-1', text: 'The design must be beautiful', testable: true, verificationHint: 'subjective review' },
          ],
        },
      ],
    };
    await ctx.handle.db
      .update(schema.specVersions)
      .set({ spec: sabotaged as never })
      .where(eq(schema.specVersions.id, locked!.id));

    // release the parked job: the audit runs through the normal T11 path
    await advance(['SPEC_AUDIT', 'SPEC_REVISE']);

    const audits = await auditsRepo.listAuditsForProject(ctx.handle.db, projectId);

    // attempt 1 is the sabotaged version: the model said PASS, the deterministic rules said FAIL
    const sabotagedAudit = audits.find((a) => a.attempt === 1)!;
    expect(sabotagedAudit.status).toBe('FAIL');
    expect(sabotagedAudit.modelFailed).toBe(false); // the scripted model answered PASS
    expect(sabotagedAudit.structuralForcedFail).toBe(true); // the rules, not the model, decided
    expect(sabotagedAudit.score).toBeLessThanOrEqual(60);

    const issues = auditsRepo.issuesFromVerdict(sabotagedAudit.verdict) as Array<{ code: string }>;
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('MISSING_SPEC_REQ'); // payments.needed lost its requirement
    expect(codes).toContain('AMBIGUOUS_REQUIREMENT'); // "beautiful" with nothing measurable

    const checks = auditsRepo.checksFromVerdict(sabotagedAudit.verdict);
    expect(checks!.completeness).toBe('FAIL');
    expect(checks!.ambiguity).toBe('FAIL');

    // and §21 then healed it: the revision re-audited clean, and attempt 1 was not overwritten
    const healed = audits.find((a) => a.attempt === 2);
    expect(healed?.status).toBe('PASS');
    expect((await projectsRepo.getProject(ctx.handle.db, projectId))!.state).toBe('READY_FOR_BUILD');
});
});

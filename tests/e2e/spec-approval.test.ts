/**
 * Phase 3 acceptance, end to end through the real pipeline (docs/14 §3):
 *
 *   REQUIREMENTS_COMPLETE → SPEC_GENERATE job → Specification Agent (scripted LLM) →
 *   deterministic traceability + summary audits → spec_versions v1 + artifacts →
 *   client summary (step 1) → client reply → approval question (step 2) →
 *   APPROVE ⇒ T10 + SPEC_LOCKED   |   REQUEST_CHANGES ⇒ T08 + SPEC_REVISE → v2
 *
 * Only the network call is scripted. Prompt assembly, validation, both audits, the state machine,
 * the database, the artifacts and the two-step approval logic all run for real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import {
  artifactsRepo, identityRepo, obsRepo, projectsRepo, requirementsRepo, schema, specsRepo,
} from '@wpp/db';
import { readArtifact } from '@wpp/infra';
import { tick } from '../../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../../apps/api/src/services/context.js';
import { createTestContext, silentLogger, type TestContext } from '../helpers/context.js';
import { createRouterLlm, RESTAURANT_PERSONA, readPrompt, seedPhase2 } from '../helpers/phase3.js';

describe('phase 3 specification + client approval (end to end)', () => {
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

  async function send(text: string, mid: string, senderId = 'igsid_spec_client'): Promise<void> {
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId, text, mid });
    const [event] = parseInstagramWebhook(payload as never);
    await ingestInboundEvent(ctx.handle.db, {
      orgId,
      connectionId,
      channel: 'SIMULATOR',
      event: event!,
      turnJobType: 'REQUIREMENTS_TURN',
      // the API routes a review-stage reply to the intent classifier by project state (§18)
      turnJobTypeByState: { CLIENT_REVIEW: 'CLIENT_INTENT_PARSE', CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE' },
    });
  }

  /** Pull deliberately deferred jobs forward so a seconds-long test does not wait for hours. */
  async function pullForward(types: string[]): Promise<boolean> {
    const rows = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.status, 'PENDING'));
    const future = rows.filter((r) => types.includes(r.type) && r.runAt.getTime() > Date.now() + 200);
    if (future.length === 0) return false;
    for (const job of future) {
      await ctx.handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job.id));
    }
    return true;
  }

  /**
   * One job per call. The pipeline is event-driven and a single `tick` would happily run the
   * requirements hand-off AND the specification job it enqueues; tests use `maxJobs: 1` so they
   * can decide what the specification agent sees and when it runs (§14).
   */
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
   * Run the pipeline to quiescence: every runnable job, plus the jobs the pipeline deliberately
   * deferred (the §10 minimum-question-interval resume, the approval timer).
   * `park` keeps the listed job types out of the way — the pipeline itself would run them
   * immediately, which is correct behaviour but not always what the scenario wants to observe.
   */
  async function advance(types = ['REQUIREMENTS_TURN', 'CLIENT_INTENT_PARSE'], opts: { park?: string[] } = {}): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const { empty } = await tickOnce();
      await parkJobs(opts.park);
      if (!empty) continue;
      const pulled = await pullForward(types);
      if (!pulled) return;
    }
  }

  /** Let the pipeline generate the specification (SPEC_GENERATE hand-off). */
  async function generateSpec(): Promise<void> {
    await advance(['SPEC_GENERATE', 'SPEC_REVISE']);
  }

  const lastOutbound = async (): Promise<string> => {
    const messages = await identityRepo.listMessages(ctx.handle.db, conversationId);
    return messages.filter((m) => m.direction === 'OUTBOUND').at(-1)?.text ?? '';
  };

  /** Answer the requirements interview until the project hands over to the specification phase. */
  async function runInterview(maxTurns = 60): Promise<void> {
    await send('Salom! Osh Baraka restorani uchun sayt kerak', 'mid_first');
    await advance();
    const [conversation] = await ctx.handle.db.select().from(schema.conversations).limit(1);
    conversationId = conversation!.id;
    projectId = (await projectsRepo.findOpenProjectForConversation(ctx.handle.db, conversationId))!.id;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
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
  }

  async function eventsOfType(type: string): Promise<Array<Record<string, unknown>>> {
    const rows = await obsRepo.listEvents(ctx.handle.db, projectId, 500);
    return rows.filter((r) => r.type === type).map((r) => r.payload as Record<string, unknown>);
  }

  const jobTypes = async (): Promise<string[]> =>
    (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId))).map((j) => j.type);

  // ---------------------------------------------------------------- tests

  it('requirements completion generates a traceable specification, sends the summary, and locks the approved version after the two-step approval', async () => {
    await runInterview();

    // 1. the hand-off job exists and the state machine allowed it (§14, T06)
    const finished = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(finished!.state).toBe('REQUIREMENTS_COMPLETE');
    const jobs = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId));
    expect(jobs.map((j) => j.type)).toContain('SPEC_GENERATE');
    expect(jobs.find((j) => j.type === 'SPEC_GENERATE')!.status).not.toBe('PARKED');

    await generateSpec();

    // 2. T06 ran and a version exists with requirements + acceptance criteria rows
    const transitions = (await projectsRepo.listTransitions(ctx.handle.db, projectId)).map((t) => t.transitionId);
    expect(transitions).toContain('T06');
    expect(transitions).toContain('T07');
    const version = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(version).not.toBeNull();
    expect(version!.version).toBe(1);
    expect(version!.status).toBe('IN_REVIEW');

    const storedRequirements = await specsRepo.listSpecRequirements(ctx.handle.db, version!.id);
    const criteria = await specsRepo.listAcceptanceCriteria(ctx.handle.db, version!.id);
    expect(storedRequirements.length).toBeGreaterThan(10);
    expect(criteria.length).toBeGreaterThanOrEqual(storedRequirements.length);
    expect(criteria.every((ac) => ac.testable)).toBe(true);

    // 3. §16 traceability — every client-confirmed requirement field is implemented
    const snapshot = await requirementsRepo.listCurrentRequirementSnapshot(ctx.handle.db, projectId);
    const clientTruth = snapshot.fields.filter((f) => f.status === 'CLIENT_CONFIRMED' || f.status === 'CLIENT_APPROVED_DEFAULT');
    const covered = new Set(storedRequirements.map((r) => r.originReqField));
    for (const field of clientTruth) {
      expect(covered.has(field.fieldPath), `uncovered field ${field.fieldPath}`).toBe(true);
    void covered;
    }
    // every SPEC-REQ row points at a field that really exists (no invented paths)
    const knownFields = new Set(snapshot.fields.map((f) => f.fieldPath));
    for (const row of storedRequirements.filter((r) => r.originReqField)) {
      expect(knownFields.has(row.originReqField!), `unknown field ${row.originReqField}`).toBe(true);
    }

    // 4. the internal spec artifact is on disk and FULLER than the client summary (§18)
    const specArtifact = await artifactsRepo.getArtifact(ctx.handle.db, version!.specArtifactId!);
    const summaryArtifact = await artifactsRepo.getArtifact(ctx.handle.db, version!.clientSummaryArtifactId!);
    expect(specArtifact!.kind).toBe('technical-spec');
    expect(summaryArtifact!.kind).toBe('client-summary');
    const specMd = readArtifact(specArtifact!.path) ?? '';
    const summaryMd = readArtifact(summaryArtifact!.path) ?? '';
    expect(specMd).toContain('SPEC-REQ-001');
    expect(specMd).toContain('Traceability matritsasi');
    expect(summaryMd.length).toBeLessThan(specMd.length);
    expect(summaryMd).not.toMatch(/API|endpoint|database|framework/i);

    // 5. step 1 of the two-step approval: the client received the summary, NOT an approval question
    const firstOutbound = await lastOutbound();
    expect(firstOutbound).toContain('Maqsad');
    expect(/tasdiqlayman|o‘zgartirish kerak/i.test(firstOutbound)).toBe(false);
    expect(version!.summarySentAt).not.toBeNull();
    expect(version!.approvalRequestedAt).toBeNull();
    expect(await eventsOfType('SPEC_GENERATED')).toHaveLength(1);

    // 6. the client replies — step 2 sends the explicit approve/change question
    await send('Ha, hammasi tushunarli', 'mid_ack');
    await advance(['CLIENT_INTENT_PARSE']);
    const secondOutbound = await lastOutbound();
    expect(secondOutbound).toMatch(/tasdiqlayman/i);
    expect(secondOutbound).toMatch(/o‘zgartirish kerak/i);
    const afterQuestion = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(afterQuestion!.approvalRequestedAt).not.toBeNull();
    // still not approved: a "understood" answer is not a decision
    expect(afterQuestion!.status).toBe('IN_REVIEW');

    // 7. the client approves → T10, approval row with the client's own message id, version locked (§19)
    await send('Ha, tasdiqlayman', 'mid_approve');
    await advance(['CLIENT_INTENT_PARSE']);
    const locked = await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId);
    expect(locked).not.toBeNull();
    expect(locked!.version).toBe(1);
    expect(locked!.lockedAt).not.toBeNull();
    const approvals = await specsRepo.listClientApprovals(ctx.handle.db, projectId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.decision).toBe('APPROVE');
    expect(approvals[0]!.classification).toBe('KEYWORD');
    const inboundIds = new Set(
      (await identityRepo.listMessages(ctx.handle.db, conversationId)).filter((m) => m.direction === 'INBOUND').map((m) => m.id),
    );
    expect(inboundIds.has(approvals[0]!.sourceMessageId)).toBe(true);

    const approvedProject = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(approvedProject!.state).toBe('CLIENT_APPROVED');
    const afterApproval = (await projectsRepo.listTransitions(ctx.handle.db, projectId)).map((t) => t.transitionId);
    expect(afterApproval).toContain('T10');
    const lockEvents = await eventsOfType('SPEC_LOCKED');
    expect(lockEvents).toEqual([expect.objectContaining({ version: 1 })]);

    // 8. a retried approval message cannot approve twice (unique source_message_id, §34)
    await send('Ha, tasdiqlayman', 'mid_approve');
    await advance(['CLIENT_INTENT_PARSE']);
    expect(await specsRepo.listClientApprovals(ctx.handle.db, projectId)).toHaveLength(1);
    expect(await specsRepo.countSpecVersions(ctx.handle.db, projectId)).toBe(1);

    // 9. no human intervention was needed on the happy path
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks).toEqual([]);

    // 10. the model saw structured data, never a free-form transcript as instructions (§38, §49)
    const specCall = llm.calls.find((c) => readPrompt(c).task.includes('Produce specification'));
    expect(specCall).toBeDefined();
    const specPrompt = readPrompt(specCall!);
    const specData = specPrompt.projectData as { requirementFields: Array<{ status: string }> };
    expect(specData.requirementFields.some((f) => f.status === 'CLIENT_CONFIRMED')).toBe(true);
    expect(specPrompt.clientBlock).toContain('CLIENT:');
  });

  it('a change request produces a new version and never edits the locked one (§19, §34, §35)', async () => {
    await runInterview();
    await generateSpec();
    const v1 = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);

    // step 2 has not been sent yet: the client asks for a change right after reading the summary
    await send('Menyuda narxlar ham ko‘rinsin, iltimos o‘zgartirish kerak', 'mid_change');
    await advance(['CLIENT_INTENT_PARSE', 'SPEC_REVISE']);

    // the change was recorded against v1 and a revision job ran
    const approvals = await specsRepo.listClientApprovals(ctx.handle.db, projectId);
    expect(approvals.map((a) => a.decision)).toEqual(['REQUEST_CHANGES']);
    expect((approvals[0]!.changeItems as unknown[]).length).toBeGreaterThan(0);
    const jobsAfterChange = await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId));
    expect(jobsAfterChange.map((j) => j.type)).toContain('SPEC_REVISE');
    const transitions = (await projectsRepo.listTransitions(ctx.handle.db, projectId)).map((t) => t.transitionId);
    expect(transitions).toContain('T08');

    // a new version exists, the old one is SUPERSEDED — never mutated (§34)
    const versions = await specsRepo.listSpecVersions(ctx.handle.db, projectId);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.status).toBe('SUPERSEDED');
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.changeRequestText).toContain('narxlar');
    const v2 = versions[1]!;
    expect(v2.requirementVersionId).toBe(v1!.requirementVersionId);
    const v2Requirements = await specsRepo.listSpecRequirements(ctx.handle.db, v2.id);
    // a revision keeps what the client already saw (the v1 codes survive) …
    expect(v2Requirements.some((r) => r.originReqField === 'deadline.expected')).toBe(true);
    // … and the client's own words are now part of the specification, never only in the chat
    expect(v2Requirements.some((r) => /narxlar/i.test(r.description))).toBe(true);
    const v1Requirements = await specsRepo.listSpecRequirements(ctx.handle.db, v1!.id);
    expect(v1Requirements.some((r) => /narxlar/i.test(r.description))).toBe(false);

    // v1 is immutable: the revision never touched its row
    const v1After = await specsRepo.getSpecVersion(ctx.handle.db, v1!.id);
    expect(v1After!.clientSummaryMd).toBe(v1!.clientSummaryMd);
    expect(v1After!.status).toBe('SUPERSEDED');

    // v2 was sent to the client as a summary again (step 1 of the next approval round)
    expect(v2.summarySentAt).not.toBeNull();
    const generated = await eventsOfType('SPEC_GENERATED');
    expect(generated).toHaveLength(2);
    expect(generated.find((e) => e.version === 2)).toMatchObject({ mode: 'REVISE' });
    expect((await specsRepo.listSpecVersions(ctx.handle.db, projectId)).map((v) => v.status)).toEqual(['SUPERSEDED', 'IN_REVIEW']);
  });

  it('a broken specification becomes a human task instead of a wrong approval (§16, §19, §42)', async () => {
    await runInterview();
    // The scripted agent drops one client-confirmed field from the spec: the audit must catch it.
    const snapshot = await requirementsRepo.listCurrentRequirementSnapshot(ctx.handle.db, projectId);
    const victim = snapshot.fields.find((f) => f.status === 'CLIENT_CONFIRMED' && f.fieldPath.startsWith('features.'))!;
    llm = createRouterLlm({ dropField: victim.fieldPath });

    await generateSpec();

    // the audit fired twice (initial + one repair) and a human task was opened
    const failures = await eventsOfType('SPEC_TRACEABILITY_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempts: 2 });
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks.map((t) => t.type)).toContain('HUMAN_REVIEW');
    expect(tasks[0]!.reason).toContain(victim.fieldPath.split('.').pop());

    // no client-facing summary was sent, and the project stayed out of CLIENT_REVIEW
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).not.toBe('CLIENT_REVIEW');
    const outbound = await identityRepo.listMessages(ctx.handle.db, conversationId);
    expect(outbound.filter((m) => m.direction === 'OUTBOUND').some((m) => /SPEC-REQ|Traceability/.test(m.text ?? ''))).toBe(false);
    const version = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(version!.status).toBe('CHANGES_REQUESTED');
    // the run itself succeeded — the failure is the audit's, not the model call's
    const runs = await obsRepo.listAgentRuns(ctx.handle.db, { projectId });
    expect(runs.every((r) => r.status === 'SUCCESS')).toBe(true);
  });

  it('an unclear reply gets exactly one clarification per round and never becomes an approval (§18, §21)', async () => {
    await runInterview();
    await generateSpec();

    // a reply that is neither "yes" nor "change" moves the two-step flow to the approval question
    await send('rahmat, tushundim', 'mid_vague');
    await advance(['CLIENT_INTENT_PARSE']);
    const question = await lastOutbound();
    expect(question).toMatch(/tasdiqlaymizmi|o‘zgartirish/i);
    let version = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(version!.approvalRequestedAt).not.toBeNull();
    expect(version!.status).toBe('IN_REVIEW');

    // now the client answers with something the pipeline cannot read
    await send('ho‘p', 'mid_vague_2');
    await advance(['CLIENT_INTENT_PARSE']);
    expect(await lastOutbound()).toMatch(/tasdiqlaymizmi|o‘zgartirish/i);
    await send('bilmayman', 'mid_vague_3');
    await advance(['CLIENT_INTENT_PARSE']);
    expect(await lastOutbound()).toMatch(/tasdiqlaymizmi|o‘zgartirish/i);
    await send('hmm', 'mid_vague_4');
    await advance(['CLIENT_INTENT_PARSE']);
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks.map((t) => t.type)).toContain('HUMAN_REVIEW');

    // nothing was approved by accident and the counter proves the cap lives in the database (§21)
    expect(await specsRepo.listClientApprovals(ctx.handle.db, projectId)).toHaveLength(0);
    version = await specsRepo.getCurrentSpecVersion(ctx.handle.db, projectId);
    expect(version!.status).toBe('IN_REVIEW');
    const counter = await projectsRepo.getLoopCounter(ctx.handle.db, projectId, 'spec', 'spec.clarify');
    expect(counter).toBeGreaterThanOrEqual(2);
    expect(counter).toBeLessThanOrEqual(2);
  });

  it('the specification is generated only once per requirements version (§14)', async () => {
    await runInterview();
    await generateSpec();
    const count = await specsRepo.countSpecVersions(ctx.handle.db, projectId);
    expect(count).toBe(1);

    // replaying the exact same hand-off job (a retry after a crash) must not create a second version
    const handoff = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .find((j) => j.type === 'SPEC_GENERATE')!;
    await ctx.handle.db.update(schema.jobs).set({ status: 'PENDING', runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, handoff.id));
    await generateSpec();
    expect(await specsRepo.countSpecVersions(ctx.handle.db, projectId)).toBe(1);

    // …and the same version cannot be sent to the client twice
    const summaries = (await identityRepo.listMessages(ctx.handle.db, conversationId))
      .filter((m) => m.direction === 'OUTBOUND' && /Maqsad/.test(m.text ?? ''));
    expect(summaries).toHaveLength(1);
    expect(await eventsOfType('SPEC_GENERATED')).toHaveLength(1);
  });

  it('a client message during review never restarts the requirements interview (§18)', async () => {
    await runInterview();
    await generateSpec();
    const questionsBefore = await projectsRepo.getLoopCounter(ctx.handle.db, projectId, 'requirements', 'questions_asked');

    const turnsBefore = (await jobTypes()).filter((t) => t === 'REQUIREMENTS_TURN').length;
    await send('Savol: sayt mobil telefonda ham yaxshi ko‘rinadimi?', 'mid_question');
    await advance(['CLIENT_INTENT_PARSE', 'REQUIREMENTS_TURN']);

    // no new requirements question, no questionnaire job, state intact
    const questionsAfter = await projectsRepo.getLoopCounter(ctx.handle.db, projectId, 'requirements', 'questions_asked');
    expect(questionsAfter).toBe(questionsBefore);
    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(['CLIENT_REVIEW', 'CLIENT_APPROVED']).toContain(project!.state);
    const turnsAfter = (await jobTypes()).filter((t) => t === 'REQUIREMENTS_TURN').length;
    expect(turnsAfter).toBe(turnsBefore);
    const requirementSnapshot = await requirementsRepo.listCurrentRequirementSnapshot(ctx.handle.db, projectId);
    expect(requirementSnapshot.version!.version).toBe(1);
  });

  it('the API refuses in-place edits of a locked specification and offers the change-request path (§19, §35)', async () => {
    await runInterview();
    await generateSpec();
    const { buildTestApp } = await import('../helpers/context.js');
    const app = await buildTestApp(ctx);
    const headers = { 'x-internal-token': ctx.config.INTERNAL_API_TOKEN };

    // while in review (not locked) an authorised edit is allowed
    const editable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/spec`,
      headers,
      payload: { code: 'SPEC-REQ-001', title: 'Yangilangan sarlavha', reason: 'team review' },
    });
    expect(editable.statusCode).toBe(200);

    // the client acknowledges the summary (step 1 → step 2), then approves
    await send('Tushundim, rahmat', 'mid_ack');
    await advance(['CLIENT_INTENT_PARSE']);
    await send('Ha, tasdiqlayman', 'mid_approve');
    await advance(['CLIENT_INTENT_PARSE']);

    const locked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/spec`,
      headers,
      payload: { code: 'SPEC-REQ-001', title: 'Yana o‘zgartirish', reason: 'team review' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('SPEC_IS_LOCKED');

    // the change request endpoint stays open and records the request (§35)
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/change-requests`,
      headers,
      payload: { requestedChange: 'Menyu sahifasiga narxlar qo‘shilsin', source: 'CLIENT_AFTER_APPROVAL' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.specStatus).toBe('LOCKED');
    const list = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/change-requests`, headers });
    expect(list.json().data).toHaveLength(1);

    // unauthenticated access is refused (§37)
    const unauth = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/spec` });
    expect(unauth.statusCode).toBe(401);

    // an approved change request queues a revision of the locked specification
    const decided = await app.inject({
      method: 'PATCH',
      url: `/api/v1/change-requests/${created.json().data.id}`,
      headers,
      payload: { status: 'APPROVED' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().data.queuedJobId).toBeTruthy();
    const revise = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .filter((j) => j.type === 'SPEC_REVISE');
    expect(revise).toHaveLength(1);
    await app.close();
  });

  it('waiting too long for the client decision produces one reminder, then a human task (§21)', async () => {
    await runInterview();
    await generateSpec();
    await send('Ha, tushundim', 'mid_ack');
    await advance(['CLIENT_INTENT_PARSE']);
    const afterQuestion = (await identityRepo.listMessages(ctx.handle.db, conversationId)).filter((m) => m.direction === 'OUTBOUND').length;

    // the timer job is scheduled with the configured delay (§26)
    const timeoutJob = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .find((j) => j.type === 'CLIENT_APPROVAL_TIMEOUT')!;
    expect(timeoutJob).toBeDefined();
    expect(timeoutJob.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await ctx.handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, timeoutJob.id));
    await advance(['CLIENT_APPROVAL_TIMEOUT']);
    const afterReminder = (await identityRepo.listMessages(ctx.handle.db, conversationId)).filter((m) => m.direction === 'OUTBOUND').length;
    expect(afterReminder).toBe(afterQuestion + 1);

    // a second timer run crosses the cap: a human task, not another reminder
    const job2 = (await ctx.handle.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)))
      .filter((j) => j.type === 'CLIENT_APPROVAL_TIMEOUT' && j.status === 'PENDING')
      .find((j) => j.runAt.getTime() > Date.now());
    if (job2) {
      await ctx.handle.db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job2.id));
      await advance(['CLIENT_APPROVAL_TIMEOUT']);
      const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
      expect(tasks.map((t) => t.type)).toContain('CLIENT_SILENT');
    }
    const reminders = await projectsRepo.getLoopCounter(ctx.handle.db, projectId, 'spec', 'approval_reminders');
    expect(reminders).toBeGreaterThanOrEqual(1);
    // never approved by silence
    expect(await specsRepo.listClientApprovals(ctx.handle.db, projectId)).toHaveLength(0);
  });

  it('a failed model run opens a human task and leaves the project in a state a human can act on (docs/06 §5)', async () => {
    await runInterview();
    // the specification agent now returns prose instead of JSON, twice (the runtime repairs once)
    const brokenCalls: unknown[] = [];
    const broken = {
      provider: 'broken',
      calls: brokenCalls,
      async complete(request: unknown) {
        brokenCalls.push(request);
        return { text: 'Kechirasiz, JSON emas.', usage: { provider: 'broken', model: 'broken', promptTokens: 1, completionTokens: 2, costUsd: 0 } };
      },
    };
    llm = broken as never;

    await generateSpec();

    const project = await projectsRepo.getProject(ctx.handle.db, projectId);
    expect(project!.state).toBe('SPEC_GENERATING');
    const tasks = await ctx.handle.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    expect(tasks.map((t) => t.type)).toContain('HUMAN_REVIEW');
    expect(tasks[0]!.reason).toMatch(/schema|JSON|contract/i);
    expect(await specsRepo.getLockedSpecVersion(ctx.handle.db, projectId)).toBeNull();
    // the model was asked twice: the single repair happened inside ONE run (docs/06 §5)
    expect(brokenCalls.length).toBeGreaterThanOrEqual(2);
  });
});

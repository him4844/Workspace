/**
 * Phase 3 acceptance demo (docs/phases/03_phase3_specification_and_client_approval.md):
 *
 *   1. the Phase-2 interview runs to REQUIREMENTS_COMPLETE (§7, §10)
 *   2. the hand-off job (T06) starts the Specification Agent (§14)
 *   3. the agent emits the Technical Specification AND the Client Summary from ONE object (§19)
 *   4. deterministic audits check traceability (§16) and testability (§17) before anything is sent
 *   5. the client gets the summary (step 1 of the two-step approval, §18)
 *   6. the client replies → the explicit approval question is sent (step 2)
 *   7. the client asks for a change → v2 is generated, v1 stays stored (§34)
 *   8. the client approves v2 → the version is LOCKED and can never be edited again (§19)
 *   9. an edit attempt against the locked version is refused; a Change Request is the only door (§35)
 *
 * Everything runs through the real pipeline: ingestion → queue → orchestrator → agents →
 * audit → persistence → state machine. Only the provider call is scripted, so the demo needs no key
 * and costs nothing — and it is repeatable (the database is in-memory).
 *
 * Usage: npm run simulate:phase3
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  applyMigrations, artifactsRepo, createDb, identityRepo, obsRepo, orgRepo, projectsRepo,
  queueRepo, requirementsRepo, schema, seedConfigFromFiles, specsRepo,
} from '@wpp/db';
import { createLogger, loadConfig, readArtifact } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { createPipelineLlm, RESTAURANT_PERSONA, isSpecTask, readPrompt } from '@wpp/testing';
import { assertSpecWritable } from '@wpp/core';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../apps/api/src/services/context.js';

// Scripted runs are explicit about it: the provider decision lives in config, not in hope. A demo
// must never hit a paid/free-tier provider by accident because the developer's .env says so.
const config = { ...loadConfig(), LLM_PROVIDER: 'scripted' as const };
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger(config.LOG_LEVEL === 'silent' ? 'silent' : 'warn');
const artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-phase3-'));

const orgId = await orgRepo.getOrCreateDefaultOrg(db);
const seeded = await seedConfigFromFiles(db, orgId, { configDir: 'config', env: {} });
const connection = await getConnectionForChannel(db, 'SIMULATOR');
const llm = createPipelineLlm();
const sender = 'igsid_phase3_demo';

console.log('=== 0. Config seeded from config/ (the reviewable source of truth) ===');
console.log(`questionnaires: ${seeded.questionnaires.join(' | ')}`);
console.log(`agent configs:  ${seeded.agentConfigs.join(' | ')}`);
console.log(`config values:  ${seeded.configValues} keys`);
if (seeded.questionnaireProblems.length > 0) {
  console.error('questionnaire problems:', seeded.questionnaireProblems);
  process.exitCode = 1;
}

async function clientSays(text: string, mid: string) {
  const payload = buildSimulatorPayload({ accountId: connection.id, senderId: sender, text, mid });
  const [event] = parseInstagramWebhook(payload as never);
  return ingestInboundEvent(db, {
    orgId,
    connectionId: connection.id,
    channel: 'SIMULATOR',
    event: event!,
    turnJobType: 'REQUIREMENTS_TURN',
    // the API routes a review-stage reply to the intent classifier by project state (§18)
    turnJobTypeByState: {
      CLIENT_REVIEW: 'CLIENT_INTENT_PARSE',
      CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE',
      CLIENT_APPROVED: 'CLIENT_INTENT_PARSE',
    },
  });
}

async function tickAll(maxJobs = 25) {
  return tick({ db, config, logger, workerId: 'demo-worker', llm, artifactsRoot }, { maxJobs });
}

/** Run to quiescence, pulling deliberately deferred jobs forward (a human would just wait). */
async function advance(types = ['REQUIREMENTS_TURN', 'CLIENT_INTENT_PARSE', 'SPEC_GENERATE', 'SPEC_REVISE', 'CLIENT_APPROVAL_TIMEOUT']) {
  for (let i = 0; i < 200; i += 1) {
    const { empty } = await tickAll(1);
    if (!empty) continue;
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.status, 'PENDING'));
    const future = rows.filter((row) => types.includes(row.type) && row.runAt.getTime() > Date.now() + 200);
    if (future.length === 0) return;
    for (const job of future) {
      await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job.id));
    }
  }
}

/** Step 1 of this demo is the Phase-2 journey: keep the Phase-3 hand-off parked until step 2. */
async function parkSpecJobs(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, 'PENDING'), eq(schema.jobs.type, 'SPEC_GENERATE')));
  for (const job of rows) {
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.jobs.id, job.id));
  }
}

const lastOutbound = async (conversationId: string) => {
  const messages = await identityRepo.listMessages(db, conversationId, { limit: 400 });
  return messages.filter((m) => m.direction === 'OUTBOUND').at(-1)?.text ?? '';
};

// ---------------------------------------------------------------- 1. requirements interview
console.log('\n=== 1. Phase 2 interview (one question per turn) ===');
const first = await clientSays('Salom! Osh Baraka restorani uchun sayt kerak', 'p3_mid_0');
await advance();
const conversationId = first.conversationId;
const projectId = (await projectsRepo.findOpenProjectForConversation(db, conversationId))!.id;
console.log(`project ${projectId} state=${(await projectsRepo.getProject(db, projectId))!.state}`);

let turn = 0;
for (let i = 0; i < 60; i += 1) {
  const project = await projectsRepo.getProject(db, projectId);
  if (project!.state !== 'REQUIREMENTS_IN_PROGRESS') break;
  // The question is human-readable prose; which field is open comes from the database, not from
  // the sentence (§10A + D-028 — the same thing the WhatsApp-style console shows as "so‘ralmoqda").
  const version = await requirementsRepo.getCurrentRequirementVersion(db, projectId);
  const fieldPath = version?.pendingFieldPath ?? 'unknown';
  const answer = RESTAURANT_PERSONA[fieldPath] ?? 'Ha, shunday bo‘lsin';
  const answerText = Array.isArray(answer) ? answer.join(', ') : String(answer);
  turn += 1;
  await clientSays(`${fieldPath}: ${answerText}`, `p3_mid_${turn}`);
  await advance(['REQUIREMENTS_TURN']);
  await parkSpecJobs();
}
await advance();
await parkSpecJobs();
const requirements = await requirementsRepo.listCurrentRequirementSnapshot(db, projectId);
console.log(`turns=${turn}  state=${(await projectsRepo.getProject(db, projectId))!.state}  completeness=${Number(requirements.version!.completeness) * 100}%`);

// ---------------------------------------------------------------- 2. specification generation
console.log('\n=== 2. Hand-off (T06) and specification generation (§14–§17) ===');
await advance(['SPEC_GENERATE']);
const version = await specsRepo.getCurrentSpecVersion(db, projectId);
if (!version) {
  console.error('no specification was generated');
  process.exitCode = 1;
} else {
  const storedRequirements = await specsRepo.listSpecRequirements(db, version.id);
  const criteria = await specsRepo.listAcceptanceCriteria(db, version.id);
  console.log(`spec v${version.version} status=${version.status}  SPEC-REQ: ${storedRequirements.length}  AC: ${criteria.length} (testable: ${criteria.filter((c) => c.testable).length})`);

  const clientTruth = requirements.fields.filter((f) => f.status === 'CLIENT_CONFIRMED' || f.status === 'CLIENT_APPROVED_DEFAULT');
  const covered = new Set(storedRequirements.map((r) => r.originReqField));
  const uncovered = clientTruth.filter((f) => !covered.has(f.fieldPath));
  console.log(`traceability (§16): ${clientTruth.length - uncovered.length}/${clientTruth.length} client-confirmed fields implemented by a SPEC-REQ`);
  if (uncovered.length > 0) console.log(`  missing: ${uncovered.map((f) => f.fieldPath).join(', ')}`);
  const specArtifact = await artifactsRepo.getArtifact(db, version.specArtifactId!);
  console.log(`artifact: ${specArtifact!.path} sha256=${specArtifact!.sha256.slice(0, 16)}… (${specArtifact!.sizeBytes}B)`);
  const transitions = (await projectsRepo.listTransitions(db, projectId)).map((t) => t.transitionId);
  console.log(`transitions: ${transitions.join(' → ')}`);
}

// ---------------------------------------------------------------- 3. step 1: the client summary
console.log('\n=== 3. Step 1 of the two-step approval: the Client Summary (§18) ===');
const summaryMessage = await lastOutbound(conversationId);
console.log(summaryMessage.split('\n').slice(0, 14).join('\n'));
console.log(`\n  … (${summaryMessage.length} chars, no approval question yet — that is step 2)`);

// ---------------------------------------------------------------- 4. step 2 + change request
console.log('\n=== 4. The client replies → step 2 sends the explicit approval question ===');
await clientSays('Tushundim, rahmat', 'p3_mid_ack');
await advance(['CLIENT_INTENT_PARSE']);
console.log((await lastOutbound(conversationId)).split('\n').join('\n'));

console.log('\n=== 5. The client asks for a change → v2, v1 preserved (§34) ===');
await clientSays('Menyu sahifasida narxlar ham ko‘rinsin, o‘zgartirish kerak', 'p3_mid_change');
await advance(['CLIENT_INTENT_PARSE', 'SPEC_REVISE']);
const versions = await specsRepo.listSpecVersions(db, projectId);
for (const v of versions) {
  const count = (await specsRepo.listSpecRequirements(db, v.id)).length;
  console.log(`  v${v.version}  status=${v.status.padEnd(10)} SPEC-REQ=${count}  change="${(v.changeRequestText ?? '').slice(0, 48)}"`);
}
const v2 = versions.find((v) => v.version === 2);
if (v2) {
  const v2Requirements = await specsRepo.listSpecRequirements(db, v2.id);
  const touched = v2Requirements.find((r) => /narx/i.test(r.description));
  console.log(`  the client's words are in the spec, not only in the chat: "${(touched?.description ?? 'NOT FOUND').slice(0, 90)}…"`);
  console.log(`  v2 sent to the client for a new approval round: ${v2.summarySentAt ? 'yes' : 'no'}`);
}

// ---------------------------------------------------------------- 6. approval + lock
console.log('\n=== 6. The client approves v2 → LOCKED (§19) ===');
await clientSays('Ho‘p, tushundim', 'p3_mid_ack2');
await advance(['CLIENT_INTENT_PARSE']);
await clientSays('Ha, tasdiqlayman', 'p3_mid_approve');
await advance(['CLIENT_INTENT_PARSE', 'CLIENT_APPROVAL_TIMEOUT']);
const locked = await specsRepo.getLockedSpecVersion(db, projectId);
console.log(`locked version: v${locked?.version}  lockedAt=${locked?.lockedAt?.toISOString()}`);
const approvals = await specsRepo.listClientApprovals(db, projectId);
for (const approval of approvals) {
  console.log(`  approval: ${approval.decision}  source=client message ${approval.sourceMessageId}  confidence=${Number(approval.confidence)}  via=${approval.classification}`);
}
console.log(`project state: ${(await projectsRepo.getProject(db, projectId))!.state}`);

// ---------------------------------------------------------------- 7. the lock really locks
console.log('\n=== 7. §19/§35: the approved version can no longer be edited ===');
const editable = assertSpecWritable(locked?.status ?? 'DRAFT');
console.log(`PATCH /api/v1/projects/:id/spec  →  ${editable.ok ? '200 (allowed)' : `409 ${editable.code} — "${editable.message}"`}`);
const changeRequest = await specsRepo.createChangeRequest(db, {
  orgId,
  projectId,
  specVersionId: locked?.id ?? null,
  requestedChange: 'Menyu sahifasiga narxlar qo‘shilsin',
  source: 'CLIENT_AFTER_APPROVAL',
});
await obsRepo.recordEvent(db, {
  orgId,
  projectId,
  type: 'CHANGE_REQUEST',
  actorType: 'HUMAN',
  payload: { changeRequestId: changeRequest.id, specLocked: true, requestedChange: changeRequest.requestedChange },
});
console.log(`POST /api/v1/projects/:id/change-requests → 201 ${changeRequest.id} (status ${changeRequest.status})`);
console.log('  an approved Change Request queues SPEC_REVISE — a new version, never an edit of v2');

// ---------------------------------------------------------------- 8. audit trail
console.log('\n=== 8. Audit trail ===');
const events = await obsRepo.listEvents(db, projectId, 2000);
const counts = new Map<string, number>();
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
const interesting = ['SPEC_GENERATED', 'SPEC_LOCKED', 'APPROVAL_RECORDED', 'CHANGE_REQUEST', 'SPEC_TRACEABILITY_FAILED', 'MESSAGE_OUTBOUND'];
console.log(`events: ${interesting.map((t) => `${t}×${counts.get(t) ?? 0}`).join(', ')}`);
const runs = await obsRepo.listAgentRuns(db, { projectId });
console.log(`agent runs: ${runs.length} (${runs.filter((r) => r.status === 'SUCCESS').length} success, ${runs.filter((r) => r.agentType === 'SPECIFICATION').length} of them SPECIFICATION)`);
console.log(`jobs: ${JSON.stringify(await queueRepo.jobStats(db))}`);
console.log(`open human tasks: ${(await obsRepo.listOpenTasks(db, projectId)).length}`);
const specCalls = llm.calls.filter((call) => isSpecTask(readPrompt(call).task));
console.log(`LLM calls: ${llm.calls.length} total, ${specCalls.length} specification/intent`);

rmSync(artifactsRoot, { recursive: true, force: true });
console.log('\nDONE — specification generated, audited, approved by the client, locked and versioned.');
await handle.close();

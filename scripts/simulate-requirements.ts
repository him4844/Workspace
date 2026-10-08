/**
 * Phase 2 acceptance demo (docs/phases/02_phase2_requirements_agent.md):
 *
 *   1. a restaurant owner writes one DM
 *   2. the planner + Requirements Agent run the whole interview (one question per turn)
 *   3. the completeness engine decides when requirements are complete — not the model
 *   4. the internal requirements summary is written as an artifact, ready for Phase 3
 *
 * Everything runs through the real pipeline (ingestion → queue → orchestrator → agent →
 * persistence → state machine). Only the provider call is replaced by the scripted client,
 * so the demo needs no API key. The database is in-memory — safe to run any number of times.
 *
 * Usage: npm run simulate:requirements
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  applyMigrations, artifactsRepo, createDb, identityRepo, obsRepo, orgRepo, projectsRepo,
  queueRepo, requirementsRepo, schema, seedConfigFromFiles,
} from '@wpp/db';
import { createLogger, loadConfig, readArtifact } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { createPersonaLlm, RESTAURANT_PERSONA } from '@wpp/testing';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../apps/api/src/services/context.js';

const config = loadConfig();
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger(config.LOG_LEVEL === 'silent' ? 'silent' : 'warn');
const artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-demo-'));

const orgId = await orgRepo.getOrCreateDefaultOrg(db);
const seeded = await seedConfigFromFiles(db, orgId, { configDir: 'config', env: {} });
const connection = await getConnectionForChannel(db, 'SIMULATOR');
const llm = createPersonaLlm();

console.log('=== 0. Config seeded from config/ (the reviewable source of truth) ===');
console.log(`questionnaires: ${seeded.questionnaires.join(' | ')}`);
console.log(`agent configs:  ${seeded.agentConfigs.join(' | ')}`);
console.log(`config values:  ${seeded.configValues} keys`);
if (seeded.questionnaireProblems.length > 0) {
  console.error('questionnaire problems:', seeded.questionnaireProblems);
  process.exitCode = 1;
}

async function clientSays(text: string, mid: string) {
  const payload = buildSimulatorPayload({ accountId: connection.id, senderId: 'igsid_demo_restaurant', text, mid });
  const [event] = parseInstagramWebhook(payload as never);
  return ingestInboundEvent(db, {
    orgId,
    connectionId: connection.id,
    channel: 'SIMULATOR',
    event: event!,
    turnJobType: 'REQUIREMENTS_TURN',
  });
}

async function tickAll() {
  return tick({ db, config, logger, workerId: 'demo-worker', llm, artifactsRoot });
}

/** Pull the deferred resume jobs forward: a human would simply wait the few seconds. */
async function advance() {
  await tickAll();
  for (let i = 0; i < 6; i += 1) {
    const rows = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'PENDING'), eq(schema.jobs.type, 'REQUIREMENTS_TURN')));
    const future = rows.filter((row) => row.runAt.getTime() > Date.now() + 200);
    if (future.length === 0) return;
    for (const job of future) {
      await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job.id));
    }
    await tickAll();
  }
}

console.log('\n=== 1. The client writes one message ===');
const first = await clientSays('Salom! Osh Baraka restorani uchun sayt kerak', 'demo_mid_0');
await advance();
const conversation = await identityRepo.getConversation(db, first.conversationId);
const projectId = (await projectsRepo.findOpenProjectForConversation(db, first.conversationId))!.id;
console.log(`project ${projectId} state=${(await projectsRepo.getProject(db, projectId))!.state} type=${(await projectsRepo.getProject(db, projectId))!.projectType}`);

console.log('\n=== 2. The interview (one question per turn, scripted client answering) ===');
let turn = 0;
for (let i = 0; i < 60; i += 1) {
  await advance();
  const project = await projectsRepo.getProject(db, projectId);
  if (project!.state === 'REQUIREMENTS_COMPLETE') break;
  const messages = await identityRepo.listMessages(db, first.conversationId, { limit: 400 });
  const last = messages.at(-1);
  if (!last || last.direction !== 'OUTBOUND') break;
  turn += 1;
  const fieldPath = /([a-z_]+(?:\.[a-z_]+)+)\s*:/i.exec(last.text ?? '')?.[1] ?? 'unknown';
  const answer = RESTAURANT_PERSONA[fieldPath] ?? 'Ha, shunday bo‘lsin';
  const answerText = Array.isArray(answer) ? answer.join(', ') : String(answer);
  console.log(`\n  Q${turn} [${fieldPath}]  ${(last.text ?? '').split('\n')[0]}`);
  console.log(`  A${turn}  ${answerText.slice(0, 90)}`);
  await clientSays(`${fieldPath}: ${answerText}`, `demo_mid_${turn}`);
}
await advance();

console.log('\n=== 3. What the completeness engine decided ===');
const project = (await projectsRepo.getProject(db, projectId))!;
const snapshot = await requirementsRepo.listCurrentRequirementSnapshot(db, projectId);
console.log(`state: ${project.state}   project type: ${project.projectType}   turns: ${turn}`);
console.log(`completeness: ${Number(snapshot.version!.completeness) * 100}%   fields: ${snapshot.fields.length}`);
const mandatory = snapshot.fields.filter((f) => f.mandatory);
console.log(`mandatory fields confirmed: ${mandatory.filter((f) => ['CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE'].includes(f.status)).length}/${mandatory.length}`);
console.log('\n  field                                  status            source');
for (const field of snapshot.fields.filter((f) => f.status !== 'EMPTY').slice(0, 40)) {
  console.log(`  ${field.fieldPath.padEnd(38)} ${field.status.padEnd(17)} ${field.sourceMessageId ? 'client message' : '—'}`);
}
const unanswered = snapshot.fields.filter((f) => f.status === 'EMPTY').map((f) => f.fieldPath);
console.log(`\n  never asked / not applicable: ${unanswered.join(', ') || '—'}`);

console.log('\n=== 4. The artifact Phase 3 will consume ===');
const artifact = snapshot.version!.summaryArtifactId
  ? await artifactsRepo.getArtifact(db, snapshot.version!.summaryArtifactId)
  : null;
if (artifact) {
  console.log(`kind=${artifact.kind} sha256=${artifact.sha256.slice(0, 16)}… size=${artifact.sizeBytes}B`);
  console.log('--- first lines of the internal summary ---');
  console.log((readArtifact(artifact.path) ?? '').split('\n').slice(0, 14).join('\n'));
}

console.log('\n=== 5. Audit trail ===');
const transitions = await projectsRepo.listTransitions(db, projectId);
console.log(`transitions: ${transitions.map((t) => `${t.transitionId}(${t.fromState}→${t.toState})`).join(' → ')}`);
const events = await obsRepo.listEvents(db, projectId, 1000);
const counts = new Map<string, number>();
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
console.log(`events: ${[...counts].map(([type, n]) => `${type}×${n}`).join(', ')}`);
const runs = await obsRepo.listAgentRuns(db, { projectId });
const usage = runs.reduce((sum, run) => sum + Number(run.costUsd ?? 0), 0);
const agRunEvents = events.filter((e) => e.type === 'AGENT_RUN_FINISHED');
const repairs = agRunEvents.reduce((n, e) => n + Number((e.payload as { repairCount?: number }).repairCount ?? 0), 0);
console.log(`agent runs: ${runs.length} (${runs.filter((r) => r.status === 'SUCCESS').length} success, repairs: ${repairs})`);
console.log(`llm usage recorded: cost $${usage.toFixed(4)} (scripted provider)`);
console.log(`open human tasks: ${(await obsRepo.listOpenTasks(db, projectId)).length}`);
const jobs = await queueRepo.jobStats(db);
console.log(`jobs: ${JSON.stringify(jobs)}`);

rmSync(artifactsRoot, { recursive: true, force: true });
console.log('\nDONE — the requirements set is complete, persisted and inspectable (npm run inspect for a persisted DB).');
await handle.close();

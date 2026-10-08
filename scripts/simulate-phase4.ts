/**
 * Phase 4 acceptance demo (docs/phases/04_phase4_spec_auditor.md):
 *
 *   1..6 the Phase-2/3 journey runs for real (interview → specification → two-step approval)
 *   7    the client approval enqueues SPEC_AUDIT (T11) — the auditor takes over automatically (§20)
 *   8    deterministic findings + the scripted auditor model are merged; PASS ⇒ T12 READY_FOR_BUILD
 *   9    FAIL with budget left ⇒ T13 → SPEC_REVISE → T34 → re-audit (no client round-trip, §21)
 *   10   FAIL on the last attempt ⇒ T15 BLOCKED + a CRITICAL human task quoting the exact issues (§42)
 *   11   audit trail: audit rows, verdict buckets, checks, artifacts, events
 *
 * Everything runs through the real pipeline (ingestion → queue → orchestrator → agents → audits →
 * persistence → state machine). Only the provider call is scripted, so the demo needs no key, costs
 * nothing and is repeatable (in-memory database).
 *
 * DEMO_AUDIT_MODE selects what the scripted auditor decides (packages/testing/src/spec-persona.ts):
 *   pass | fail-first | fail-all | alignment      (default: pass)
 *
 * Usage: npm run simulate:phase4            # happy path
 *        DEMO_AUDIT_MODE=fail-first npm run simulate:phase4   # one revision then PASS
 *        DEMO_AUDIT_MODE=fail-all   npm run simulate:phase4   # §21 ceiling → BLOCKED + human task
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  applyMigrations, artifactsRepo, auditsRepo, createDb, identityRepo, obsRepo, orgRepo, projectsRepo,
  queueRepo, requirementsRepo, schema, seedConfigFromFiles, specsRepo,
} from '@wpp/db';
import { createLogger, loadConfig, readArtifact } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import {
  createPipelineLlm, RESTAURANT_PERSONA, isAuditTask, isSpecTask, readPrompt, type ScriptedAuditMode,
} from '@wpp/testing';
import { createLlmClient } from '@wpp/agents';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../apps/api/src/services/context.js';

const auditMode = (process.env.DEMO_AUDIT_MODE ?? 'pass') as ScriptedAuditMode;
/**
 * DEMO_LLM=real sends the *specification* and the *audit* calls to the live free-tier route from
 * `.env` while the client persona stays scripted (nothing else about the journey changes). That is
 * the honest way to get a first real audit row: one live audit whose subject is a spec that was
 * generated live too, without waiting for a 20-turn interview against a congested free tier.
 */
const useReal = process.env.DEMO_LLM === 'real';
/**
 * Which legs go live when DEMO_LLM=real:
 *   audit (default) — only SPEC_AUDIT is a real provider call; the journey up to the approved spec
 *                     stays scripted, so Phase 4's own leg is what is being proven.
 *   spec+audit      — SPEC_GENERATE/SPEC_REVISE are live too (needs a live-sized output budget).
 */
const liveLegs = process.env.DEMO_LIVE_LEGS ?? 'audit';
// Scripted runs are explicit about it: the provider decision lives in config, not in hope. A demo
// must never hit a paid/free-tier provider by accident because the developer's .env says so.
const config = useReal ? loadConfig() : { ...loadConfig(), LLM_PROVIDER: 'scripted' as const };
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger((process.env.DEMO_LOG_LEVEL as 'debug' | 'warn' | 'silent' | undefined) ?? (config.LOG_LEVEL === 'silent' ? 'silent' : 'warn'));
const artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-phase4-'));

const orgId = await orgRepo.getOrCreateDefaultOrg(db);
// Live runs seed from the real environment so the recorded agent models are the ones actually sent
// (D-033: a DB row naming a model the route never uses is a trap, not documentation).
const seeded = await seedConfigFromFiles(db, orgId, { configDir: 'config', env: useReal ? process.env : {} });
const connection = await getConnectionForChannel(db, 'SIMULATOR');
const scriptedLlm = createPipelineLlm({ auditMode });
const realRoute = useReal ? createLlmClient(config) : null;
if (useReal && !realRoute) throw new Error('DEMO_LLM=real requires a configured LLM route (LLM_PROVIDER/LLM_API_KEY or LLM_PRESET) in .env');
/** Scripted personas for everything except the two live legs; `calls` keeps the scripted audit trail. */
function makeHybrid(
  scripted: ReturnType<typeof createPipelineLlm>,
  real: NonNullable<ReturnType<typeof createLlmClient>>,
) {
  return {
    provider: `hybrid(${scripted.provider}->${real.defaultProvider})`,
    calls: scripted.calls,
    complete: async (request: Parameters<typeof scripted.complete>[0]) => {
      const task = readPrompt(request).task;
      const live = isAuditTask(task) || (liveLegs.includes('spec') && isSpecTask(task));
      if (live && process.env.DEMO_DEBUG === '1') {
        console.log('REQUEST', JSON.stringify(request.messages.map((m) => [m.role, (m.content ?? '').length])));
        if (isAuditTask(task)) {
          const fs = await import('node:fs');
          fs.writeFileSync('/tmp/audit-request.json', JSON.stringify(request, null, 2));
          console.log('audit request dumped to /tmp/audit-request.json');
        }
      }
      return live ? real.client.complete(request) : scripted.complete(request);
    },
  };
}
const llm = realRoute ? makeHybrid(scriptedLlm, realRoute) : scriptedLlm;
const sender = 'igsid_phase4_demo';
const AUDIT_JOBS = ['REQUIREMENTS_TURN', 'CLIENT_INTENT_PARSE', 'SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT', 'CLIENT_APPROVAL_TIMEOUT'];

console.log('=== 0. Config seeded from config/ (the reviewable source of truth) ===');
console.log(`agent configs: ${seeded.agentConfigs.join(' | ')}`);
console.log(`scripted auditor mode: ${auditMode}`);
if (realRoute) {
  console.log(`LIVE route: writer=${realRoute.defaultProvider}/${realRoute.defaultModel} · auditor=${config.AUDITOR_LLM_PROVIDER ?? '(main route)'}/${config.AUDITOR_LLM_MODEL ?? realRoute.defaultModel}`);
  console.log(`live calls: ${liveLegs.includes('spec') ? 'SPEC_GENERATE/SPEC_REVISE + ' : ''}SPEC_AUDIT (the rest stays scripted)`);
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
    turnJobTypeByState: {
      CLIENT_REVIEW: 'CLIENT_INTENT_PARSE',
      CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE',
      CLIENT_APPROVED: 'CLIENT_INTENT_PARSE',
    },
  });
}

async function tickAll(maxJobs = 25) {
  return tick(
    {
      db, config, logger, workerId: 'demo-worker', llm, artifactsRoot,
      llmRoute: realRoute ? { provider: realRoute.defaultProvider, model: realRoute.defaultModel } : null,
    },
    { maxJobs },
  );
}

async function advance(types = AUDIT_JOBS) {
  for (let i = 0; i < 400; i += 1) {
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

/**
 * Keep ticking until `done()` holds — the honest way to run a LIVE leg: a congested free provider
 * answers a 503, the runtime waits it out and the queue retries with backoff, so the demo must wait
 * on the *pipeline*, not on a stopwatch (measured 2026-10-08: Gemini 503 spikes).
 */
async function advanceUntil(done: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await advance(AUDIT_JOBS);
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
}

async function parkJobs(types: string[]): Promise<void> {
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.status, 'PENDING'));
  for (const job of rows.filter((r) => types.includes(r.type))) {
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.jobs.id, job.id));
  }
}

const outboundCount = async (conversationId: string) =>
  (await identityRepo.listMessages(db, conversationId, { limit: 400 })).filter((m) => m.direction === 'OUTBOUND').length;

// ---------------------------------------------------------------- 1. requirements interview
console.log('\n=== 1. Phase 2 interview (real pipeline, scripted provider) ===');
const first = await clientSays('Salom! Osh Baraka restorani uchun sayt kerak', 'p4_mid_0');
await advance();
const conversationId = first.conversationId;
const projectId = (await projectsRepo.findOpenProjectForConversation(db, conversationId))!.id;
let turn = 0;
for (let i = 0; i < 60; i += 1) {
  const project = await projectsRepo.getProject(db, projectId);
  if (project!.state !== 'REQUIREMENTS_IN_PROGRESS') break;
  const version = await requirementsRepo.getCurrentRequirementVersion(db, projectId);
  const fieldPath = version?.pendingFieldPath ?? 'unknown';
  const answer = RESTAURANT_PERSONA[fieldPath] ?? 'Ha, shunday bo‘lsin';
  turn += 1;
  await clientSays(`${fieldPath}: ${Array.isArray(answer) ? answer.join(', ') : String(answer)}`, `p4_mid_${turn}`);
  await advance(['REQUIREMENTS_TURN']);
  await parkJobs(['SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT']);
}
await advance();
await parkJobs(['SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT']);
const requirements = await requirementsRepo.listCurrentRequirementSnapshot(db, projectId);
console.log(`turns=${turn}  state=${(await projectsRepo.getProject(db, projectId))!.state}  completeness=${Number(requirements.version!.completeness) * 100}%`);

// ---------------------------------------------------------------- 2..6 specification + approval
console.log('\n=== 2. Specification (T06/T07) and the two-step client approval (Phase 3) ===');
const specReady = async () => {
  const version = await specsRepo.getCurrentSpecVersion(db, projectId);
  return Boolean(version && (await specsRepo.listSpecRequirements(db, version.id)).length > 0);
};
await advanceUntil(specReady, 900_000, 'the live specification (SPEC_GENERATE)');
const v1 = await specsRepo.getCurrentSpecVersion(db, projectId);
console.log(`spec v${v1!.version} status=${v1!.status}  SPEC-REQ: ${(await specsRepo.listSpecRequirements(db, v1!.id)).length}`);
await clientSays('Ha, hammasi tushunarli', 'p4_mid_ack');
await advance(['CLIENT_INTENT_PARSE']);
await clientSays('Ha, tasdiqlayman', 'p4_mid_approve');
await advanceUntil(async () => Boolean(await specsRepo.getLockedSpecVersion(db, projectId)), 300_000, 'the client approval (T10)');
const outboundBeforeAudit = await outboundCount(conversationId);
const locked = await specsRepo.getLockedSpecVersion(db, projectId);
console.log(`client approved → v${locked!.version} LOCKED, state=${(await projectsRepo.getProject(db, projectId))!.state}`);

// ---------------------------------------------------------------- 7. the auditor takes over
console.log('\n=== 7. Approval enqueues SPEC_AUDIT → T11, the Spec Auditor runs (§20) ===');
await advanceUntil(async () => (await auditsRepo.listAuditsForProject(db, projectId)).length > 0, Number(process.env.DEMO_LIVE_TIMEOUT_MS ?? 900_000), 'the live audit (SPEC_AUDIT)');
await advance(['SPEC_AUDIT', 'SPEC_REVISE']);
const project = await projectsRepo.getProject(db, projectId);
const audits = (await auditsRepo.listAuditsForProject(db, projectId)).sort((a, b) => a.attempt - b.attempt);
console.log(`audit attempts: ${audits.length}   final state: ${project!.state}`);
for (const audit of audits) {
  const verdict = audit.verdict as {
    status: string; score: number; checks: Record<string, string>; structuralForcedFail: boolean; modelStatus: string;
    missingRequirements: Array<{ code: string }>; ambiguities: Array<{ code: string }>; contradictions: Array<{ code: string }>;
  };
  console.log(
    `  attempt ${audit.attempt}/${audit.maxAttempts}  provider=${audit.provider ?? '?'} model=${audit.model ?? '?'}  ${audit.status}  score=${audit.score}`
    + `  structuralForcedFail=${audit.structuralForcedFail}  modelSaid=${verdict.modelStatus}`
    + `  checks=${Object.entries(verdict.checks).map(([k, v]) => `${k}:${v}`).join(' ')}`,
  );
  if (verdict.missingRequirements.length + verdict.ambiguities.length + verdict.contradictions.length > 0) {
    for (const issue of [...verdict.contradictions, ...verdict.missingRequirements, ...verdict.ambiguities]) {
      console.log(`      [${issue.code}]`);
    }
  }
}
const versionRows = await specsRepo.listSpecVersions(db, projectId);
for (const v of versionRows) {
  console.log(`  spec v${v.version}  status=${v.status.padEnd(10)} change="${(v.changeRequestText ?? '').slice(0, 60).replace(/\n/g, ' ')}"`);
}

// ---------------------------------------------------------------- 8/9/10 the branches
const transitions = (await projectsRepo.listTransitions(db, projectId)).map((t) => t.transitionId);
console.log(`transitions: ${transitions.join(' → ')}`);
const tasks = await obsRepo.listOpenTasks(db, projectId);
if (project!.state === 'READY_FOR_BUILD') {
  console.log('\n=== 8. PASS → T12 READY_FOR_BUILD: the build may start from a locked, audited specification ===');
  const current = await specsRepo.getCurrentSpecVersion(db, projectId);
  console.log(`current spec: v${current!.version} status=${current!.status} (locked = immutable, §34)`);
  console.log(`open human tasks: ${tasks.length}`);
} else if (project!.state === 'BLOCKED') {
  console.log('\n=== 10. FAIL on the last attempt → T15 BLOCKED + human task (§21, §42) ===');
  for (const task of tasks) {
    console.log(`  ${task.priority} ${task.type}: ${task.title}`);
    console.log(`  WHY: ${task.reason.split('\n').slice(0, 3).join(' ')}`);
    console.log(`  issues: ${((task.aiReport as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code).join(', ')}`);
  }
  console.log(`project state: ${project!.state}  blockedFrom=${project!.blockedFrom}`);
} else {
  console.log(`\n=== 9. Loop in progress or unexpected state: ${project!.state} ===`);
}

// ---------------------------------------------------------------- 11. audit trail
console.log('\n=== 11. Audit trail ===');
const events = await obsRepo.listEvents(db, projectId, 2000);
const counts = new Map<string, number>();
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
console.log(`events: ${['SPEC_GENERATED', 'SPEC_LOCKED', 'SPEC_AUDIT_RESULT', 'APPROVAL_RECORDED', 'TASK_CREATED'].map((t) => `${t}×${counts.get(t) ?? 0}`).join(', ')}`);
const auditArtifact = (await db.select().from(schema.artifacts).where(eq(schema.artifacts.projectId, projectId))).find((a) => a.kind === 'spec-audit');
if (auditArtifact) {
  const row = await artifactsRepo.getArtifact(db, auditArtifact.id);
  const md = readArtifact(row!.path) ?? '';
  console.log(`spec-audit artifact: ${row!.path}`);
  console.log(`  ${md.split('\n').filter(Boolean).slice(1, 3).join(' | ')}`);
}
const runs = await obsRepo.listAgentRuns(db, { projectId });
console.log(`agent runs: ${runs.filter((r) => r.agentType === 'SPEC_AUDITOR').length} audit run(s) of ${runs.length} total`);
console.log(`jobs: ${JSON.stringify(await queueRepo.jobStats(db))}`);
console.log(`LLM calls: ${llm.calls.length} total, ${llm.calls.filter((c) => isAuditTask(readPrompt(c).task)).length} audit, ${llm.calls.filter((c) => isSpecTask(readPrompt(c).task)).length} specification`);
console.log(`client messages during the audit loop: ${(await outboundCount(conversationId)) - outboundBeforeAudit} (0 = the loop never wakes the client)`);

rmSync(artifactsRoot, { recursive: true, force: true });
console.log(`\nDONE — spec audit (${auditMode}) → ${(await projectsRepo.getProject(db, projectId))!.state}`);
await handle.close();

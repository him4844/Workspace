/**
 * Prompt-size report for free-tier budgeting (§58 / D-029).
 *
 * Free LLM tiers limit **tokens per minute (TPM)**, and providers reserve `prompt + max_tokens`
 * for every request — a request whose reservation exceeds the budget can never succeed, no matter
 * how long you wait. This script runs the scripted pipeline once (in memory, no network) and
 * reports, per agent task, the estimated prompt size and the reserved tokens, so the numbers a
 * free tier will see are known BEFORE a live run.
 *
 * Usage:  npm run prompt-sizes            (budget defaults to 8000, override with FREE_TPM_BUDGET)
 *         FREE_TPM_BUDGET=16000 npm run prompt-sizes
 *
 * Token estimates are script-aware (Latin ≈4 chars/token, Cyrillic/Greek/Arabic/Hebrew/
 * Devanagari/Thai/astral emoji ≈2, CJK/kana/Hangul ≈1.5 — `estimateTokens`, D-066) and are
 * never lower than the old flat chars/4; treat them as ±20 %.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMigrations, createDb, identityRepo, orgRepo, projectsRepo, schema, seedConfigFromFiles,
} from '@wpp/db';
import { createLogger, loadConfig } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { createPipelineLlm, isAuditTask, readPrompt } from '@wpp/testing';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../apps/api/src/services/context.js';

const BUDGET = Number(process.env.FREE_TPM_BUDGET ?? 8000);

// This is a prompt-measurement script, never a live-model probe. Force the scripted route even if
// the developer's .env contains real keys; the API text and output shape are still assembled for
// the auditor by the production handler and measured exactly.
const loadedConfig = loadConfig();
const config = { ...loadedConfig, LLM_PROVIDER: 'scripted' as const, LLM_FREE_ONLY: true };
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger('silent');
const artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-sizes-'));

const orgId = await orgRepo.getOrCreateDefaultOrg(db);
await seedConfigFromFiles(db, orgId, { configDir: 'config', env: {} });
const connection = await getConnectionForChannel(db, 'SIMULATOR');

interface Sample { task: string; route: string; promptChars: number; maxOutputTokens: number | null }
const samples: Sample[] = [];
const auditRouteLabel = `${loadedConfig.AUDITOR_LLM_PROVIDER ?? 'OpenRouter'} ${loadedConfig.AUDITOR_LLM_MODEL ?? ':free'}`;
const base = createPipelineLlm();
const llm = {
  provider: base.provider,
  async complete(request: Parameters<typeof base.complete>[0]) {
    const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    // The task arrives as the first line of the first user block, e.g. "Produce specification v1 …"
    const firstUser = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const afterTaskHeader = firstUser.includes('[3] TASK SPECIFICATION')
      ? firstUser.slice(firstUser.indexOf('[3] TASK SPECIFICATION') + '[3] TASK SPECIFICATION'.length)
      : firstUser;
    const task = afterTaskHeader.split('\n').find((line) => line.trim().length > 0)?.trim().slice(0, 70) ?? 'unknown';
    const route = isAuditTask(readPrompt(request).task)
      ? `auditor: ${auditRouteLabel} (RPM/RPD; no published TPM)`
      : `writer: ${loadedConfig.LLM_PROVIDER}/${loadedConfig.LLM_MODEL ?? 'preset model'} (reference TPM=${BUDGET})`;
    samples.push({ task, route, promptChars, maxOutputTokens: request.maxOutputTokens ?? null });
    return base.complete(request);
  },
};

const sender = `igsid_sizes_${Date.now().toString(36)}`;
const tickAll = (maxJobs = 1) => tick({ db, config, logger, workerId: 'sizes', llm, artifactsRoot }, { maxJobs });

async function clientSays(text: string, mid: string) {
  const payload = buildSimulatorPayload({ accountId: connection.id, senderId: sender, text, mid });
  const [event] = parseInstagramWebhook(payload as never);
  return ingestInboundEvent(db, {
    orgId, connectionId: connection.id, channel: 'SIMULATOR', event: event!,
    turnJobType: 'REQUIREMENTS_TURN',
    turnJobTypeByState: { CLIENT_REVIEW: 'CLIENT_INTENT_PARSE', CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE', CLIENT_APPROVED: 'CLIENT_INTENT_PARSE' },
  });
}

async function advance(types: string[] = ['REQUIREMENTS_TURN', 'SPEC_GENERATE', 'SPEC_REVISE', 'SPEC_AUDIT', 'CLIENT_INTENT_PARSE']) {
  for (let i = 0; i < 400; i += 1) {
    const { empty } = await tickAll();
    if (!empty) continue;
    const rows = await db.select().from(schema.jobs).where(
      (await import('drizzle-orm')).eq(schema.jobs.status, 'PENDING'),
    );
    const future = rows.filter((row) => types.includes(row.type) && row.runAt.getTime() > Date.now() + 200);
    if (future.length === 0) return;
    const { eq } = await import('drizzle-orm');
    for (const job of future) await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job.id));
  }
}

const convo = () => projectsRepo.listProjects(db, { limit: 1 }).then((rows) => rows[0]?.conversationId ?? null);
const lastOutbound = async () => {
  const c = await convo();
  if (!c) return { text: '', id: null as string | null };
  const messages = await identityRepo.listMessages(db, c, { limit: 400 });
  const last = messages.filter((m) => m.direction === 'OUTBOUND').at(-1);
  return { text: last?.text ?? '', id: last?.id ?? null };
};

// 1. Full interview (scripted client persona answers its own questions, as in simulate:phase3).
await clientSays('Salom, restoran uchun sayt kerak', 'p1');
let turn = 0;
while (turn < 40) {
  await advance(['REQUIREMENTS_TURN', 'SPEC_GENERATE']);
  const project = (await projectsRepo.listProjects(db, { limit: 1 }))[0];
  if (!project || project.state !== 'REQUIREMENTS_IN_PROGRESS') break;
  const last = await lastOutbound();
  const answer = /quick|·/i.test(last.text) ? 'yes' : 'Osh Baraka';
  await clientSays(answer, `a${turn}`);
  turn += 1;
}
// 2. Let the hand-off run: specification v1.
await advance(['SPEC_GENERATE', 'SPEC_REVISE']);
const project = (await projectsRepo.listProjects(db, { limit: 1 }))[0];

// 3. Exercise the two-step approval and SPEC_AUDIT too. The LLM client is still scripted, so this
// measures the real audit prompt/schema and never makes a network call.
if (project?.state === 'CLIENT_REVIEW') {
  const c = await convo();
  await clientSays('Rahmat, tushunarli', 'summary_ack');
  await advance(['CLIENT_INTENT_PARSE']);
  await clientSays('Ha, tasdiqlayman', 'approve');
  await advance(['CLIENT_INTENT_PARSE', 'SPEC_AUDIT', 'SPEC_REVISE']);
  await advance(['SPEC_AUDIT', 'SPEC_REVISE']);
}
const finalProject = (await projectsRepo.listProjects(db, { limit: 1 }))[0];

const byTask = new Map<string, Sample[]>();
for (const s of samples) {
  const key = `${s.route} | ${s.task.replace(/v\d+/g, 'vN').replace(/\d+/g, 'N').slice(0, 46)}`;
  byTask.set(key, [...(byTask.get(key) ?? []), s]);
}

console.log(`project state after run: ${finalProject?.state}   LLM calls measured: ${samples.length}   TPM reference for writer: ${BUDGET}\n`);
console.log('route + task                                             calls  prompt est   max_out  reserved  verdict');
for (const [task, list] of [...byTask.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const maxPrompt = Math.max(...list.map((s) => Math.round(s.promptChars / 4)));
  const maxOut = Math.max(...list.map((s) => s.maxOutputTokens ?? 0));
  const reserved = maxPrompt + maxOut;
  const isAuditor = task.startsWith('auditor:');
  const verdict = isAuditor
    ? 'measured; route limit is RPM/RPD (TPM unpublished)'
    : 2 * reserved <= BUDGET
      ? 'OK (two calls/min at reference budget)'
      : reserved <= BUDGET
        ? 'one call/min (wait between calls at reference budget)'
        : 'exceeds reference TPM; use this route only if its published tier allows it';
  console.log(`${task.padEnd(58)} ${String(list.length).padStart(5)}  ${String(maxPrompt).padStart(10)}  ${String(maxOut).padStart(8)}  ${String(reserved).padStart(8)}  ${verdict}`);
}
console.log('\nPrompt token estimates are script-aware (±20%, never below the old chars/4 floor); `reserved = prompt + max_tokens`;');
console.log('TPM verdicts are only');
console.log('applied to writer/reference routes. OpenRouter :free has published RPM/RPD limits, not TPM; its');
console.log('auditor prompt is measured here for observability, and the real route must still be probed.');

rmSync(artifactsRoot, { recursive: true, force: true });
await handle.close();

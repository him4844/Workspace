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
 * Token estimates use chars/4 (the same heuristic the provider docs use); treat them as ±20 %.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMigrations, createDb, identityRepo, orgRepo, projectsRepo, schema, seedConfigFromFiles,
} from '@wpp/db';
import { createLogger, loadConfig } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { createPipelineLlm } from '@wpp/testing';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel } from '../apps/api/src/services/context.js';

const BUDGET = Number(process.env.FREE_TPM_BUDGET ?? 8000);

const config = loadConfig();
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger('silent');
const artifactsRoot = mkdtempSync(join(tmpdir(), 'wpp-sizes-'));

const orgId = await orgRepo.getOrCreateDefaultOrg(db);
await seedConfigFromFiles(db, orgId, { configDir: 'config', env: {} });
const connection = await getConnectionForChannel(db, 'SIMULATOR');

interface Sample { task: string; promptChars: number; maxOutputTokens: number | null }
const samples: Sample[] = [];
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
    samples.push({ task, promptChars, maxOutputTokens: request.maxOutputTokens ?? null });
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

async function advance(types: string[] = ['REQUIREMENTS_TURN', 'SPEC_GENERATE', 'CLIENT_INTENT_PARSE']) {
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

const byTask = new Map<string, Sample[]>();
for (const s of samples) {
  const key = s.task.replace(/v\d+/g, 'vN').replace(/\d+/g, 'N').slice(0, 52);
  byTask.set(key, [...(byTask.get(key) ?? []), s]);
}

console.log(`project state after run: ${project?.state}   LLM calls measured: ${samples.length}   budget: ${BUDGET} TPM\n`);
console.log('task (first words of the task block)                     calls  prompt est   max_out  reserved  verdict');
for (const [task, list] of [...byTask.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const maxPrompt = Math.max(...list.map((s) => Math.round(s.promptChars / 4)));
  const maxOut = Math.max(...list.map((s) => s.maxOutputTokens ?? 0));
  const reserved = maxPrompt + maxOut;
  const verdict = 2 * reserved <= BUDGET
    ? 'OK (two calls/min)'
    : reserved <= BUDGET
      ? 'one call/min (wait between calls)'
      : 'NEVER fits — lower max_tokens or generate in chunks';
  console.log(`${task.padEnd(56)} ${String(list.length).padStart(5)}  ${String(maxPrompt).padStart(10)}  ${String(maxOut).padStart(8)}  ${String(reserved).padStart(8)}  ${verdict}`);
}
console.log('\nreserved = provider-side reservation for ONE request (prompt + max_tokens). Provider TPM windows');
console.log('are rolling: `prompt+max_tokens` above the budget means the request is rejected while the window is');
console.log('full. Fix by trimming the prompt or lowering the agent-config maxOutputTokens (config as data, §50).');

rmSync(artifactsRoot, { recursive: true, force: true });
await handle.close();

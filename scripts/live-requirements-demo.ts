/**
 * Live acceptance driver for a running API (docs/13 runbook, Phase 2 acceptance).
 *
 * It talks to the API over HTTP exactly like Instagram would (simulator channel) and like the
 * client would (answering each question), then prints the structured requirements that the
 * inspector endpoint exposes. It never touches the database directly, so it works while the
 * single-process PGlite API holds the data dir (D-022).
 *
 * Usage:
 *   LLM_PROVIDER=scripted npm run dev          # terminal 1
 *   npm run demo:live                          # terminal 2
 */
import { RESTAURANT_PERSONA } from '@wpp/testing';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const SENDER = process.env.DEMO_SENDER_ID ?? 'igsid_live_demo';
const MAX_TURNS = Number(process.env.DEMO_MAX_TURNS ?? 40);
// DEMO_PLAIN=1 → answer like a human in the console (no "field.path: " prefix).
const PLAIN = process.env.DEMO_PLAIN === '1';
const TOKEN = process.env.INTERNAL_API_TOKEN ?? 'dev-internal-token';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN, ...(init?.headers ?? {}) },
  });
  const body = await response.json() as { ok?: boolean; data?: T; error?: unknown };
  if (!response.ok || body.ok === false) {
    throw new Error(`${path} → ${response.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return body.data as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OutboundMessage { id: string; conversationId: string; status: string; text: string | null }

async function waitForOutbound(conversationId: string | null, seen: Set<string>, timeoutMs = 30_000): Promise<OutboundMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await api<{ count: number; messages: OutboundMessage[] }>('/dev/simulator/outbox');
    const fresh = messages.filter((m) => !seen.has(m.id) && m.status === 'SENT'
      && (conversationId === null || m.conversationId === conversationId));
    if (fresh.length > 0) return fresh[fresh.length - 1]!;
    await sleep(1000);
  }
  return null;
}

/**
 * The field the pipeline is currently asking about (`requirement_versions.pending_field_path`),
 * falling back to the first non-confirmed field when the question was already answered.
 */
async function pendingField(projectId: string): Promise<string> {
  const detail = await api<{ requirements: { version: { pendingFieldPath: string | null } | null; fields: Array<{ fieldPath: string; status: string }> } }>(`/dev/simulator/project/${projectId}`);
  const pending = detail.requirements.version?.pendingFieldPath;
  if (pending) return pending;
  const open = detail.requirements.fields.find((f) => ['EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED'].includes(f.status));
  return open?.fieldPath ?? 'unknown';
}

console.log('=== Live requirements interview over HTTP (simulator channel) ===');
const seen = new Set<string>();
const first = await api<{ conversationId: string; projectId: string; projectState: string }>('/dev/simulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ senderId: SENDER, username: 'live_demo_restaurant', text: 'Salom! Osh Baraka restorani uchun sayt kerak' }),
});
console.log(`client → project ${first.projectId}  state=${first.projectState}`);

const conversationId = first.conversationId;
let turn = 0;
while (turn < MAX_TURNS) {
  const question = await waitForOutbound(conversationId, seen, turn === 0 ? 30_000 : 30_000);
  if (!question) {
    console.log('no further question arrived — stopping the driver');
    break;
  }
  seen.add(question.id);
  turn += 1;
  // The question no longer contains the field path (a real model writes human text), so the
  // driver reads the pending field from the inspector instead.
  const fieldPath = await pendingField(first.projectId);
  const answer = RESTAURANT_PERSONA[fieldPath] ?? 'Ha, shunday bo‘lsin';
  const answerText = Array.isArray(answer) ? answer.join(', ') : String(answer);
  console.log(`\n  Q${turn} [${fieldPath}] ${(question.text ?? '').split('\n')[0]}`);
  console.log(`  A${turn} ${answerText.slice(0, 80)}`);

  const requirements = await api<{ state: string; version: { completeness: number } | null }>(`/api/v1/projects/${first.projectId}/requirements`);
  if (requirements.state === 'REQUIREMENTS_COMPLETE') break;

  await api('/dev/simulator/inbound', {
    method: 'POST',
    body: JSON.stringify({ senderId: SENDER, text: PLAIN ? answerText : `${fieldPath}: ${answerText}`, mid: `live_${turn}_${question.id}` }),
  });
  // respect the configured minimum interval between questions (§10 default 8s)
  await sleep(900);
}

const final = await api<{
  state: string; projectType: string;
  version: { completeness: number; summaryArtifactId: string | null } | null;
  fields: Array<{ fieldPath: string; status: string; mandatory: boolean }>;
  contradictions: unknown[];
  summary: { path: string; sha256: string; markdown: string | null } | null;
}>(`/api/v1/projects/${first.projectId}/requirements`);

console.log('\n=== Result (from GET /api/v1/projects/:id/requirements) ===');
console.log(`state: ${final.state}  type: ${final.projectType}  turns: ${turn}`);
console.log(`completeness: ${Number(final.version?.completeness ?? 0) * 100}%  fields: ${final.fields.length}`);
const mandatory = final.fields.filter((f) => f.mandatory);
console.log(`mandatory confirmed: ${mandatory.filter((f) => ['CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE'].includes(f.status)).length}/${mandatory.length}`);
console.log(`open contradictions: ${final.contradictions.length}`);
if (final.summary) {
  console.log(`summary artifact: ${final.summary.path}  sha256=${final.summary.sha256.slice(0, 16)}…`);
  console.log('--- summary (first lines) ---');
  console.log((final.summary.markdown ?? '').split('\n').slice(0, 10).join('\n'));
}
const outbox = await api<{ messages: OutboundMessage[] }>('/dev/simulator/outbox');
console.log(`\noutbound messages: ${outbox.messages.length}`);
console.log('DONE.');

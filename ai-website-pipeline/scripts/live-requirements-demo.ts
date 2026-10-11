/**
 * Live acceptance driver for a running API (docs/13 runbook, Phase 2 acceptance).
 *
 * It talks to the API over HTTP exactly like Instagram would (simulator channel) and like the
 * client would (answering each question), then prints the structured requirements that the
 * inspector endpoint exposes. It never touches the database directly, so it works while the
 * single-process PGlite API holds the data dir (D-022).
 *
 * With DEMO_PHASE4=1 (implies the Phase-3 flow) it also waits for the Spec Auditor that the
 * approval starts automatically and prints the §20 verdict / §21 loop from the API.
 *
 * With DEMO_PHASE3=1 it continues through Phase 3: the client summary, the two-step approval, one
 * change request that produces v2, the approval of v2 and the lock — every step verified over the
 * same HTTP surface a human would use.
 *
 * Usage:
 *   LLM_PROVIDER=scripted npm run dev          # terminal 1
 *   npm run demo:live                          # terminal 2 (DEMO_PHASE3=1 to continue into Phase 3)
 */
import { RESTAURANT_PERSONA } from '@wpp/testing';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const SENDER = process.env.DEMO_SENDER_ID ?? 'igsid_live_demo';
const MAX_TURNS = Number(process.env.DEMO_MAX_TURNS ?? 40);
// DEMO_PLAIN=1 → answer like a human in the console (no "field.path: " prefix).
const PLAIN = process.env.DEMO_PLAIN === '1';
// DEMO_PHASE3=1 → keep going after REQUIREMENTS_COMPLETE: summary → approval → change → v2 → LOCK.
const PHASE3 = process.env.DEMO_PHASE3 === '1';
// DEMO_PHASE4=1 → after the lock, wait for the Spec Auditor (it runs automatically after approval)
// and print the merged verdict, the attempts and any human task the §21 loop opened.
const PHASE4 = process.env.DEMO_PHASE4 === '1';
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

// Free tiers rate-limit per minute (D-029/D-034): a turn may legitimately take ~60 s while the
// provider window refills, so the default wait is generous and tunable with DEMO_TURN_TIMEOUT_MS.
const TURN_TIMEOUT_MS = Number(process.env.DEMO_TURN_TIMEOUT_MS ?? 180_000);
const SPEC_TIMEOUT_MS = Number(process.env.DEMO_SPEC_TIMEOUT_MS ?? 420_000);

async function waitForOutbound(conversationId: string | null, seen: Set<string>, timeoutMs = TURN_TIMEOUT_MS): Promise<OutboundMessage | null> {
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
// A free-tier provider can be busy for minutes (429s, one reservation per minute, a repair call
// after a contract slip). The driver therefore retries the wait instead of giving up after the
// first quiet window — a run that ends early produces no evidence about the pipeline.
const MAX_QUIET_WAITS = Number(process.env.DEMO_QUIET_WAITS ?? 3);
let quietWaits = 0;
while (turn < MAX_TURNS) {
  const question = await waitForOutbound(conversationId, seen);
  if (!question) {
    const project = await api<{ state: string }>(`/api/v1/projects/${first.projectId}/requirements`);
    if (project.state !== 'REQUIREMENTS_IN_PROGRESS') {
      console.log(`interview over (state=${project.state}) after ${turn} turns`);
      break;
    }
    quietWaits += 1;
    if (quietWaits >= MAX_QUIET_WAITS) {
      console.log(`no further question after ${MAX_QUIET_WAITS} waits — stopping the driver`);
      break;
    }
    console.log(`still waiting for the next question (${quietWaits}/${MAX_QUIET_WAITS}, state=${project.state})`);
    continue;
  }
  quietWaits = 0;
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
  // The interview is over as soon as the project leaves the interview state; from here on the
  // pipeline (and Phase 3) owns the conversation, so the driver must not answer anything else.
  if (requirements.state !== 'REQUIREMENTS_IN_PROGRESS') break;

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

if (!PHASE3) {
  console.log('DONE. (set DEMO_PHASE3=1 to continue through the specification and the client approval)');
} else {
  // ---------------------------------------------------------------- Phase 3 over HTTP
  interface SpecView {
    state: string;
    version: { version: number; status: string } | null;
    versions: Array<{ version: number; status: string; changeRequestText: string | null }>;
    requirements: Array<{ code: string; originReqField: string | null; acceptanceCriteria: Array<{ code: string; testable: boolean }> }>;
    approvals: Array<{ decision: string; sourceMessageId: string; confidence: number; classification: string }>;
    changeRequests: Array<{ id: string; requestedChange: string; status: string }>;
    summaryMarkdown: string | null;
    approvalStep: string;
  }
  const specView = () => api<SpecView>(`/api/v1/projects/${first.projectId}/spec`);

  /** Poll the API until the specification reaches the state the step expects (no guessing timings). */
  async function waitForSpec(label: string, predicate: (view: SpecView) => boolean, timeoutMs = SPEC_TIMEOUT_MS): Promise<SpecView> {
    const deadline = Date.now() + timeoutMs;
    let last = await specView();
    while (Date.now() < deadline) {
      if (predicate(last)) return last;
      await sleep(1000);
      last = await specView();
    }
    console.log(`  (${label} did not happen within ${Math.round(timeoutMs / 1000)}s — last state: ${last.version?.status ?? 'none'})`);
    return last;
  }

  async function say(text: string, label: string): Promise<void> {
    await api('/dev/simulator/inbound', { method: 'POST', body: JSON.stringify({ senderId: SENDER, text, mid: `live3_${label}` }) });
  }
  async function lastOutboundText(): Promise<string> {
    const { messages } = await api<{ messages: OutboundMessage[] }>('/dev/simulator/outbox');
    const mine = messages.filter((m) => m.conversationId === conversationId && m.status === 'SENT');
    return mine.at(-1)?.text ?? '';
  }

  console.log('\n=== Phase 3: specification and the two-step client approval ===');

  // Step 1: the specification is generated and the Client Summary is sent (never the technical spec).
  const withSpec = await waitForSpec('specification generation', (view) => Boolean(view.version));
  const withSummary = await waitForSpec('client summary', (view) => view.approvalStep !== 'SEND_SUMMARY');
  console.log(`spec v${withSpec.version?.version} ${withSpec.version?.status}  ·  approval step: ${withSummary.approvalStep}`);
  console.log(`traceability (§16): ${withSummary.requirements.filter((r) => r.originReqField).length}/${withSummary.requirements.length} requirements tied to a client field, ${withSummary.requirements.reduce((n, r) => n + r.acceptanceCriteria.length, 0)} acceptance criteria`);
  console.log('--- step 1: the Client Summary the client received ---');
  console.log((withSummary.summaryMarkdown ?? '').split('\n').slice(0, 12).join('\n'));
  console.log('  (no approval question yet — that is step 2)');

  // Step 2 only happens because the client replied.
  await say('Tushundim, rahmat', 'ack1');
  const asked = await waitForSpec('approval question', (view) => view.approvalStep === 'AWAIT_DECISION');
  console.log(`\n--- step 2: the approval question (step now: ${asked.approvalStep}) ---`);
  console.log(await lastOutboundText());

  // The client asks for a change: v2 is generated, v1 stays stored.
  console.log('\n--- the client asks for a change ---');
  await say('Menyu sahifasida narxlar ham ko‘rinsin, o‘zgartirish kerak', 'change1');
  const v2 = await waitForSpec('specification v2', (view) => view.versions.some((v) => v.version === 2));
  console.log(`versions: ${v2.versions.map((v) => `v${v.version}:${v.status}`).join(', ')}`);
  console.log(`v2 change text: "${(v2.versions.find((v) => v.version === 2)?.changeRequestText ?? '').slice(0, 60)}"`);

  // Approve v2 — the two-step flow asks again for the new version.
  await say('Tushundim', 'ack2');
  await waitForSpec('v2 approval question', (view) => view.approvalStep === 'AWAIT_DECISION');
  await say('Ha, tasdiqlayman', 'approve2');
  const locked = await waitForSpec('the client approval', (view) => view.version?.status === 'LOCKED');

  console.log('\n=== Result (from GET /api/v1/projects/:id/spec) ===');
  console.log(`project state: ${locked.state}`);
  console.log(`versions: ${locked.versions.map((v) => `v${v.version}:${v.status}`).join(', ')}`);
  console.log(`current: v${locked.version?.version} ${locked.version?.status}`);
  console.log(`traceability: ${locked.requirements.filter((r) => r.originReqField).length}/${locked.requirements.length} requirements tied to a client field, AC: ${locked.requirements.reduce((n, r) => n + r.acceptanceCriteria.length, 0)}`);
  for (const approval of locked.approvals) {
    console.log(`approval: ${approval.decision} via ${approval.classification} (${Math.round(approval.confidence * 100)}%) — client message ${approval.sourceMessageId.slice(0, 8)}`);
  }

  console.log('\n--- a locked specification cannot be edited (§19/§35) ---');
  const patch = await fetch(`${BASE}/api/v1/projects/${first.projectId}/spec`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body: JSON.stringify({ code: locked.requirements[0]!.code, title: 'Yangi sarlavha', reason: 'demo' }),
  });
  const patchBody = await patch.json() as { error?: { code?: string; message?: string } };
  console.log(`PATCH /api/v1/projects/:id/spec → ${patch.status} ${patchBody.error?.code ?? ''} — ${patchBody.error?.message ?? ''}`);
  const created = await fetch(`${BASE}/api/v1/projects/${first.projectId}/change-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body: JSON.stringify({ requestedChange: 'Aloqa sahifasiga xarita qo‘shilsin', source: 'CLIENT_AFTER_APPROVAL' }),
  });
  console.log(`POST /api/v1/projects/:id/change-requests → ${created.status}`);
  const after = await specView();
  console.log(`change requests: ${after.changeRequests.map((c) => `${c.status} — ${c.requestedChange.slice(0, 40)}`).join(' | ') || 'none'}`);
  console.log(`\nDev console: ${BASE}/  (Specification panel: version, approval step, traceability, history)`);

  if (PHASE4) {
    // ---------------------------------------------------------------- Phase 4 over HTTP
    interface AuditView {
      state: string;
      blockedFrom: string | null;
      latest: {
        attempt: number; maxAttempts: number; status: string; score: number;
        modelFailed: boolean; structuralForcedFail: boolean; provider: string; model: string;
        issues: Array<{ code: string; severity: string; description: string; specRequirementCode?: string | null; suggestedFix?: string | null }>;
        checks: Record<string, string> | null;
      } | null;
      attempts: Array<{ attempt: number; maxAttempts: number; status: string; score: number; issueCodes: string[]; model: string }>;
      openTasks: Array<{ type: string; priority: string; title: string; reason: string; suggestedAction: string | null }>;
      agentRuns: Array<{ agentType: string; status: string; model: string }>;
    }
    const auditView = () => api<AuditView>(`/api/v1/projects/${first.projectId}/spec-audit`);

    async function waitForAudit(predicate: (view: AuditView) => boolean, timeoutMs = SPEC_TIMEOUT_MS): Promise<AuditView> {
      const deadline = Date.now() + timeoutMs;
      let last = await auditView();
      while (Date.now() < deadline) {
        if (predicate(last)) return last;
        await sleep(1500);
        last = await auditView();
      }
      console.log(`  (no audit verdict within ${Math.round(timeoutMs / 1000)}s — state: ${last.state})`);
      return last;
    }

    console.log('\n=== Phase 4: the Spec Auditor runs on its own route (§20) and the §21 loop resolves ===');
    const audited = await waitForAudit((view) => view.attempts.length > 0 && view.state !== 'CLIENT_APPROVED' && view.state !== 'SPEC_AUDIT');
    console.log(`project state: ${audited.state}${audited.blockedFrom ? ` (blockedFrom=${audited.blockedFrom})` : ''}`);
    for (const attempt of audited.attempts) {
      console.log(`  attempt ${attempt.attempt}/${attempt.maxAttempts}: ${attempt.status} score=${attempt.score} model=${attempt.model} issues=[${attempt.issueCodes.join(', ')}]`);
    }
    if (audited.latest) {
      const l = audited.latest;
      console.log(`latest verdict: ${l.status} · score ${l.score}/100 · forcedByRules=${l.structuralForcedFail} · modelSaidFail=${l.modelFailed}`);
      if (l.checks) console.log(`checks: ${Object.entries(l.checks).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      for (const issue of l.issues.slice(0, 6)) {
        console.log(`  [${issue.severity}] ${issue.code}${issue.specRequirementCode ? ` (${issue.specRequirementCode})` : ''}: ${issue.description.slice(0, 110)}`);
        if (issue.suggestedFix) console.log(`      fix: ${issue.suggestedFix.slice(0, 110)}`);
      }
      console.log(`auditor: ${l.provider}/${l.model} · agent runs: ${audited.agentRuns.map((r) => `${r.agentType}:${r.status}`).join(', ')}`);
    }
    for (const task of audited.openTasks) {
      console.log(`human task (${task.priority} ${task.type}): ${task.title}`);
      console.log(`  WHY: ${task.reason}`);
      if (task.suggestedAction) console.log(`  DO:  ${task.suggestedAction}`);
    }
    console.log(`audit panel: ${BASE}/  ·  GET /api/v1/projects/:id/spec-audit`);
  }

  console.log('DONE — specification generated, approved by the client, locked; changes now need a Change Request.');
}

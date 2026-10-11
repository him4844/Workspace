/**
 * Dev-only console for the simulator channel (Phase 2 demo surface).
 *
 * It is NOT the Phase-7 Team Panel: it is a read/act view over the same simulator endpoints that
 * tests use, so a human can watch the requirements interview live in a browser while the real
 * pipeline (webhook parse → ingestion → queue → worker → agent runtime) runs untouched.
 * Gated by CHANNEL_SIMULATOR_ENABLED — with the simulator off it returns 404 and only the
 * JSON API remains.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  findIdentity, getProject, getArtifact, getConversation,
  listCurrentRequirementSnapshot, listContradictions, listOpenTasks, listMessages,
  projectsRepo, schema, specsRepo,
} from '@wpp/db';
import { assertSpecWritable, deriveApprovalStep } from '@wpp/core';
import { readArtifact } from '@wpp/infra';
import type { AppDeps } from '../app.js';

const PAGE = `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WPP — Requirements simulator console</title>
<style>
 :root{--bg:#0e1116;--panel:#161b22;--line:#262d36;--ink:#e6edf3;--dim:#8b949e;--acc:#3fb950;--client:#1f6feb;--bot:#30363d}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 h1{font-size:15px;margin:0;font-weight:600}
 .tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
 main{display:grid;grid-template-columns:1.15fr .85fr;gap:0;height:calc(100vh - 53px)}
 @media(max-width:900px){main{grid-template-columns:1fr;height:auto}}
 section{padding:14px 18px;overflow:auto}
 section+section{border-left:1px solid var(--line)}
 .msg{margin:8px 0;max-width:88%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
 .in{background:var(--client);margin-left:auto;border-bottom-right-radius:3px}
 .out{background:var(--bot);border-bottom-left-radius:3px}
 .meta{font-size:11px;color:var(--dim);margin:0 4px 2px}
 form{display:flex;gap:8px;padding:10px 18px;border-top:1px solid var(--line);position:sticky;bottom:0;background:var(--bg)}
 input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:10px}
 button{background:var(--acc);color:#08130a;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 td,th{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--dim);font-weight:500}
 .st{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
 .ok{color:var(--acc);border-color:#1f4023}
 .warn{color:#d29922;border-color:#4a3a12}
 .bar{height:7px;background:var(--panel);border-radius:99px;overflow:hidden;margin:6px 0 10px}
 .bar>div{height:100%;background:var(--acc)}
 pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:220px}
 h2{font-size:13px;margin:16px 0 6px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
 a{color:var(--client)}
</style></head>
<body>
<header>
  <h1>Instagram → Requirements Agent</h1>
  <span class="tag" id="state">yuklanmoqda…</span>
  <span class="tag" id="provider"></span>
  <span class="tag"><a href="/healthz">/healthz</a></span>
</header>
<main>
  <div>
    <section style="padding-bottom:0"><h2>Report (client)</h2><div id="chat"></div></section>
    <form id="f"><input id="t" autocomplete="off" placeholder="Mijoz nomidan yozing… (masalan: Restoran uchun sayt kerak)"><button id="b">Yuborish</button></form>
  </div>
  <section>
    <h2>Project state</h2><div id="proj" class="tag">—</div>
    <h2>Completeness</h2><div class="bar"><div id="cbar" style="width:0%"></div></div>
    <div id="ctext" class="tag">—</div>
    <h2>Requirements fields</h2><table id="fields"><tbody></tbody></table>
    <h2>Contradictions</h2><div id="contra" class="tag">—</div>
    <h2>Open human tasks</h2><div id="tasks" class="tag">—</div>
    <h2>Internal summary</h2><pre id="sum">—</pre>
    <h2>Worker / jobs</h2><pre id="jobs">—</pre>
    <h2>Specification (Phase 3)</h2>
    <div class="tag" id="specmeta">—</div>
    <div class="tag">Bosqich: <b id="specstep">—</b></div>
    <div class="tag">Versiya: <b id="specver">—</b></div>
    <div class="tag">Tasdiq: <b id="specappr">—</b></div>
    <div class="tag">Traceability: <b id="spectrace">—</b></div>
    <table id="specreqs"><tbody></tbody></table>
    <h2>Mijozga yuborilgan qisqacha tavsif</h2><pre id="specsum">—</pre>
    <h2>Versiyalar / change requests</h2><pre id="specvers">—</pre><pre id="speccr">—</pre>
  </section>
</main>
<script type="module">
const SENDER = 'igsid_console_demo';
let conversationId = null, projectId = null;
const chat = document.getElementById('chat');

function bubble(direction, text, status){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (direction === 'INBOUND' ? 'in' : 'out');
  wrap.textContent = text || '(empty)';
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = (direction === 'INBOUND' ? 'client' : 'agent') + (status ? ' · ' + status : '');
  const holder = document.createElement('div');
  holder.style.display = 'flex'; holder.style.flexDirection = 'column';
  holder.style.alignItems = direction === 'INBOUND' ? 'flex-end' : 'flex-start';
  holder.append(meta, wrap);
  chat.append(holder);
}

async function post(text){
  const r = await fetch('/dev/simulator/inbound', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({senderId: SENDER, username:'console_demo', text})});
  const body = await r.json();
  if(!body.ok) throw new Error(JSON.stringify(body.error));
  conversationId = body.data.conversationId;
  return body.data;
}

async function refresh(){
  const lookup = await fetch('/dev/simulator/lookup?senderId=' + SENDER).then(r=>r.json());
  if (lookup.data){ conversationId = lookup.data.conversationId; projectId = lookup.data.projectId; }
  const [stats, req] = await Promise.all([
    fetch('/dev/simulator/stats').then(r=>r.json()),
    projectId ? fetch('/dev/simulator/project/' + projectId).then(r=>r.json()) : Promise.resolve(null),
  ]);
  chat.innerHTML = '';
  const msgs = lookup.data?.messages ?? [];
  for (const m of msgs) bubble(m.direction, m.text, m.status);
  if (!msgs.length) chat.innerHTML = '<p class="meta">Hali xabar yo‘q — pastdan birinchi DM ni yuboring.</p>';
  chat.scrollTop = chat.scrollHeight;
  document.getElementById('provider').textContent = 'LLM: ' + (stats.data?.llm ?? 'n/a');
  const jobs = stats.data?.jobs ?? [];
  document.getElementById('jobs').textContent = JSON.stringify({jobs, pendingOutbound: stats.data?.pendingOutbound, conversations: stats.data?.conversations?.length ?? 0}, null, 1);
  if (!req || !req.ok) { document.getElementById('state').textContent = conversationId ? 'conversation: ' + conversationId.slice(0,8) : 'yangi suhbat'; return; }
  const d = req.data;
  projectId = d.project.id;
  document.getElementById('state').textContent = d.project.state;
  document.getElementById('proj').textContent = d.project.id.slice(0,8) + ' · ' + d.project.projectType;
  const c = d.requirements.version ? d.requirements.version.completeness : 0;
  document.getElementById('cbar').style.width = Math.round(c*100) + '%';
  const fields = d.requirements.fields;
  const mand = fields.filter(f=>f.mandatory);
  const done = mand.filter(f=>['CLIENT_CONFIRMED','CLIENT_APPROVED_DEFAULT','NOT_APPLICABLE'].includes(f.status));
  const asking = d.requirements.version?.pendingFieldPath;
  document.getElementById('ctext').textContent = Math.round(c*100) + '% · majburiy: ' + done.length + '/' + mand.length
    + ' · maydonlar: ' + fields.length + (asking ? ' · so\u2018ralmoqda: ' + asking : '');
  document.getElementById('fields').querySelector('tbody').innerHTML = fields.map(f =>
    '<tr><td>' + f.fieldPath + '</td><td><span class="st ' + (['CLIENT_CONFIRMED','CLIENT_APPROVED_DEFAULT','NOT_APPLICABLE'].includes(f.status)?'ok':(f.status==='EMPTY'?'warn':'')) + '">' + f.status + '</span></td><td>' + String(f.value ?? '').slice(0,70) + '</td></tr>').join('');
  document.getElementById('contra').textContent = d.requirements.contradictions.filter(x=>x.status==='OPEN').length + ' ochiq / ' + d.requirements.contradictions.length;
  document.getElementById('tasks').textContent = d.openTasks.length ? d.openTasks.map(t=>t.type + ' — ' + t.title + ' (jarima: ' + t.reason + ')').join(' | ') : 'yo‘q';
  document.getElementById('sum').textContent = d.requirements.summary ? d.requirements.summary.markdown : '—';
  renderSpec(d.specification);
}

const STEP_LABEL = {
  SEND_SUMMARY: '1-qadam: xulosa yuborilishi kerak',
  AWAIT_SUMMARY_ACK: '1-qadam yuborildi — mijoz xulosani o‘qimoqda',
  SEND_APPROVAL_REQUEST: '2-qadam: tasdiq savoli yuborilishi kerak',
  AWAIT_DECISION: '2-qadam yuborildi — mijoz qarori kutilmoqda',
  DECIDED: 'qaror qabul qilindi',
};

function renderSpec(spec){
  const body = document.getElementById('specreqs').querySelector('tbody');
  if(!spec){
    document.getElementById('specmeta').textContent = 'Hali spetsifikatsiya yo‘q — talablar tugagach avtomatik yaratiladi (§14)';
    for (const id of ['specstep','specver','specappr','spectrace','specsum','specvers','speccr']) document.getElementById(id).textContent = '—';
    body.innerHTML = '';
    return;
  }
  document.getElementById('specmeta').textContent =
    'v' + spec.version + ' · ' + spec.status + (spec.editable ? ' (tahrirlash mumkin)' : ' (qulflangan — faqat change request)')
    + (spec.artifact ? ' · sha256 ' + String(spec.artifact.sha256).slice(0,12) + '… ' + spec.artifact.sizeBytes + 'B' : '');
  document.getElementById('specstep').textContent = STEP_LABEL[spec.approvalStep] || spec.approvalStep;
  document.getElementById('specver').textContent =
    'joriy v' + spec.version + ' · jami ' + spec.versions.length
    + (spec.changeRequestText ? ' · o‘zgarish: ' + String(spec.changeRequestText).slice(0,60) : '');
  document.getElementById('specappr').textContent = spec.approvals.length
    ? spec.approvals.map(a => a.decision + ' (' + a.classification + ', ' + Math.round(a.confidence*100) + '%, mijoz xabari ' + String(a.sourceMessageId).slice(0,8) + ')').join(' | ')
    : 'yo‘q';
  document.getElementById('spectrace').textContent =
    spec.requirements.filter(r=>r.originReqField).length + '/' + spec.requirements.length + ' maydon bilan bog‘langan · AC: '
    + spec.requirements.reduce((n,r)=>n+r.acceptanceCriteria.length,0);
  body.innerHTML = spec.requirements.map(r =>
    '<tr><td>' + r.code + '</td><td>' + (r.originReqField || '— (AI)') + '</td><td>' + r.priority + '</td><td>'
    + (r.acceptanceCriteria.map(ac => ac.code + (ac.testable ? '' : ' (testable emas)')).join(', ') || '—') + '</td></tr>').join('');
  document.getElementById('specsum').textContent = spec.summaryMarkdown || '—';
  document.getElementById('specvers').textContent = spec.versions.map(v =>
    'v' + v.version + '  ' + v.status + (v.changeRequestText ? '  ← ' + String(v.changeRequestText).slice(0,50) : '')
    + '  xulosa:' + (v.summarySentAt ? 'yuborilgan' : '—') + '  tasdiq savoli:' + (v.approvalRequestedAt ? 'yuborilgan' : '—')
    + '  qulf:' + (v.lockedAt ? 'LOCKED' : '—')).join('\n');
  document.getElementById('speccr').textContent = spec.changeRequests.length
    ? spec.changeRequests.map(c => c.status + ' — ' + String(c.requestedChange).slice(0,70)).join('\n')
    : 'change request yo‘q';
}

document.getElementById('f').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const input = document.getElementById('t'); const value = input.value.trim(); if(!value) return;
  input.value=''; document.getElementById('b').disabled = true;
  bubble('INBOUND', value);
  try { await post(value); } catch (err){ bubble('OUTBOUND', 'XATO: ' + err.message); }
  document.getElementById('b').disabled = false;
  setTimeout(refresh, 1200);
});

await refresh();
setInterval(refresh, 3000);
</script>
</body></html>`;

export async function registerSimulatorConsoleRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  const gated = (reply: FastifyReply) => {
    if (config.CHANNEL_SIMULATOR_ENABLED) return false;
    void reply.status(404).send({ ok: false, error: { code: 'NOT_AVAILABLE', message: 'simulator channel is disabled' } });
    return true;
  };

  app.get('/', async (_request, reply) => {
    if (!config.CHANNEL_SIMULATOR_ENABLED) {
      return reply.type('text/html').send('<h1>WPP API</h1><p>Running. Enable CHANNEL_SIMULATOR_ENABLED to use the dev console. See <a href="/healthz">/healthz</a>.</p>');
    }
    return reply.type('text/html').send(PAGE);
  });

  /** Everything the console needs to render a project without the internal API token. */
  app.get('/dev/simulator/project/:id', async (request, reply) => {
    if (gated(reply)) return;
    const { id } = request.params as { id: string };
    const project = await getProject(db, id);
    if (!project) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } });

    const [snapshot, contradictions, tasks, conversation] = await Promise.all([
      listCurrentRequirementSnapshot(db, id),
      listContradictions(db, id),
      listOpenTasks(db, id),
      project.conversationId ? getConversation(db, project.conversationId) : Promise.resolve(null),
    ]);
    const summaryArtifact = snapshot.version?.summaryArtifactId ? await getArtifact(db, snapshot.version.summaryArtifactId) : null;

    // Phase 3: the specification side of the project — version, lock, traceability, approvals.
    const specVersions = await specsRepo.listSpecVersions(db, id);
    const currentSpec = specVersions.filter((v) => v.status !== 'SUPERSEDED').at(-1) ?? null;
    const specSnapshot = currentSpec ? await specsRepo.listSpecSnapshot(db, currentSpec.id) : null;
    const specArtifact = currentSpec?.specArtifactId ? await getArtifact(db, currentSpec.specArtifactId) : null;
    const approvals = await specsRepo.listClientApprovals(db, id);
    const changeRequests = await specsRepo.listChangeRequests(db, id);
    const specRequirements = specSnapshot?.requirements ?? [];
    const traceability = specRequirements.map((r) => ({
      code: r.code,
      originReqField: r.originReqField,
      section: r.section,
      title: r.title,
      priority: r.priority,
      acceptanceCriteria: (specSnapshot?.acceptanceCriteria ?? [])
        .filter((ac) => ac.specReqCode === r.code)
        .map((ac) => ({ code: ac.code, text: ac.text, testable: ac.testable })),
    }));

    return reply.send({
      ok: true,
      data: {
        project: { id: project.id, name: project.name, state: project.state, projectType: project.projectType },
        conversation: conversation ? { id: conversation.id, windowExpiresAt: conversation.windowExpiresAt } : null,
        requirements: {
          version: snapshot.version
            ? {
                version: snapshot.version.version,
                completeness: Number(snapshot.version.completeness),
                pendingFieldPath: snapshot.version.pendingFieldPath,
                summaryArtifactId: snapshot.version.summaryArtifactId,
              }
            : null,
          fields: snapshot.fields.map((f) => ({ fieldPath: f.fieldPath, value: f.value, status: f.status, mandatory: f.mandatory })),
          contradictions: contradictions.map((c) => ({ fieldA: c.fieldA, fieldB: c.fieldB, status: c.status, severity: c.severity })),
          summary: summaryArtifact ? { path: summaryArtifact.path, markdown: readArtifact(summaryArtifact.path) } : null,
        },
        specification: currentSpec
          ? {
              version: currentSpec.version,
              status: currentSpec.status,
              editable: assertSpecWritable(currentSpec.status).ok,
              approvalStep: deriveApprovalStep({
                summarySentAt: currentSpec.summarySentAt,
                approvalRequestedAt: currentSpec.approvalRequestedAt,
                decidedAt: currentSpec.status === 'LOCKED' ? currentSpec.lockedAt : null,
              }),
              summarySentAt: currentSpec.summarySentAt,
              approvalRequestedAt: currentSpec.approvalRequestedAt,
              lockedAt: currentSpec.lockedAt,
              changeRequestText: currentSpec.changeRequestText,
              requirements: traceability,
              traceabilityCoverage: specRequirements.length > 0
                ? specRequirements.filter((r) => r.originReqField).length / specRequirements.length
                : 1,
              summaryMarkdown: currentSpec.clientSummaryMd,
              artifact: currentSpec.specArtifactId
                ? { id: currentSpec.specArtifactId, path: specArtifact?.path ?? null, sha256: specArtifact?.sha256 ?? null, sizeBytes: specArtifact?.sizeBytes ?? null }
                : null,
              versions: specVersions.map((v) => ({
                version: v.version,
                status: v.status,
                createdAt: v.createdAt,
                changeRequestText: v.changeRequestText,
                summarySentAt: v.summarySentAt,
                approvalRequestedAt: v.approvalRequestedAt,
                lockedAt: v.lockedAt,
              })),
              approvals: approvals.map((a) => ({
                decision: a.decision, sourceMessageId: a.sourceMessageId, confidence: Number(a.confidence),
                classification: a.classification, changeItems: a.changeItems, createdAt: a.createdAt,
              })),
              changeRequests: changeRequests.map((c) => ({
                id: c.id, requestedChange: c.requestedChange, source: c.source, status: c.status, createdAt: c.createdAt,
              })),
            }
          : null,
        openTasks: tasks.filter((t) => t.status === 'OPEN').map((t) => ({ id: t.id, type: t.type, title: t.title, priority: t.priority, reason: t.reason, createdAt: t.createdAt })),
      },
    });
  });

  /** Resolve the demo sender to its conversation/project so a reload keeps the thread. */
  app.get('/dev/simulator/lookup', async (request, reply) => {
    if (gated(reply)) return;
    const q = request.query as { senderId?: string };
    if (!q.senderId) return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: 'senderId required' } });
    const identity = await findIdentity(db, 'SIMULATOR', q.senderId);
    if (!identity) return reply.send({ ok: true, data: null });
    const conversationRows = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.channel, 'SIMULATOR'), eq(schema.conversations.clientId, identity.clientId)))
      .orderBy(desc(schema.conversations.createdAt))
      .limit(1);
    const conversationId = conversationRows[0]?.id ?? null;
    if (!conversationId) return reply.send({ ok: true, data: null });
    const project = await projectsRepo.findOpenProjectForConversation(db, conversationId);
    const messages = await listMessages(db, conversationId, { limit: 200 });
    return reply.send({
      ok: true,
      data: {
        conversationId,
        projectId: project?.id ?? null,
        messages: messages.map((m) => ({ direction: m.direction, text: m.text, status: m.status })),
      },
    });
  });
}

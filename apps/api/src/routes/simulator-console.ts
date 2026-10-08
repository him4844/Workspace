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
  projectsRepo, schema,
} from '@wpp/db';
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

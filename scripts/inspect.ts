/**
 * Minimal human inspection (COMMON_RULES): print projects, conversations, messages
 * and queue state without touching the database directly.
 * Usage: npm run inspect
 */
import { createDb, getConversation, identityRepo, listProjects, listMessages, obsRepo, queueRepo } from '@wpp/db';
import { loadConfig } from '@wpp/infra';
import { hoursUntilExpiry } from '@wpp/core';

const config = loadConfig();
const handle = await createDb({ dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined });
const db = handle.db;

const projects = await listProjects(db, { limit: 50 });
console.log(`\n=== PROJECTS (${projects.length}) ===`);
for (const p of projects) {
  console.log(`- ${p.id}  [${p.state}]  client=${p.clientId}  created=${p.createdAt.toISOString()}`);
}

const jobs = await queueRepo.jobStats(db);
console.log('\n=== JOBS ===');
for (const row of jobs) console.log(`- ${row.status}: ${row.n}`);

const convs = await identityRepo.conversationOverview(db, { limit: 50 });
console.log(`\n=== CONVERSATIONS (${convs.length}) ===`);
for (const c of convs) {
  const left = hoursUntilExpiry(c.windowExpiresAt);
  console.log(
    `- ${c.conversationId}  channel=${c.channel}  thread=${c.externalThreadId}  msgs=${c.messageCount}  ` +
      `window=${left === null ? 'n/a' : `${left.toFixed(1)}h left`}`,
  );
}

for (const c of convs.slice(0, 5)) {
  const conversation = await getConversation(db, c.conversationId);
  const messages = conversation ? await listMessages(db, conversation.id, { limit: 50 }) : [];
  console.log(`\n--- conversation ${c.conversationId} ---`);
  for (const m of messages) {
    const dir = m.direction === 'INBOUND' ? '<<' : '>>';
    console.log(`${dir} [${m.status}] ${m.text ?? '(no text)'}`);
  }
}

const projectsWithTimeline = projects.slice(0, 3);
for (const p of projectsWithTimeline) {
  const events = await obsRepo.listEvents(db, p.id, 30);
  console.log(`\n=== TIMELINE ${p.id} ===`);
  for (const e of events.reverse()) console.log(`- ${e.createdAt.toISOString()}  ${e.type}  ${JSON.stringify(e.payload)}`);
}

await handle.close();

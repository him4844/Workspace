/**
 * Phase 1 acceptance demo (docs/phases/01_phase1_instagram_and_conversations.md):
 *   1. two different test clients message the pipeline
 *   2. duplicate webhook delivery creates nothing new
 *   3. the worker replies (Phase 1 echo placeholder) through the window guard
 *   4. a client whose 24h window expired gets SEND_BLOCKED + a human task
 * Everything runs through the real ingestion path with the simulator channel.
 *
 * Usage: npm run simulate
 */
import { applyMigrations, createDb, identityRepo, obsRepo, projectsRepo, queueRepo, schema } from '@wpp/db';
import { createLogger, loadConfig } from '@wpp/infra';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { hoursUntilExpiry } from '@wpp/core';
import { tick } from '../apps/worker/src/orchestrator.js';
import { getConnectionForChannel, getDefaultOrgId } from '../apps/api/src/services/context.js';
import { eq } from 'drizzle-orm';

// The demo is self-contained: an in-memory database, so it can be run any number of
// times without touching the developer's data dir (docs/14 §10).
const config = loadConfig();
const handle = await createDb({ memory: true });
await applyMigrations(handle);
const db = handle.db;
const logger = createLogger('silent');

const orgId = await getDefaultOrgId(db);
const connection = await getConnectionForChannel(db, 'SIMULATOR');

async function clientSays(senderId: string, text: string, mid?: string) {
  const payload = buildSimulatorPayload({ accountId: connection.id, senderId, text, mid });
  const [event] = parseInstagramWebhook(payload as never);
  return ingestInboundEvent(db, { orgId, connectionId: connection.id, channel: 'SIMULATOR', event: event! });
}

console.log('=== 1. Two clients send messages ===');
const r1 = await clientSays('igsid_restaurant_owner', 'Salom! Restoranim uchun sayt kerak');
const r2 = await clientSays('igsid_clinic_owner', 'Assalomu alaykum, klinika uchun sayt kerakmi?');
console.log(`client A → project ${r1.projectId} state=${r1.projectState} (created client=${r1.clientCreated}, project=${r1.projectCreated})`);
console.log(`client B → project ${r2.projectId} state=${r2.projectState} (created client=${r2.clientCreated}, project=${r2.projectCreated})`);
console.log(`different conversations: ${r1.conversationId !== r2.conversationId}`);

console.log('\n=== 2. Duplicate webhook replay ===');
const beforeDup = (await identityRepo.listMessages(db, r1.conversationId)).length;
const dup = await clientSays('igsid_restaurant_owner', 'Salom! Restoranim uchun sayt kerak', 'sim_fixed_mid_001');
const dupAgain = await clientSays('igsid_restaurant_owner', 'Salom! Restoranim uchun sayt kerak', 'sim_fixed_mid_001');
const afterDup = (await identityRepo.listMessages(db, r1.conversationId)).length;
console.log(`first delivery duplicate=${dup.duplicate}, replay duplicate=${dupAgain.duplicate} (expected false then true)`);
console.log(`messages for client A: ${beforeDup} → ${afterDup} after the replay (expected +1 then +0)`);

console.log('\n=== 3. Worker processes the queue (echo reply through the window guard) ===');
const before = await queueRepo.jobStats(db);
const tickResult = await tick({ db, config, logger, workerId: 'sim-worker' });
console.log(`jobs before: ${JSON.stringify(before)} | tick: ${JSON.stringify(tickResult)}`);

for (const conversationId of [r1.conversationId, r2.conversationId]) {
  const messages = await identityRepo.listMessages(db, conversationId, { limit: 50 });
  console.log(`\nconversation ${conversationId}:`);
  for (const m of messages) console.log(`  ${m.direction === 'INBOUND' ? '<<' : '>>'} [${m.status}] ${m.text}`);
}

console.log('\n=== 4. Window guard: an expired 24h window blocks the send ===');
const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
await identityRepo.touchInbound(db, r2.conversationId, old, new Date(old.getTime() + 24 * 60 * 60 * 1000));
const { message } = await identityRepo.insertMessage(db, {
  conversationId: r2.conversationId,
  direction: 'OUTBOUND',
  status: 'QUEUED',
  text: 'Narx bo‘yicha taklif: 6 000 000 so‘m (48 soatdan keyin yuborilmoqchi)',
  humanAuthored: true,
});
await queueRepo.enqueueJob(db, {
  orgId, type: 'SEND_OUTBOUND', payload: { messageId: message.id, conversationId: r2.conversationId }, idempotencyKey: `sim:send:${message.id}`,
});
await tick({ db, config, logger, workerId: 'sim-worker' });
const blocked = await db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
const tasks = await obsRepo.listOpenTasks(db, r2.projectId);
console.log(`message status: ${blocked[0]?.status} (expected SEND_BLOCKED)`);
console.log(`human tasks created: ${tasks.length} → ${tasks.map((t) => t.type).join(', ')}`);

console.log('\n=== 5. State machine history ===');
for (const projectId of [r1.projectId, r2.projectId]) {
  const transitions = await projectsRepo.listTransitions(db, projectId);
  console.log(`${projectId}: ${transitions.map((t) => `${t.transitionId}(${t.fromState}→${t.toState})`).join(' → ')}`);
}

console.log('\n=== 6. Final database summary ===');
const [projects, jobs, conversations] = await Promise.all([
  projectsRepo.listProjects(db),
  queueRepo.jobStats(db),
  identityRepo.conversationOverview(db),
]);
console.log(`projects=${projects.length} conversations=${conversations.length}`);
console.log(`jobs=${JSON.stringify(jobs)}`);
for (const c of conversations) {
  console.log(`  ${c.conversationId} channel=${c.channel} msgs=${c.messageCount} window=${hoursUntilExpiry(c.windowExpiresAt)?.toFixed(1)}h`);
}
console.log(`agent runs recorded: ${(await obsRepo.listAgentRuns(db, {})).length}`);
console.log(`\nDONE. (session org=${orgId.slice(0, 8)}…, ids are ephemeral: in-memory database)`);
await handle.close();

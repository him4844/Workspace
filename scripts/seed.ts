/**
 * Seed: organization, initial admin member, channel connections, config defaults
 * (docs/14 §11). Idempotent — safe to run repeatedly.
 */
import { applyMigrations, createDb, channelsRepo, orgRepo, schema } from '@wpp/db';
import { createHash } from 'node:crypto';
import { loadConfig, uuidv7 } from '@wpp/infra';
import { eq } from 'drizzle-orm';

const config = loadConfig();
const handle = await createDb({ dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined });
await applyMigrations(handle);
const db = handle.db;

const orgId = await orgRepo.getOrCreateDefaultOrg(db, config.ORG_NAME);
console.log(`org: ${orgId}`);

// admin member (real password hashing arrives with the Phase 7 auth module)
const email = config.ADMIN_EMAIL;
const existing = await orgRepo.findMemberByEmail(db, email);
if (!existing) {
  await db.insert(schema.teamMembers).values({
    id: uuidv7(),
    orgId,
    email,
    name: 'Admin',
    // NOTE: Phase 7 replaces this with Argon2id; Phase 1 has no interactive login.
    passwordHash: `sha256:${createHash('sha256').update(config.ADMIN_PASSWORD).digest('hex')}`,
    role: 'ADMIN',
  });
  console.log(`admin member created: ${email}`);
} else {
  console.log(`admin member exists: ${email}`);
}

// channel connections
const sim = await channelsRepo.ensureConnection(db, {
  orgId,
  channel: 'SIMULATOR',
  externalAccountId: 'sim-account-1',
  displayName: 'Simulator channel',
});
console.log(`simulator connection: ${sim.id}`);

if (config.IG_APP_ID) {
  const ig = await channelsRepo.ensureConnection(db, {
    orgId,
    channel: 'INSTAGRAM',
    externalAccountId: config.IG_BUSINESS_ACCOUNT_ID ?? null,
    displayName: 'Instagram professional account',
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
  });
  console.log(`instagram connection: ${ig.id}`);
} else {
  console.log('instagram connection skipped (IG_APP_ID not set) — Phase 1 runs on the simulator channel');
}

// config defaults (docs/12 §7: DB config wins over env for tunables)
const defaults: Array<[string, unknown, string]> = [
  ['loop.spec_audit.max', 3, 'Spec Auditor revision attempts (SPEC §21)'],
  ['loop.code_check.max', 3, 'Code Checker correction attempts (SPEC §26)'],
  ['loop.client_revision.max', 5, 'Client change cycles before a human task'],
  ['loop.requirements.max_questions', 40, 'Maximum questions per requirements session'],
  ['loop.requirements.max_clarifications_per_field', 2, 'Clarification cycles per field'],
  ['loop.job.max_attempts', 5, 'Job retry ceiling'],
  ['requirements.inactivity_reminder_hours', 24, 'Client silence reminder (hours)'],
  ['requirements.inactivity_max_reminders', 2, 'Reminders before human escalation'],
  ['send.rate_per_minute', config.SEND_RATE_PER_MINUTE, 'Outbound message cap per connection'],
  ['window.warning_hours', config.WINDOW_WARNING_HOURS, 'Panel warning before the 24h window closes'],
  ['agent.audit_independent_provider', true, 'Spec Auditor must use a different provider (Q4 answer)'],
];
for (const [key, value, description] of defaults) {
  await orgRepo.setConfigValue(db, key, value, description);
}
console.log(`config values: ${defaults.length} keys`);

// sanity: existing projects (idempotency check for repeated seeding)
const projects = await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId));
console.log(`projects in db: ${projects.length}`);
await handle.close();

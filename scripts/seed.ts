/**
 * Seed: organization, initial admin member, channel connections, questionnaires,
 * agent config versions and config values (docs/14 §11, docs/11 §2.4).
 * Idempotent — safe to run repeatedly.
 */
import { applyMigrations, createDb, channelsRepo, orgRepo, schema, seedConfigFromFiles } from '@wpp/db';
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

// questionnaires + agent configs + tunables come from `config/` (the reviewable source of
// truth); the runtime reads them back from the DB only (docs/11 §2.4).
const seeded = await seedConfigFromFiles(db, orgId, { configDir: 'config' });
console.log(`questionnaires: ${seeded.questionnaires.length} → ${seeded.questionnaires.join(' | ')}`);
if (seeded.questionnaireProblems.length > 0) {
  console.error('questionnaire problems:', seeded.questionnaireProblems);
  process.exitCode = 1;
}
console.log(`agent configs: ${seeded.agentConfigs.length} → ${seeded.agentConfigs.join(' | ')}`);
console.log(`config values: ${seeded.configValues} keys`);

// sanity: existing projects (idempotency check for repeated seeding)
const projects = await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId));
console.log(`projects in db: ${projects.length}`);
await handle.close();

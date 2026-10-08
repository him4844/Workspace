/**
 * Phase 2 test helpers: seed the config files into the test database and re-export the
 * scripted client personas (`@wpp/testing`) used by the end-to-end tests.
 */
import { orgRepo, seedConfigFromFiles } from '@wpp/db';
import type { TestContext } from './context.js';

export * from '@wpp/testing';

export async function seedPhase2(ctx: TestContext, configDir = 'config'): Promise<string> {
  const orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
  await seedConfigFromFiles(ctx.handle.db, orgId, { configDir, env: {} });
  return orgId;
}

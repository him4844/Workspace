import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { configValues, organizations, teamMembers } from '../schema.js';
import { uuidv7 } from '@wpp/infra';

export const DEFAULT_ORG_NAME = 'WPP Internal Team';

export async function getOrCreateDefaultOrg(ex: Executor, name = DEFAULT_ORG_NAME): Promise<string> {
  const existing = await ex.select().from(organizations).limit(1);
  if (existing.length > 0) return existing[0]!.id;
  const id = uuidv7();
  await ex.insert(organizations).values({ id, name });
  return id;
}

export async function getConfigValue<T = unknown>(ex: Executor, key: string): Promise<T | null> {
  const rows = await ex.select().from(configValues).where(eq(configValues.key, key)).limit(1);
  return rows.length > 0 ? (rows[0]!.value as T) : null;
}

export async function setConfigValue(ex: Executor, key: string, value: unknown, description?: string): Promise<void> {
  await ex
    .insert(configValues)
    .values({ key, value: value as object, description })
    .onConflictDoUpdate({ target: configValues.key, set: { value: value as object, updatedAt: new Date() } });
}

export async function findMemberByEmail(ex: Executor, email: string) {
  const rows = await ex.select().from(teamMembers).where(eq(teamMembers.email, email)).limit(1);
  return rows[0] ?? null;
}

import type { Db } from '@wpp/db';
import { channelsRepo, orgRepo } from '@wpp/db';
import { uuidv7 } from '@wpp/infra';
import type { ChannelType } from '@wpp/core';

/**
 * Phase 1 runs with a single organization and one active connection per channel
 * (SPEC §2: one internal team, one primary Instagram account). The helpers keep
 * that assumption in exactly one place, ready for the multi-tenant step.
 */
export async function getDefaultOrgId(db: Db): Promise<string> {
  return orgRepo.getOrCreateDefaultOrg(db);
}

/** Returns the active connection for a channel, creating a placeholder if missing (dev/simulator). */
export async function getConnectionForChannel(db: Db, channel: ChannelType): Promise<{ id: string }> {
  const existing = await channelsRepo.getActiveConnection(db, channel);
  if (existing) return existing;
  const orgId = await getDefaultOrgId(db);
  const created = await channelsRepo.ensureConnection(db, {
    orgId,
    channel,
    externalAccountId: channel === 'SIMULATOR' ? 'sim-account-1' : null,
    displayName: channel === 'SIMULATOR' ? 'Simulator channel' : null,
  });
  return created;
}

export function newId(): string {
  return uuidv7();
}

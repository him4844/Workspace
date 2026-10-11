import type { Db } from '@wpp/db';
import { channelsRepo, orgRepo } from '@wpp/db';
import { uuidv7, type Config } from '@wpp/infra';
import type { ChannelType, JobType, ProjectState } from '@wpp/core';

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

/**
 * Which job answers a client message (SPEC §5, D-015, §18/§19).
 * With an LLM provider configured the requirements agent takes the turn; without one the
 * pipeline degrades to the Phase 1 acknowledgment instead of failing silently.
 */
export function turnJobType(config: Config): JobType {
  return config.LLM_PROVIDER && config.LLM_PROVIDER !== 'none' ? 'REQUIREMENTS_TURN' : 'ECHO_REPLY';
}

/**
 * Phase 3: once the project is waiting for the client's decision on a specification, an inbound
 * message is an approval/changes signal — it must never restart the requirements interview.
 */
export function turnJobTypeByState(config: Config): Partial<Record<ProjectState, JobType>> {
  if (config.LLM_PROVIDER === 'none') return {};
  return {
    CLIENT_REVIEW: 'CLIENT_INTENT_PARSE',
    CLIENT_CHANGES_REQUESTED: 'CLIENT_INTENT_PARSE',
    CLIENT_APPROVED: 'CLIENT_INTENT_PARSE',
  };
}

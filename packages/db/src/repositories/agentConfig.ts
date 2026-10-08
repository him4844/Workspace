/**
 * Agent configuration resolution (SPEC §51; docs/03 §8).
 * The runtime reads the active version from the DB so prompt/model changes are data,
 * versioned and rollback-able — never code edits.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { agentConfigs, agentConfigVersions, llmUsage } from '../schema.js';
import { uuidv7 } from '@wpp/infra';

export type AgentConfigVersionRow = typeof agentConfigVersions.$inferSelect;
export type AgentConfigRow = typeof agentConfigs.$inferSelect;

export async function getActiveAgentConfig(
  ex: Executor,
  orgId: string,
  agentType: 'REQUIREMENTS' | 'SPECIFICATION' | 'SPEC_AUDITOR' | 'CODING' | 'CODE_CHECKER' | 'TEAM_ASSISTANT',
): Promise<{ config: AgentConfigRow; version: AgentConfigVersionRow } | null> {
  const rows = await ex
    .select()
    .from(agentConfigs)
    .where(and(eq(agentConfigs.orgId, orgId), eq(agentConfigs.agentType, agentType), eq(agentConfigs.isActive, true)))
    .limit(1);
  const config = rows[0];
  if (!config) return null;
  const versions = await ex
    .select()
    .from(agentConfigVersions)
    .where(eq(agentConfigVersions.agentConfigId, config.id))
    .orderBy(desc(agentConfigVersions.version))
    .limit(1);
  const version = versions[0];
  if (!version) return null;
  return { config, version };
}

export async function recordLlmUsage(
  ex: Executor,
  params: {
    orgId: string;
    projectId?: string | null;
    agentRunId?: string | null;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd?: number;
  },
): Promise<void> {
  await ex.insert(llmUsage).values({
    id: uuidv7(),
    orgId: params.orgId,
    projectId: params.projectId ?? null,
    agentRunId: params.agentRunId ?? null,
    provider: params.provider,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    costUsd: params.costUsd !== undefined ? String(params.costUsd) : null,
  });
}

/** Cost guard for the daily LLM budget (Phase 0 Q4 default: $10/day). */
export async function sumCostSince(ex: Executor, since: Date): Promise<number> {
  const rows = await ex
    .select({ total: sql<string | null>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, since));
  return Number(rows[0]?.total ?? 0);
}

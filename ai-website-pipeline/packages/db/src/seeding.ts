/**
 * Config seeding (docs/11 §2.4): `config/*` files are the reviewable source of truth and are
 * loaded into the database; the runtime then reads the DB only. Used by `scripts/seed.ts`
 * and by the test harness, so tests exercise the very same path production uses.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateQuestionnaire, type QuestionnaireDefinition } from '@wpp/core';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@wpp/infra';
import type { Executor } from './client.js';
import { agentConfigs, agentConfigVersions, configValues } from './schema.js';
import { upsertQuestionnaireDefinition } from './repositories/questionnaires.js';

export interface SeedReport {
  questionnaires: string[];
  questionnaireProblems: string[];
  agentConfigs: string[];
  configValues: number;
}

interface AgentSeedDefinition {
  agentType: 'REQUIREMENTS' | 'SPECIFICATION' | 'SPEC_AUDITOR' | 'CODING' | 'CODE_CHECKER' | 'TEAM_ASSISTANT';
  name: string;
  version: number;
  providerEnv?: string;
  modelEnv?: string;
  /** env var naming the preset for this agent (e.g. AUDITOR_LLM_PRESET) — model fallback source */
  presetEnv?: string;
  defaultProvider: string;
  defaultModel: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  maxRetries?: number;
  enabledTools?: string[];
  outputSchemaFile?: string;
  systemInstructions: string;
  notes?: string;
}

export async function seedQuestionnaires(ex: Executor, configDir = 'config'): Promise<{ seeded: string[]; problems: string[] }> {
  const dir = join(configDir, 'questionnaires');
  if (!existsSync(dir)) return { seeded: [], problems: [`no questionnaires directory at ${dir}`] };
  const seeded: string[] = [];
  const problems: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const definition = JSON.parse(readFileSync(join(dir, file), 'utf8')) as QuestionnaireDefinition;
    const issues = validateQuestionnaire(definition);
    if (issues.length > 0 && definition.type === 'GENERAL') {
      // A GENERAL questionnaire that misses a mandatory category is a bug we refuse to hide.
      problems.push(...issues.map((i) => `${file}: ${i}`));
      continue;
    }
    await upsertQuestionnaireDefinition(ex, definition);
    seeded.push(`${definition.code} v${definition.version}, fields=${definition.fields.length}${issues.length ? ` (warnings: ${issues.join('; ')})` : ''}`);
  }
  return { seeded, problems };
}

export async function seedAgentConfigs(
  ex: Executor,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
  configDir = 'config',
): Promise<string[]> {
  const file = join(configDir, 'agent-configs', 'agents.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { agents: AgentSeedDefinition[] };
  const out: string[] = [];
  for (const agent of parsed.agents) {
    const provider = (agent.providerEnv ? env[agent.providerEnv] : undefined) ?? env.LLM_PROVIDER ?? agent.defaultProvider;
    // Record the model the runtime will actually send (D-033): per-agent env pin → LLM_MODEL → the
    // selected free preset's model → the agent's own default. Recording the literal placeholder
    // ('gpt-5-mini') while the route served 'openai/gpt-oss-120b' made the run log, the inspector and
    // a live debugging session disagree with each other (2026-10-08).
    const presetId = (agent.presetEnv ? env[agent.presetEnv] : undefined) ?? env.LLM_PRESET;
    const presetModel = (() => {
      if (!presetId || presetId === 'scripted' || presetId === 'none') return undefined;
      try {
        const file = JSON.parse(readFileSync(join(configDir, 'llm-presets.json'), 'utf8')) as {
          presets: Array<{ id: string; model: string | null }>;
        };
        return file.presets.find((preset) => preset.id === presetId)?.model ?? undefined;
      } catch {
        return undefined;
      }
    })();
    const model = (agent.modelEnv ? env[agent.modelEnv] : undefined) ?? env.LLM_MODEL ?? presetModel ?? agent.defaultModel;

    const existing = await ex.select().from(agentConfigs).where(eq(agentConfigs.orgId, orgId));
    const match = existing.find((c) => c.agentType === agent.agentType && c.name === agent.name);
    let configId = match?.id;
    if (!configId) {
      configId = uuidv7();
      await ex.insert(agentConfigs).values({
        id: configId,
        orgId,
        agentType: agent.agentType,
        name: agent.name,
        isActive: true,
        currentVersion: agent.version,
      });
    }

    const outputSchema = agent.outputSchemaFile && existsSync(agent.outputSchemaFile)
      ? (JSON.parse(readFileSync(agent.outputSchemaFile, 'utf8')) as object)
      : ({} as object);

    const versions = await ex.select().from(agentConfigVersions).where(eq(agentConfigVersions.agentConfigId, configId));
    const versionMatch = versions.find((v) => v.version === agent.version);
    if (!versionMatch) {
      await ex.insert(agentConfigVersions).values({
        id: uuidv7(),
        agentConfigId: configId,
        version: agent.version,
        provider,
        model,
        temperature: agent.temperature !== undefined ? String(agent.temperature) : null,
        maxOutputTokens: agent.maxOutputTokens ?? null,
        reasoningEffort: agent.reasoningEffort ?? null,
        timeoutMs: agent.timeoutMs ?? 60000,
        maxRetries: agent.maxRetries ?? 2,
        systemInstructions: agent.systemInstructions,
        outputSchema,
        enabledTools: agent.enabledTools ?? [],
        notes: agent.notes ?? null,
      });
      out.push(`${agent.agentType} v${agent.version} (${provider}/${model})`);
    } else {
      out.push(`${agent.agentType} v${agent.version} exists`);
    }
  }
  return out;
}

export async function seedConfigValues(ex: Executor, configDir = 'config'): Promise<number> {
  const file = join(configDir, 'defaults.json');
  if (!existsSync(file)) return 0;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    values: Array<{ key: string; value: unknown; description?: string }>;
  };
  for (const entry of parsed.values) {
    await ex
      .insert(configValues)
      .values({ key: entry.key, value: entry.value as object, description: entry.description })
      .onConflictDoUpdate({ target: configValues.key, set: { value: entry.value as object, description: entry.description, updatedAt: new Date() } });
  }
  return parsed.values.length;
}

/** Full config seeding used by scripts/seed.ts and tests. */
export async function seedConfigFromFiles(ex: Executor, orgId: string, opts: { configDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<SeedReport> {
  const configDir = opts.configDir ?? 'config';
  const questionnaires = await seedQuestionnaires(ex, configDir);
  const agentConfigsSeeded = await seedAgentConfigs(ex, orgId, opts.env ?? process.env, configDir);
  const configValueCount = await seedConfigValues(ex, configDir);
  return {
    questionnaires: questionnaires.seeded,
    questionnaireProblems: questionnaires.problems,
    agentConfigs: agentConfigsSeeded,
    configValues: configValueCount,
  };
}

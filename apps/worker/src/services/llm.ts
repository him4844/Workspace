/**
 * LLM wiring for the API and worker entrypoints (SPEC §51, D-015).
 *
 * `none`          → no client: the pipeline stays on the Phase-1 acknowledgment path
 * `openai` …      → real provider through `packages/agents`
 * `scripted`      → the demo/test personas from `packages/testing` (no network, no key)
 *
 * `scripted` exists so the whole pipeline — planner, prompt, contract validation, persistence,
 * completeness — can be demonstrated and CI-tested without a provider key. It is never a
 * fallback: it must be selected explicitly with `LLM_PROVIDER=scripted`.
 */
import type { Logger } from 'pino';
import { createLlmClient, routeDecision, type LlmClient, type ResolvedLlm } from '@wpp/agents';
import type { Config } from '@wpp/infra';

export async function resolveLlmClient(config: Config, logger?: Logger): Promise<ResolvedLlm | null> {
  if (config.LLM_PROVIDER === 'scripted') {
    const { createPipelineLlm } = await import('@wpp/testing');
    // One router for the whole pipeline: the requirements persona answers interview turns, the
    // specification persona answers specification/revision turns and the client-intent classifier —
    // chosen from the task block the runtime built, so a task can never reach the wrong persona.
    // useClientAnswer: the dev console records the human's own words instead of the canned set.
    const client = createPipelineLlm();
    return { client, defaultProvider: 'scripted', defaultModel: 'scripted-client-persona' };
  }
  const resolved = createLlmClient(config);
  if (!resolved) {
    const decision = routeDecision(config);
    logger?.warn({ provider: config.LLM_PROVIDER, preset: config.LLM_PRESET ?? null, freeOnly: config.LLM_FREE_ONLY, reason: decision.reason },
      'LLM disabled: no usable route (see config/llm-presets.json and docs/12)');
  }
  return resolved;
}

/**
 * The model a run must actually send (§51, D-015): a deliberate per-agent env pin wins, then the
 * resolved route's model, and only when no route exists at all the recorded agent-config model.
 * The DB agent-config model is documentation ('gpt-5-mini' is a seeded placeholder): trusting it
 * sent a model the configured route could not serve — a live 404 on 2026-10-08.
 */
export function effectiveModel(
  agentConfig: { provider?: string | null; model?: string | null },
  route: { provider: string; model: string } | null | undefined,
  envPin?: string | null,
): string | undefined {
  if (envPin) return envPin;
  if (route?.model) return route.model;
  return agentConfig.model ?? undefined;
}

/**
 * The Spec Auditor's route (§20, D-037).
 *
 * The auditor is a second opinion, so it prefers its OWN route: `AUDITOR_LLM_*` (own key = own
 * free-tier bucket, own model, optionally another vendor). When no dedicated route is configured the
 * injected client is used — the entrypoint already resolved it and the audit row records which
 * model actually answered, so "same route as the writer" is visible in the data instead of implied.
 * `scripted` keeps the pipeline-router client so demos/tests answer audit tasks from the scripted
 * auditor persona.
 */
export async function resolveAuditorLlm(ctx: {
  config: Config;
  llm?: LlmClient | null;
  llmRoute?: { provider: string; model: string } | null;
  logger?: Logger;
}): Promise<ResolvedLlm | null> {
  const { config } = ctx;
  // A scripted run stays hermetic: demos and tests must never reach a real provider (no network,
  // no cost, deterministic verdicts) even when the developer's .env points at one. The injected
  // client is preferred so the run's call log stays complete.
  if (config.LLM_PROVIDER === 'scripted' || ctx.llmRoute?.provider === 'scripted') {
    if (ctx.llm) {
      return { client: ctx.llm, defaultProvider: ctx.llmRoute?.provider ?? 'scripted', defaultModel: ctx.llmRoute?.model ?? 'scripted-router' };
    }
    return resolveLlmClient(config, ctx.logger);
  }

  const hasDedicatedRoute = Boolean(
    config.AUDITOR_LLM_PROVIDER || config.AUDITOR_LLM_API_KEY || config.AUDITOR_LLM_MODEL || config.AUDITOR_LLM_PRESET,
  );
  if (!hasDedicatedRoute) {
    if (!ctx.llm) return null;
    return {
      client: ctx.llm,
      defaultProvider: ctx.llmRoute?.provider ?? config.LLM_PROVIDER,
      defaultModel: ctx.llmRoute?.model ?? config.LLM_MODEL ?? '',
    };
  }

  const provider = config.AUDITOR_LLM_PROVIDER ?? config.LLM_PROVIDER;
  if (!provider || provider === 'none') {
    if (ctx.llm) {
      return {
        client: ctx.llm,
        defaultProvider: ctx.llmRoute?.provider ?? provider ?? 'none',
        defaultModel: ctx.llmRoute?.model ?? config.LLM_MODEL ?? '',
      };
    }
    return null;
  }
  const resolved = createLlmClient({
    ...config,
    LLM_PROVIDER: provider as Config['LLM_PROVIDER'],
    LLM_PRESET: config.AUDITOR_LLM_PRESET ?? config.LLM_PRESET,
    LLM_API_KEY: config.AUDITOR_LLM_API_KEY ?? config.LLM_API_KEY,
    LLM_MODEL: config.AUDITOR_LLM_MODEL ?? undefined,
    LLM_BASE_URL: config.AUDITOR_LLM_BASE_URL ?? config.LLM_BASE_URL,
  });
  if (!resolved) {
    ctx.logger?.warn(
      { provider, preset: config.AUDITOR_LLM_PRESET ?? config.LLM_PRESET ?? null, freeOnly: config.LLM_FREE_ONLY },
      'spec auditor LLM unavailable: the configured auditor route is not usable (paid route blocked or key missing)',
    );
  }
  return resolved;
}

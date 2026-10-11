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
import { findPreset, type Config } from '@wpp/infra';

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

/** Normalize a configured endpoint to the actual vendor, not merely the OpenAI-compatible API shape. */
function vendorKey(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (host === 'generativelanguage.googleapis.com') return 'google';
      if (host === 'openrouter.ai') return 'openrouter';
      if (host === 'api.groq.com') return 'groq';
      if (host === 'api.openai.com') return 'openai';
      if (host === 'api.anthropic.com') return 'anthropic';
      return host;
    } catch { /* fall through to configured provider */ }
  }
  return (provider ?? 'none').toLowerCase();
}

function routeBaseUrl(config: Config, presetId: string | null | undefined, explicit?: string | null): string | null {
  if (explicit) return explicit;
  const preset = presetId ? findPreset(presetId) : null;
  return preset?.baseUrl ?? null;
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
    config.AUDITOR_LLM_PROVIDER || config.AUDITOR_LLM_API_KEY || config.AUDITOR_LLM_MODEL || config.AUDITOR_LLM_PRESET || config.AUDITOR_LLM_BASE_URL,
  );
  if (!hasDedicatedRoute) {
    // Unit/e2e suites inject a scripted client while no network route is configured; keep those
    // hermetic. A real provider may NOT silently audit its own spec — the user explicitly asked for
    // a different provider, and the audit row must never imply independence that did not happen.
    if (config.LLM_PROVIDER === 'none' && ctx.llm) {
      return { client: ctx.llm, defaultProvider: ctx.llmRoute?.provider ?? ctx.llm.provider, defaultModel: ctx.llmRoute?.model ?? 'scripted-router' };
    }
    ctx.logger?.warn({ writerProvider: ctx.llmRoute?.provider ?? config.LLM_PROVIDER }, 'independent Spec Auditor route is not configured; refusing same-provider fallback');
    return null;
  }

  const auditorPresetId = config.AUDITOR_LLM_PRESET ?? config.LLM_PRESET;
  const auditorPreset = auditorPresetId ? findPreset(auditorPresetId) : null;
  const provider = config.AUDITOR_LLM_PROVIDER ?? auditorPreset?.provider ?? config.LLM_PROVIDER;
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
  // If an auditor preset is explicit, its host wins over the writer's custom base URL.
  const auditorBaseUrl = config.AUDITOR_LLM_BASE_URL
    ?? (config.AUDITOR_LLM_PRESET ? auditorPreset?.baseUrl ?? null : config.LLM_BASE_URL ?? auditorPreset?.baseUrl ?? null);
  const writerBaseUrl = routeBaseUrl(config, config.LLM_PRESET, config.LLM_BASE_URL);
  const auditorVendor = vendorKey(provider, auditorBaseUrl);
  const writerVendor = vendorKey(ctx.llmRoute?.provider ?? config.LLM_PROVIDER, writerBaseUrl);
  const auditorKey = config.AUDITOR_LLM_API_KEY ?? config.LLM_API_KEY;
  if (auditorVendor === writerVendor) {
    ctx.logger?.error({ writerVendor, auditorVendor, model: config.AUDITOR_LLM_MODEL ?? config.LLM_MODEL ?? null }, 'Spec Auditor must use a different vendor from the specification writer');
    return null;
  }
  // For an independent provider, require an explicitly separate credential rather than accidentally
  // reusing the writer key. Do not include either key in logs.
  if (!config.AUDITOR_LLM_API_KEY || config.AUDITOR_LLM_API_KEY === config.LLM_API_KEY) {
    ctx.logger?.error({ writerVendor, auditorVendor }, 'independent Spec Auditor route requires its own API key');
    return null;
  }

  const resolved = createLlmClient({
    ...config,
    LLM_PROVIDER: provider as Config['LLM_PROVIDER'],
    LLM_PRESET: auditorPresetId,
    LLM_API_KEY: auditorKey,
    LLM_MODEL: config.AUDITOR_LLM_MODEL ?? undefined,
    LLM_BASE_URL: auditorBaseUrl ?? undefined,
  });
  if (!resolved) {
    ctx.logger?.warn(
      { provider, preset: config.AUDITOR_LLM_PRESET ?? config.LLM_PRESET ?? null, freeOnly: config.LLM_FREE_ONLY },
      'spec auditor LLM unavailable: no usable auditor route and no main route either',
    );
  }
  return resolved;
}

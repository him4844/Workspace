/**
 * Provider factory (SPEC §51, D-015). `LLM_PROVIDER=none` means the pipeline runs without
 * an LLM (Phase 1 behaviour): callers fall back to the echo placeholder instead of failing.
 */
import type { Config } from '@wpp/infra';
import { decideRoute, loadLlmPresets, type LlmPreset, type RouteDecision } from '@wpp/infra';
import type { LlmClient } from './types.js';
import { createAnthropicClient, createOpenAICompatibleClient } from './http.js';

export interface ResolvedLlm {
  client: LlmClient;
  /** provider suggested to agents that use env-based defaults */
  defaultProvider: string;
  defaultModel: string;
}

/**
 * The free-only guard (§58, D-029): with `LLM_FREE_ONLY=true` (default) a paid route resolves to
 * `null` — the same honest state as "no key" — so the pipeline never spends money by accident.
 * `routeDecision` exposes the reason for logs and for the SPEC/REQUIREMENTS "agent not configured" paths.
 */
export function routeDecision(config: Config): RouteDecision {
  const provider = (config.LLM_PROVIDER ?? 'none').toLowerCase();
  const presetId = config.LLM_PRESET ?? null;
  let presets: LlmPreset[] | undefined;
  try {
    presets = loadLlmPresets().presets;
  } catch {
    presets = undefined; // no config file (packaged runtime) → fall back to the host allowlist
  }
  const preset = presetId ? presets?.find((p) => p.id === presetId) : undefined;
  return decideRoute({
    provider,
    baseUrl: config.LLM_BASE_URL ?? preset?.baseUrl ?? null,
    presetId,
    presets,
    freeOnly: config.LLM_FREE_ONLY,
  });
}

/** The preset named by `LLM_PRESET`, when the presets file is readable. */
function selectedPreset(config: Config): LlmPreset | null {
  if (!config.LLM_PRESET) return null;
  try {
    return loadLlmPresets().presets.find((p) => p.id === config.LLM_PRESET) ?? null;
  } catch {
    return null;
  }
}

export function createLlmClient(config: Config): ResolvedLlm | null {
  const provider = (config.LLM_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none' || provider === '') return null;
  const decision = routeDecision(config);
  if (!decision.allowed) return null;
  const preset = selectedPreset(config);
  // precedence: explicit environment override → preset file → built-in default
  const baseUrl = config.LLM_BASE_URL ?? preset?.baseUrl ?? undefined;
  const model = config.LLM_MODEL ?? preset?.model ?? null;
  if (provider === 'openai' || provider === 'openrouter' || provider === 'openai-compatible') {
    if (!config.LLM_API_KEY) return null;
    const client = createOpenAICompatibleClient({
      apiKey: config.LLM_API_KEY,
      baseUrl,
      providerName: provider,
    });
    return { client, defaultProvider: provider, defaultModel: model ?? 'gpt-5-mini' };
  }
  if (provider === 'anthropic') {
    if (!config.LLM_API_KEY) return null;
    const client = createAnthropicClient({ apiKey: config.LLM_API_KEY, baseUrl });
    return { client, defaultProvider: provider, defaultModel: model ?? 'claude-sonnet-4-5' };
  }
  return null;
}

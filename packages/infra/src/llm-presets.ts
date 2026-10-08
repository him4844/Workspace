/**
 * LLM route presets (config/llm-presets.json) + the "this project must be free" guard (§58, D-029).
 *
 * The presets file is the human-reviewable list of routes; this module is the single place that
 * decides whether a configured route is allowed to be called. Policy:
 *   1. `scripted` / `none` are always allowed (no network / no calls).
 *   2. A route is free when its preset is marked `free: true` — or, without a preset id, when its
 *      base URL points at the local machine or at a host on the documented free-tier allowlist.
 *   3. Anything else is refused while `LLM_FREE_ONLY` is true (the default): "no LLM configured"
 *      is the honest behaviour, never a silent paid call.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LlmPreset {
  id: string;
  label: string;
  provider: 'none' | 'scripted' | 'openai' | 'openrouter' | 'openai-compatible' | 'anthropic';
  baseUrl: string | null;
  model: string | null;
  keyEnv: string | null;
  free: boolean;
  freeLimits: string | null;
  caveats: string;
  source: string;
}

export interface LlmPresetsFile {
  schemaVersion: string;
  generatedFor: string;
  presets: LlmPreset[];
}

/** Hosts whose *documented* free tier is the reason a route is considered free. */
export const FREE_ENDPOINT_HOSTS: readonly string[] = [
  'generativelanguage.googleapis.com', // Google AI Studio free tier (Gemini)
  'api.groq.com',                      // Groq free plan
  'openrouter.ai',                     // OpenRouter :free models
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

export function isLocalEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return LOCAL_HOSTS.has(host) || host.startsWith('192.168.') || host.startsWith('10.');
  } catch {
    return false;
  }
}

export function isFreeEndpointHost(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  if (isLocalEndpoint(baseUrl)) return true; // your own machine or your own LAN: no vendor, no bill
  try {
    const host = new URL(baseUrl).hostname;
    return FREE_ENDPOINT_HOSTS.includes(host);
  } catch {
    return false;
  }
}

export interface RouteDecision {
  allowed: boolean;
  free: boolean;
  presetId: string | null;
  reason: string;
}

/**
 * Decide whether a configured route may be called. `freeOnly=false` is the documented escape hatch
 * for a team that consciously accepts cost (it is never the default).
 */
export function decideRoute(params: {
  provider: string;
  baseUrl?: string | null;
  presetId?: string | null;
  presets?: LlmPreset[];
  freeOnly: boolean;
}): RouteDecision {
  const provider = (params.provider ?? 'none').toLowerCase();
  if (provider === 'none') return { allowed: false, free: true, presetId: params.presetId ?? null, reason: 'no LLM configured' };
  if (provider === 'scripted') return { allowed: true, free: true, presetId: params.presetId ?? 'scripted', reason: 'scripted provider makes no network calls' };

  const preset = params.presetId ? params.presets?.find((p) => p.id === params.presetId) ?? null : null;
  const freeKnown = preset ? preset.free : isFreeEndpointHost(params.baseUrl);

  if (!params.freeOnly) {
    return {
      allowed: true,
      free: freeKnown,
      presetId: preset?.id ?? null,
      reason: preset ? `preset ${preset.id} (${freeKnown ? 'free' : 'paid'}), paid use allowed by LLM_FREE_ONLY=false` : 'paid use allowed by LLM_FREE_ONLY=false',
    };
  }
  if (freeKnown) {
    return {
      allowed: true,
      free: true,
      presetId: preset?.id ?? null,
      reason: preset ? `preset ${preset.id} is marked free` : `endpoint ${params.baseUrl ?? '(default)'} is a documented free or local route`,
    };
  }
  return {
    allowed: false,
    free: false,
    presetId: preset?.id ?? null,
    reason: preset
      ? `preset ${preset.id} is marked paid and LLM_FREE_ONLY=true`
      : `provider ${provider} at ${params.baseUrl ?? 'its default endpoint'} is not a documented free route and LLM_FREE_ONLY=true`,
  };
}

let cachedPresets: LlmPresetsFile | null = null;

/** Load `config/llm-presets.json` (repo root by default). Throws on a malformed file: config is data, but not optional. */
export function loadLlmPresets(rootDir = process.cwd()): LlmPresetsFile {
  if (cachedPresets && rootDir === process.cwd()) return cachedPresets;
  const path = resolve(rootDir, 'config/llm-presets.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as LlmPresetsFile;
  if (!Array.isArray(parsed.presets) || parsed.presets.length === 0) {
    throw new Error(`llm-presets.json at ${path} contains no presets`);
  }
  for (const preset of parsed.presets) {
    if (!preset.id || !preset.provider || typeof preset.free !== 'boolean') {
      throw new Error(`llm-presets.json: preset ${JSON.stringify(preset.id ?? preset)} needs id, provider and free`);
    }
  }
  cachedPresets = parsed;
  return parsed;
}

export function findPreset(id: string, rootDir = process.cwd()): LlmPreset | null {
  return loadLlmPresets(rootDir).presets.find((p) => p.id === id) ?? null;
}

/** Presets a human can pick from in a free-only setup. */
export function freePresets(rootDir = process.cwd()): LlmPreset[] {
  return loadLlmPresets(rootDir).presets.filter((p) => p.free);
}

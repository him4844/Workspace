/**
 * The free-only guarantee (user constraint, 2026-10-08) and the preset catalogue.
 *
 * The whole project must be runnable at zero cost: `LLM_FREE_ONLY` defaults to true, and a route is
 * only allowed when its preset is marked free or its host is a documented free/local endpoint.
 * These tests are the guard rail — if a paid provider ever becomes selectable by default, they fail.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLlmClient, routeDecision } from '@wpp/agents';
import { configFrom, FREE_ENDPOINT_HOSTS, isFreeEndpointHost, isLocalEndpoint, loadLlmPresets, type LlmPresetsFile } from '@wpp/infra';
import { effectiveModel } from '../../apps/worker/src/services/llm.js';

const file = loadLlmPresets();
const presets = file.presets;
const byId = new Map(presets.map((p) => [p.id, p]));

const config = (env: Record<string, string> = {}) =>
  configFrom({ NODE_ENV: 'test', DB_DRIVER: 'pglite', LOG_LEVEL: 'silent', LLM_API_KEY: 'test-key', ...env });

describe('preset catalogue (config/llm-presets.json)', () => {
  it('is valid, versioned data rather than code (§50)', () => {
    const raw = JSON.parse(readFileSync('config/llm-presets.json', 'utf8')) as LlmPresetsFile;
    expect(raw.schemaVersion).toBe('1.0.0');
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    for (const preset of presets) {
      expect(preset.label, preset.id).toBeTruthy();
      expect(preset.source, preset.id).toBeTruthy();
      if (preset.provider !== 'none' && preset.provider !== 'scripted') {
        expect(preset.baseUrl, preset.id).toMatch(/^https?:\/\//);
        expect(preset.model, preset.id).toBeTruthy();
      }
    }
  });

  it('marks exactly the paid providers as not free', () => {
    expect(byId.get('openai-paid')!.free).toBe(false);
    expect(byId.get('anthropic-paid')!.free).toBe(false);
    const freeIds = presets.filter((p) => p.free).map((p) => p.id).sort();
    expect(freeIds).toEqual(['gemini-free', 'groq-free', 'none', 'ollama-local', 'openrouter-free', 'scripted']);
  });

  it('every free preset points at a host the guard trusts (or is offline)', () => {
    for (const preset of presets.filter((p) => p.free)) {
      if (!preset.baseUrl) continue;
      expect(isFreeEndpointHost(preset.baseUrl) || isLocalEndpoint(preset.baseUrl), `${preset.id} → ${preset.baseUrl}`).toBe(true);
    }
    expect(FREE_ENDPOINT_HOSTS).toContain('generativelanguage.googleapis.com');
  });
});

describe('routing under LLM_FREE_ONLY (the default)', () => {
  it('accepts a free preset and reports why', () => {
    const decision = routeDecision(config({ LLM_PRESET: 'groq-free', LLM_PROVIDER: 'openai-compatible' }));
    expect(decision.allowed).toBe(true);
    expect(decision.free).toBe(true);
    expect(decision.reason).toMatch(/free/i);
  });

  it('refuses a paid preset even when a key is present, unless the escape hatch is explicit', () => {
    const paid = routeDecision(config({ LLM_PRESET: 'openai-paid', LLM_PROVIDER: 'openai' }));
    expect(paid.allowed).toBe(false);
    expect(paid.reason).toMatch(/free/i);
    const allowed = routeDecision(config({ LLM_PRESET: 'openai-paid', LLM_PROVIDER: 'openai', LLM_FREE_ONLY: 'false' }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.free).toBe(false);
  });

  it('requires an OpenRouter :free model even when the host/preset is marked free', () => {
    const paidModel = routeDecision(config({
      LLM_PROVIDER: 'openrouter', LLM_PRESET: 'openrouter-free', LLM_MODEL: 'openai/gpt-5-mini',
    }));
    expect(paidModel.allowed).toBe(false);
    expect(paidModel.reason).toMatch(/ending in :free/i);
    const freeModel = routeDecision(config({
      LLM_PROVIDER: 'openrouter', LLM_PRESET: 'openrouter-free', LLM_MODEL: 'cohere/north-mini-code:free',
    }));
    expect(freeModel.allowed).toBe(true);
  });

  it('refuses a custom endpoint on a host that is neither free-tier nor local', () => {
    const decision = routeDecision(config({
      LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'https://api.not-free.example.com/v1', LLM_MODEL: 'gpt-5',
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not a documented free route/i);
  });

  it('accepts a self-hosted local endpoint — localhost and LAN addresses are free by definition', () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'http://192.168.1.20:1234/v1', 'http://127.0.0.1:8000/v1']) {
      const decision = routeDecision(config({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: baseUrl, LLM_MODEL: 'qwen3.5:4b' }));
      expect(decision.allowed, baseUrl).toBe(true);
    }
  });

  it('treats scripted and none as free — they make no network calls at all', () => {
    expect(routeDecision(config({ LLM_PRESET: 'scripted', LLM_PROVIDER: 'scripted' })).allowed).toBe(true);
    const none = routeDecision(config({ LLM_PRESET: 'none', LLM_PROVIDER: 'none' }));
    expect(none.allowed).toBe(false);
    expect(none.reason).toMatch(/no LLM configured/);
  });
});

describe('createLlmClient', () => {
  it('returns nothing for a paid route — the pipeline degrades to "no LLM", it does not spend money', () => {
    expect(createLlmClient(config({ LLM_PRESET: 'openai-paid', LLM_PROVIDER: 'openai' }))).toBeNull();
  });

  it('builds a client for a free preset', () => {
    const resolved = createLlmClient(config({ LLM_PRESET: 'gemini-free', LLM_PROVIDER: 'openai-compatible' }));
    expect(resolved).not.toBeNull();
    expect(resolved!.client).toBeTruthy();
    // The expected model comes from the presets FILE, not from a literal: providers retire models
    // (gemini-2.5-flash was 404 for new keys on 2026-10-08) and a copied string only makes the test
    // fail a year late for the wrong reason.
    const preset = (JSON.parse(readFileSync('config/llm-presets.json', 'utf8')) as {
      presets: Array<{ id: string; model: string }>;
    }).presets.find((p) => p.id === 'gemini-free');
    expect(resolved!.defaultModel).toBe(preset!.model);
  });

  it('requires a key for network providers, and builds nothing when no provider is configured (§51/D-015)', () => {
    expect(createLlmClient(config({ LLM_PRESET: 'groq-free', LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: '' }))).toBeNull();
    expect(createLlmClient(configFrom({ NODE_ENV: 'test', DB_DRIVER: 'pglite', LOG_LEVEL: 'silent' }))).toBeNull();
    expect(createLlmClient(config({ LLM_PROVIDER: 'none' }))).toBeNull();
  });
});

describe('agent model resolution (live 404 on 2026-10-08)', () => {
  const route = { provider: 'openai-compatible', model: 'openai/gpt-oss-120b' };

  it('a route-configured run never sends the seeded placeholder model', () => {
    // agent_configs seeds 'gpt-5-mini' (a placeholder); the Groq route cannot serve it → 404.
    expect(effectiveModel({ provider: 'none', model: 'gpt-5-mini' }, route)).toBe('openai/gpt-oss-120b');
    expect(effectiveModel({ provider: 'openai-compatible', model: 'gpt-5-mini' }, route)).toBe('openai/gpt-oss-120b');
  });

  it('a deliberate per-agent env pin wins over the route model', () => {
    expect(effectiveModel({ provider: 'none', model: 'gpt-5-mini' }, route, 'openai/gpt-oss-20b')).toBe('openai/gpt-oss-20b');
  });

  it('without a resolved route the recorded agent-config model is still reported', () => {
    expect(effectiveModel({ provider: 'none', model: 'gpt-5-mini' }, null)).toBe('gpt-5-mini');
    expect(effectiveModel({ provider: 'none', model: null }, null)).toBeUndefined();
  });
});

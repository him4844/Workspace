/**
 * Provider factory (SPEC §51, D-015). `LLM_PROVIDER=none` means the pipeline runs without
 * an LLM (Phase 1 behaviour): callers fall back to the echo placeholder instead of failing.
 */
import type { Config } from '@wpp/infra';
import type { LlmClient } from './types.js';
import { createAnthropicClient, createOpenAICompatibleClient } from './http.js';

export interface ResolvedLlm {
  client: LlmClient;
  /** provider suggested to agents that use env-based defaults */
  defaultProvider: string;
  defaultModel: string;
}

export function createLlmClient(config: Config): ResolvedLlm | null {
  const provider = (config.LLM_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none' || provider === '') return null;
  if (provider === 'openai' || provider === 'openrouter' || provider === 'openai-compatible') {
    if (!config.LLM_API_KEY) return null;
    const client = createOpenAICompatibleClient({
      apiKey: config.LLM_API_KEY,
      baseUrl: config.LLM_BASE_URL,
      providerName: provider,
    });
    return { client, defaultProvider: provider, defaultModel: config.LLM_MODEL ?? 'gpt-5-mini' };
  }
  if (provider === 'anthropic') {
    if (!config.LLM_API_KEY) return null;
    const client = createAnthropicClient({ apiKey: config.LLM_API_KEY, baseUrl: config.LLM_BASE_URL });
    return { client, defaultProvider: provider, defaultModel: config.LLM_MODEL ?? 'claude-sonnet-4-5' };
  }
  return null;
}

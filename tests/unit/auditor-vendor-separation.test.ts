import { describe, expect, it } from 'vitest';
import { configFrom } from '@wpp/infra';
import { resolveAuditorLlm } from '../../apps/worker/src/services/llm.js';

const injectedScripted = {
  provider: 'scripted-router',
  async complete() { return { text: '{}', usage: { provider: 'scripted-router', model: 'scripted-router', promptTokens: 0, completionTokens: 0 } }; },
};

describe('Spec Auditor vendor separation (D-055)', () => {
  it('resolves a genuinely separate Gemini-writer / OpenRouter-auditor route', async () => {
    const config = configFrom({
      LLM_PROVIDER: 'openai-compatible', LLM_PRESET: 'gemini-free', LLM_API_KEY: 'writer-test-key',
      LLM_MODEL: 'gemini-3.1-flash-lite', LLM_FREE_ONLY: 'true',
      AUDITOR_LLM_PROVIDER: 'openrouter', AUDITOR_LLM_PRESET: 'openrouter-free',
      AUDITOR_LLM_API_KEY: 'auditor-test-key', AUDITOR_LLM_MODEL: 'cohere/north-mini-code:free',
    });
    const result = await resolveAuditorLlm({
      config, llm: injectedScripted,
      llmRoute: { provider: 'openai-compatible', model: 'gemini-3.1-flash-lite' },
    });
    expect(result).not.toBeNull();
    expect(result?.defaultProvider).toBe('openrouter');
    expect(result?.defaultModel).toBe('cohere/north-mini-code:free');
  });

  it('refuses a same-vendor route rather than silently falling back to it', async () => {
    const config = configFrom({
      LLM_PROVIDER: 'openai-compatible', LLM_PRESET: 'gemini-free', LLM_API_KEY: 'writer-test-key',
      LLM_FREE_ONLY: 'true',
      AUDITOR_LLM_PROVIDER: 'openai-compatible', AUDITOR_LLM_PRESET: 'gemini-free',
      AUDITOR_LLM_API_KEY: 'separate-but-same-vendor-key', AUDITOR_LLM_MODEL: 'gemini-3.1-flash-lite',
    });
    const result = await resolveAuditorLlm({
      config, llm: injectedScripted,
      llmRoute: { provider: 'openai-compatible', model: 'gemini-3.1-flash-lite' },
    });
    expect(result).toBeNull();
  });

  it('requires a distinct credential for the independent route', async () => {
    const config = configFrom({
      LLM_PROVIDER: 'openai-compatible', LLM_PRESET: 'gemini-free', LLM_API_KEY: 'same-test-key',
      LLM_FREE_ONLY: 'true',
      AUDITOR_LLM_PROVIDER: 'openrouter', AUDITOR_LLM_PRESET: 'openrouter-free',
      AUDITOR_LLM_API_KEY: 'same-test-key', AUDITOR_LLM_MODEL: 'cohere/north-mini-code:free',
    });
    const result = await resolveAuditorLlm({
      config, llm: injectedScripted,
      llmRoute: { provider: 'openai-compatible', model: 'gemini-3.1-flash-lite' },
    });
    expect(result).toBeNull();
  });

  it('keeps injected scripted tests hermetic when no real writer route exists', async () => {
    const config = configFrom({ LLM_PROVIDER: 'none', LLM_FREE_ONLY: 'true' });
    const result = await resolveAuditorLlm({ config, llm: injectedScripted });
    expect(result?.client).toBe(injectedScripted);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgRepo, recordLlmUsage, createDb, applyMigrations, type DbHandle } from '@wpp/db';
import { configFrom } from '@wpp/infra';
import { createDailyBudgetGuard } from '../../apps/worker/src/services/llm-budget.js';

const request = (model: string, maxOutputTokens = 1000) => ({
  model,
  messages: [{ role: 'user' as const, content: 'A short request for a small project.' }],
  maxOutputTokens,
});

describe('persisted daily LLM spend guard (§26)', () => {
  let handle: DbHandle;
  let orgId: string;

  beforeEach(async () => {
    handle = await createDb({ memory: true });
    await applyMigrations(handle);
    orgId = await orgRepo.getOrCreateDefaultOrg(handle.db);
  });

  afterEach(async () => {
    await handle.close();
  });

  it('allows a documented free route even with a zero-dollar paid-use cap', async () => {
    const config = configFrom({
      LLM_PROVIDER: 'openai-compatible', LLM_PRESET: 'gemini-free', LLM_MODEL: 'gemini-3.1-flash-lite',
      LLM_API_KEY: 'test-only', LLM_FREE_ONLY: 'true', LLM_DAILY_BUDGET_USD: '0',
    });
    const guard = createDailyBudgetGuard({ db: handle.db, orgId, config, provider: 'openai-compatible' });
    await expect(guard.beforeRequest(request('gemini-3.1-flash-lite'))).resolves.toBeUndefined();
  });

  it('blocks a paid request before the call when recorded spend + worst-case output exceeds the cap', async () => {
    const config = configFrom({ LLM_PROVIDER: 'openai', LLM_FREE_ONLY: 'false', LLM_DAILY_BUDGET_USD: '0.001' });
    await recordLlmUsage(handle.db, {
      orgId, provider: 'openai', model: 'gpt-5-mini', promptTokens: 100, completionTokens: 100, costUsd: 0.0008,
    });
    const guard = createDailyBudgetGuard({ db: handle.db, orgId, config, provider: 'openai' });
    await expect(guard.beforeRequest(request('gpt-5-mini', 1000))).rejects.toMatchObject({
      code: 'LLM_BUDGET_EXCEEDED', retryable: false,
    });
  });

  it('refuses unknown paid pricing rather than treating an unpriced route as zero-cost', async () => {
    const config = configFrom({ LLM_PROVIDER: 'openai-compatible', LLM_FREE_ONLY: 'false', LLM_DAILY_BUDGET_USD: '10' });
    const guard = createDailyBudgetGuard({ db: handle.db, orgId, config, provider: 'openai-compatible' });
    await expect(guard.beforeRequest(request('unknown-paid-model'))).rejects.toMatchObject({
      code: 'LLM_BUDGET_EXCEEDED', retryable: false,
    });
  });

  it('does not block a known-priced paid call that remains under the cap', async () => {
    const config = configFrom({ LLM_PROVIDER: 'openai', LLM_FREE_ONLY: 'false', LLM_DAILY_BUDGET_USD: '10' });
    const guard = createDailyBudgetGuard({ db: handle.db, orgId, config, provider: 'openai' });
    const reservation = await guard.beforeRequest(request('gpt-5-mini', 100));
    expect(typeof reservation).toBe('string');
    await guard.afterRequest(reservation, {
      usage: { provider: 'openai', model: 'gpt-5-mini', promptTokens: 10, completionTokens: 10, costUsd: 0.0001 },
    });
  });

  it('atomically reserves the remaining balance so concurrent calls cannot both spend it', async () => {
    const config = configFrom({ LLM_PROVIDER: 'openai', LLM_FREE_ONLY: 'false', LLM_DAILY_BUDGET_USD: '0.003' });
    const guard = createDailyBudgetGuard({ db: handle.db, orgId, config, provider: 'openai' });
    const outcomes = await Promise.allSettled([
      guard.beforeRequest(request('gpt-5-mini', 1000)),
      guard.beforeRequest(request('gpt-5-mini', 1000)),
    ]);
    const granted = outcomes.filter((item) => item.status === 'fulfilled');
    const refused = outcomes.filter((item) => item.status === 'rejected');
    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const reservation = (granted[0] as PromiseFulfilledResult<unknown>).value;
    expect(typeof reservation).toBe('string');
    await guard.afterRequest(reservation, {
      usage: { provider: 'openai', model: 'gpt-5-mini', promptTokens: 10, completionTokens: 800, costUsd: 0.0016 },
    });
  });
});

/**
 * Model pricing table (USD per 1M tokens) — DATA, so cost accounting never needs code changes.
 * Numbers are used only to record `llm_usage.costUsd`; unknown models record tokens without cost.
 */
export interface ModelPrice {
  /** prefix match against the model id */
  prefix: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice[]> = {
  openai: [
    { prefix: 'gpt-5-mini', inputPerMillion: 0.25, outputPerMillion: 2.0 },
    { prefix: 'gpt-5', inputPerMillion: 1.25, outputPerMillion: 10.0 },
    { prefix: 'gpt-4.1-mini', inputPerMillion: 0.4, outputPerMillion: 1.6 },
    { prefix: 'gpt-4.1', inputPerMillion: 2.0, outputPerMillion: 8.0 },
    { prefix: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 },
  ],
  anthropic: [
    { prefix: 'claude-haiku', inputPerMillion: 1.0, outputPerMillion: 5.0 },
    { prefix: 'claude-sonnet', inputPerMillion: 3.0, outputPerMillion: 15.0 },
    { prefix: 'claude-opus', inputPerMillion: 15.0, outputPerMillion: 75.0 },
  ],
  openrouter: [],
  fake: [{ prefix: '', inputPerMillion: 0, outputPerMillion: 0 }],
};

export function estimateCostUsd(provider: string, model: string, promptTokens: number, completionTokens: number): number | undefined {
  const table = MODEL_PRICES[provider] ?? [];
  const price = table.find((p) => model.startsWith(p.prefix));
  if (!price) return undefined;
  const cost = (promptTokens / 1_000_000) * price.inputPerMillion + (completionTokens / 1_000_000) * price.outputPerMillion;
  return Number(cost.toFixed(6));
}

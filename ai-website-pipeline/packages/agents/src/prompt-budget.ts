/**
 * Free-tier token budget (§58, D-034/D-040).
 *
 * Free providers reserve `prompt + max_tokens` against a tokens-per-minute window, so a prompt that
 * is merely *verbose* can make a task impossible to run even when its answer is short: the
 * specification call measured 7.1k prompt tokens + a 4k output cap = 11.1k against Groq's 8k TPM,
 * i.e. a guaranteed 429 (evidence: PHASE_REPORTS/evidence/phase4-verify.txt, `npm run prompt-sizes`).
 *
 * The fix is rendering, not content:
 *  - JSON is sent compact (no indentation, no null padding) — the model reads the same data;
 *  - the output schema is sent without cosmetic keys ($schema/$id/title/description/examples and
 *    the deliberately-invalid example), because validation still uses the FROZEN contract file
 *    (docs/contracts/*.json) and the task block already explains every field in words.
 *
 * Nothing here changes what is validated or persisted: it changes how many tokens a request costs.
 */
import type { LlmMessage } from './llm/types.js';

/** Provider docs use chars/4; treat the result as ±20 %, which is enough for a budget guard. */
export const CHARS_PER_TOKEN = 4;

/** Keys that only document the schema — the model does not need them to produce valid JSON. */
const COSMETIC_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'title', 'description', 'examples', 'exampleInvalid',
]);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Compact JSON for prompt use: same data, no pretty-printing, `undefined` keys dropped. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/**
 * Keys whose values are DATA, not schema: never recurse into them, or a legitimate `description`
 * inside an example would be mistaken for an annotation and deleted.
 */
const OPAQUE_VALUE_KEYS = new Set(['default', 'const', 'enum']);

/**
 * Recursively drop cosmetic schema keys (never used for validation — only for the prompt copy).
 *
 * Two traps this avoids, both found by test rather than by reading:
 *  - under a `properties` map the keys are property NAMES: a specification requirement really has a
 *    field called `description`, and deleting that key would ask the model for a different object;
 *  - inside `default` / `const` / `enum` the values are data, so nothing is stripped there.
 */
export function slimSchema(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((inner) => slimSchema(inner, parentKey));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(source)) {
      if (inner === undefined) continue;
      if (parentKey === 'properties') {
        // `key` is a property name the model must produce, not an annotation.
        out[key] = slimSchema(inner);
        continue;
      }
      if (COSMETIC_SCHEMA_KEYS.has(key)) continue;
      out[key] = OPAQUE_VALUE_KEYS.has(key) ? inner : slimSchema(inner, key);
    }
    return out;
  }
  return value;
}

export function estimatePromptTokens(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/** The budget this deployment must respect (Groq free = 8 000 TPM; override with FREE_TPM_BUDGET). */
export function promptBudgetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FREE_TPM_BUDGET ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

export interface BudgetReport {
  promptTokens: number;
  reservedTokens: number;
  budgetTokens: number;
  fits: boolean;
  /** How many tokens the request exceeds the window by (0 when it fits). */
  overBy: number;
}

/**
 * What the provider will actually reserve for this request: the whole prompt plus the output cap.
 * A request that does not fit is still sent (the provider may have a partially refilled window),
 * but it is logged, because on a strict free tier it will come back as a 429.
 */
export function budgetReport(messages: LlmMessage[], maxOutputTokens: number, budgetTokens = promptBudgetFromEnv()): BudgetReport {
  const promptTokens = estimatePromptTokens(messages);
  const reservedTokens = promptTokens + maxOutputTokens;
  return {
    promptTokens,
    reservedTokens,
    budgetTokens,
    fits: reservedTokens <= budgetTokens,
    overBy: Math.max(0, reservedTokens - budgetTokens),
  };
}

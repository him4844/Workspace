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

/**
 * Chars-per-token, by script.
 *
 * Provider documentation publishes ~4 chars/token and treats it as ±20 %, which is true for English
 * and other Latin-script prose. It is not true for the rest of what this pipeline can be handed:
 * BPE vocabularies are trained mostly on English, so the same number of Cyrillic characters costs
 * roughly twice the tokens, and CJK costs more again. `DEFAULT_LOCALE` is `uz` (Latin, with ʻ and ʼ)
 * but `ru` is a supported client language, and client text goes into the prompt verbatim.
 *
 * Under-counting is the dangerous direction: the whole point of the guard (§58, D-040) is for US to
 * refuse an oversized request instead of the provider 429-ing it mid-phase. These divisors are
 * therefore deliberately conservative — biased to over-estimate for non-Latin text.
 */
export const CHARS_PER_TOKEN = 4;
/** Cyrillic, Greek and the other dense-but-not-CJK scripts. */
export const CHARS_PER_TOKEN_NON_LATIN = 2;
/** CJK, kana and Hangul: the densest in practice. */
export const CHARS_PER_TOKEN_CJK = 1.5;

type ScriptClass = 'latin' | 'nonLatin' | 'cjk';

/**
 * Classify one code point. Ranges are explicit rather than "everything above ASCII", because Uzbek
 * Latin punctuation (ʻ U+02BB, ʼ U+02BC, ’ U+2019, — U+2014) must stay in the Latin bucket — moving
 * it would silently reprice every existing prompt measurement.
 */
export function scriptClass(codePoint: number): ScriptClass {
  if (codePoint < 0x0300) return 'latin'; // ASCII, Latin-1, Latin Extended-A/B, spacing modifiers
  if (codePoint >= 0x0370 && codePoint < 0x0530) return 'nonLatin'; // Greek, Cyrillic + supplement
  if (codePoint >= 0x0530 && codePoint < 0x0600) return 'nonLatin'; // Armenian, Hebrew
  if (codePoint >= 0x0600 && codePoint < 0x0700) return 'nonLatin'; // Arabic
  if (codePoint >= 0x0900 && codePoint < 0x0e80) return 'nonLatin'; // Devanagari, Bengali, Tamil…
  if (codePoint >= 0x0e80 && codePoint < 0x1000) return 'nonLatin'; // Thai, Lao
  if (codePoint >= 0x1e00 && codePoint < 0x1f00) return 'latin'; // Latin Extended Additional
  if (codePoint >= 0x2000 && codePoint < 0x2100) return 'latin'; // general punctuation: — ’ “ ”
  if (codePoint >= 0x3000 && codePoint < 0xa000) return 'cjk'; // CJK symbols, kana, CJK unified
  if (codePoint >= 0xac00 && codePoint < 0xd800) return 'cjk'; // Hangul syllables
  if (codePoint >= 0xf900 && codePoint < 0xfb00) return 'cjk'; // CJK compatibility ideographs
  return 'nonLatin'; // everything else, including emoji and astral-plane characters
}

const DIVISOR: Record<ScriptClass, number> = {
  latin: CHARS_PER_TOKEN,
  nonLatin: CHARS_PER_TOKEN_NON_LATIN,
  cjk: CHARS_PER_TOKEN_CJK,
};

/** Keys that only document the schema — the model does not need them to produce valid JSON. */
const COSMETIC_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'title', 'description', 'examples', 'exampleInvalid',
]);

/**
 * Estimated prompt/completion tokens for a budget guard — not a tokenizer.
 *
 * Iterates code points rather than UTF-16 units, so a surrogate pair is classified by its real code
 * point (U+1F44D, not two unpaired halves) and is not counted twice.
 *
 * The result is never lower than the old `length / 4`: Latin text is unchanged, and every denser
 * script only ever raises the estimate. The guard therefore became more conservative, never more
 * permissive, and the prompt measurements recorded in `PHASE_REPORTS/evidence/` — all Uzbek Latin —
 * are still accurate.
 */
export function estimateTokens(text: string): number {
  const counts: Record<ScriptClass, number> = { latin: 0, nonLatin: 0, cjk: 0 };
  for (const character of text) {
    counts[scriptClass(character.codePointAt(0)!)] += 1;
  }
  const total =
    counts.latin / DIVISOR.latin + counts.nonLatin / DIVISOR.nonLatin + counts.cjk / DIVISOR.cjk;
  return Math.ceil(total);
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

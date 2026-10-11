/**
 * P1-3: `.env.example` must describe the configuration the code actually reads.
 *
 * The template had drifted badly: 11 variables that `ConfigSchema` reads were undocumented
 * (including `LLM_PROVIDER`, `LLM_API_KEY` and `INTERNAL_API_TOKEN`), while 42 documented
 * variables were read by nothing — among them a wrong name for a real one
 * (`LLM_DAILY_SPEND_CAP_USD` instead of `LLM_DAILY_BUDGET_USD`). Because `scripts/init-repo.sh`
 * copies this file to `.env` verbatim, a new developer started with `LLM_PROVIDER=none` and a
 * spend cap that did not exist.
 *
 * These assertions make the drift a build failure instead of a slow surprise.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CONFIG_PATH = 'packages/infra/src/config.ts';
const ENV_EXAMPLE_PATH = '.env.example';

/**
 * Documented on purpose even though `ConfigSchema` does not read them: `loadDotEnv()` copies every
 * line of `.env` into `process.env`, so Node itself still applies these.
 */
const PROCESS_ENV_ONLY = new Set(['TZ']);

/** Extract the `ConfigSchema` object literal — the only place environment variables are read. */
function schemaBlock(): string {
  const src = readFileSync(CONFIG_PATH, 'utf8');
  const start = src.indexOf('const ConfigSchema = z.object({');
  const end = src.indexOf('export type Config =', start);
  expect(start, `${CONFIG_PATH}: ConfigSchema not found`).toBeGreaterThan(-1);
  expect(end, `${CONFIG_PATH}: end of ConfigSchema not found`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Top-level keys of `ConfigSchema`, i.e. every environment variable the code reads. */
function configKeys(): string[] {
  const keys = [...schemaBlock().matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
  expect(keys.length).toBeGreaterThan(20); // guards against a parser that silently matched nothing
  return [...new Set(keys)];
}

/** The literal default declared on a schema line, when one is parseable. */
function schemaDefaults(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of schemaBlock().matchAll(/^ {2}([A-Z][A-Z0-9_]*):(.*)$/gm)) {
    const rest = m[2] ?? '';
    const parsed =
      /\bint\((-?\d+)\)/.exec(rest) ??
      /\bbool\((true|false)\)/.exec(rest) ??
      /\.default\('([^']*)'\)/.exec(rest) ??
      /\.default\((-?\d+)\)/.exec(rest);
    if (parsed?.[1] !== undefined) out.set(m[1]!, parsed[1]);
  }
  return out;
}

function parseEnvExample(): { active: Map<string, string>; commented: Set<string>; text: string } {
  const text = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const active = new Map<string, string>();
  const commented = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const asCommented = /^#\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (asCommented) {
      commented.add(asCommented[1]!);
      continue;
    }
    if (line.startsWith('#')) continue;
    const asActive = /^([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (asActive) active.set(asActive[1]!, (asActive[2] ?? '').trim());
  }
  return { active, commented, text };
}

describe('P1-3 .env.example ↔ ConfigSchema parity', () => {
  it('documents every variable the code reads', () => {
    const { active, commented } = parseEnvExample();
    const documented = new Set([...active.keys(), ...commented]);
    const missing = configKeys().filter((key) => !documented.has(key));
    expect(missing, 'read by ConfigSchema but absent from .env.example').toEqual([]);
  });

  it('never advertises an active variable that nothing reads', () => {
    const { active } = parseEnvExample();
    const read = new Set(configKeys());
    const phantom = [...active.keys()].filter((key) => !read.has(key) && !PROCESS_ENV_ONLY.has(key));
    expect(phantom, 'uncommented in .env.example but not read by ConfigSchema').toEqual([]);
  });

  it('shows the real default for every variable that has one', () => {
    const { active } = parseEnvExample();
    const defaults = schemaDefaults();
    const mismatches: string[] = [];
    for (const [key, def] of defaults) {
      const shown = active.get(key);
      if (shown === undefined) continue; // optional/commented-out: nothing to compare
      if (shown !== def) mismatches.push(`${key}: .env.example="${shown}" schema default="${def}"`);
    }
    expect(mismatches, 'template value differs from the schema default').toEqual([]);
  });

  it('drops the names that were documented but never read', () => {
    const { active } = parseEnvExample();
    const neverRead = [
      // a wrong name for a real variable — setting it did nothing while the real cap stayed at 10
      'LLM_DAILY_SPEND_CAP_USD',
      'LLM_FAKE_MODE',
      // vendor-specific keys: the code reads LLM_API_KEY / AUDITOR_LLM_API_KEY and resolves the
      // provider from LLM_PROVIDER + LLM_PRESET (config/llm-presets.json)
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY_SPARE_1',
      'GROQ_API_KEY_SPARE_1',
      'OLLAMA_BASE_URL',
    ];
    const resurrected = neverRead.filter((key) => active.has(key));
    expect(resurrected, 'unread variables must stay out of the active block').toEqual([]);
  });

  it('keeps the planned P5+ variables behind an explicit banner, commented out', () => {
    const { text, active } = parseEnvExample();
    expect(text).toMatch(/PLANNED — NOT READ BY ANY CODE YET/);
    // every planned variable must be commented, so nobody sets it and assumes it took effect
    const bannerAt = text.indexOf('PLANNED — NOT READ BY ANY CODE YET');
    expect(bannerAt).toBeGreaterThan(-1);
    // slice from the start of the banner's own line, not from mid-comment
    const afterBanner = text.slice(text.lastIndexOf('\n', bannerAt) + 1);
    for (const line of afterBanner.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      throw new Error(`uncommented line after the PLANNED banner: ${trimmed}`);
    }
    // and the active block must still be complete on its own
    expect(active.has('LLM_PROVIDER')).toBe(true);
    expect(active.has('LLM_DAILY_BUDGET_USD')).toBe(true);
    expect(active.has('INTERNAL_API_TOKEN')).toBe(true);
  });
});

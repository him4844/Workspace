/**
 * Config & secrets (SPEC §37, docs/12_environment_variables.md).
 * Fail-fast Zod validation at boot; no module reads process.env directly.
 */
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (def: boolean) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const int = (def: number) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10))).pipe(z.number().int());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:3000'),
  API_PORT: int(3000),
  LOG_LEVEL: z.string().default('info'),
  DEFAULT_LOCALE: z.string().default('uz'),
  ORG_NAME: z.string().default('WPP Internal Team'),

  DB_DRIVER: z.enum(['pglite', 'postgres']).default('pglite'),
  PGLITE_DIR: z.string().default('.pglite'),
  DATABASE_URL: z.string().optional(),

  SESSION_SECRET: z.string().default('dev-only-session-secret'),
  TOKEN_ENCRYPTION_KEY: z.string().default('dev-only-token-key-change-me'),
  INTERNAL_API_TOKEN: z.string().default('dev-internal-token'),
  ADMIN_EMAIL: z.string().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().default('change-me-on-first-login'),

  IG_APP_ID: z.string().optional(),
  IG_APP_SECRET: z.string().default('dev-ig-app-secret'),
  IG_VERIFY_TOKEN: z.string().default('dev-verify-token'),
  IG_GRAPH_BASE: z.string().default('https://graph.instagram.com'),
  IG_BUSINESS_ACCOUNT_ID: z.string().optional(),
  HUMAN_AGENT_TAG_ENABLED: bool(false),
  CHANNEL_SIMULATOR_ENABLED: bool(true),
  WEBHOOK_REQUIRE_SIGNATURE: bool(true),

  // PGlite is a single-process embedded database: with the pglite driver the worker
  // loop always runs inside the API process (see DECISIONS.md D-022).
  EMBEDDED_WORKER: bool(false),
  // ---- LLM providers (SPEC §51, D-015). 'none' = run without AI (Phase 1 behaviour).
  LLM_PROVIDER: z.enum(['none', 'scripted', 'openai', 'openrouter', 'openai-compatible', 'anthropic']).default('none'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  REQUIREMENTS_LLM_PROVIDER: z.string().optional(),
  REQUIREMENTS_LLM_MODEL: z.string().optional(),
  LLM_DAILY_BUDGET_USD: z.string().optional().transform((v) => (v === undefined || v === '' ? 10 : Number.parseFloat(v))),
  AGENT_MAX_REPAIRS: int(1),

  WORKER_CONCURRENCY: int(2),
  JOB_POLL_INTERVAL_MS: int(2000),
  JOB_LEASE_SECONDS: int(120),

  SEND_RATE_PER_MINUTE: int(30),
  WINDOW_WARNING_HOURS: int(2),
  ECHO_REPLY_TEMPLATE: z.string().default(
    'Assalomu alaykum! Xabaringiz uchun rahmat — tez orada savollaringizni beraman. (WPP intake)',
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;
  loadDotEnv();
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration (docs/12_environment_variables.md): ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const c = parsed.data;
    const weak: string[] = [];
    if (c.SESSION_SECRET.startsWith('dev-')) weak.push('SESSION_SECRET');
    if (c.TOKEN_ENCRYPTION_KEY.startsWith('dev-')) weak.push('TOKEN_ENCRYPTION_KEY');
    if (c.INTERNAL_API_TOKEN.startsWith('dev-')) weak.push('INTERNAL_API_TOKEN');
    if (c.CHANNEL_SIMULATOR_ENABLED) weak.push('CHANNEL_SIMULATOR_ENABLED must be false in production');
    if (!c.WEBHOOK_REQUIRE_SIGNATURE) weak.push('WEBHOOK_REQUIRE_SIGNATURE must be true in production');
    if (weak.length > 0) throw new Error(`Unsafe production configuration: ${weak.join(', ')}`);
  }
  cached = parsed.data;
  return parsed.data;
}

/** Test helper: build a config object without touching the process environment. */
export function configFrom(overrides: Partial<Record<string, string>> = {}): Config {
  const parsed = ConfigSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

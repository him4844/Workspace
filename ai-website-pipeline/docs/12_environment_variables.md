# Deliverable 13 — Environment Variables

**Status:** Phase 0 design. `.env.example` in the repo mirrors this list. Secrets are provided at runtime only (§37); this document never contains real values.

Legend: **R** required, **O** optional, **D** dev-only.

## 1. Core runtime

| Var | R/O | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | R | `development` | `development \| test \| production` |
| `APP_URL` | R | `http://localhost:3000` | public base URL (panel + links in messages) |
| `API_PORT` | O | `3000` | api listen port |
| `PANEL_PORT` | O | `3100` | panel listen port |
| `LOG_LEVEL` | O | `info` | pino level (`debug` in dev) |
| `TZ` | O | `UTC` | storage is always UTC; display converts |
| `DEFAULT_LOCALE` | O | `uz` | client-facing message locale (`uz \| ru \| en`) |

## 2. Database

| Var | R/O | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | R | — | `postgres://user:pass@host:5432/wpp` (prod/staging) |
| `DB_DRIVER` | O | `postgres` | `postgres \| pglite` (dev/CI portability) |
| `PGLITE_DIR` | D | `.pglite` | PGlite data dir when `DB_DRIVER=pglite` |
| `DB_POOL_MAX` | O | `10` | connection pool size |
| `DB_STATEMENT_TIMEOUT_MS` | O | `30000` | safety net for long queries |

## 3. Auth & crypto

| Var | R/O | Purpose |
|---|---|---|
| `SESSION_SECRET` | R | 256-bit random; cookie signing |
| `TOKEN_ENCRYPTION_KEY` | R | 32-byte base64 key; AES-256-GCM for Instagram tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | D | seed-only admin creation (must be changed on first login) |
| `TOTP_ISSUER` | O | TOTP label (`WPP`) |
| `AUTH_LOGIN_MAX_ATTEMPTS` | O | 10/min/IP default |

## 4. Instagram / Meta

| Var | R/O | Purpose |
|---|---|---|
| `IG_APP_ID` | R* | Meta app id (Instagram product) |
| `IG_APP_SECRET` | R* | app secret; webhook HMAC + token exchange |
| `IG_VERIFY_TOKEN` | R* | webhook verification token (chosen by us, set in App Dashboard) |
| `IG_OAUTH_REDIRECT_URI` | R* | must match the app's configured redirect |
| `IG_GRAPH_BASE` | O | `https://graph.instagram.com` (override for tests) |
| `IG_BUSINESS_ACCOUNT_ID` | O | the professional account id (or resolved at connect) |
| `HUMAN_AGENT_TAG_ENABLED` | O | `false`; flip only after App Review approves the feature |
| `CHANNEL_SIMULATOR_ENABLED` | D | `true` in dev/CI, `false` in prod |
| `WEBHOOK_REQUIRE_SIGNATURE` | O | `true` (never disable in prod; tests sign payloads) |

\* Required once the Instagram channel is actually connected; Phases 1–4 run fully on the simulator without them.

## 5. LLM providers (per agent overrides live in DB, not env)

| Var | R/O | Purpose |
|---|---|---|
| `LLM_PROVIDER` | D | `none` (default — no AI configured), `scripted` (in-process client persona for demos/CI, D-025), `openai`, `openrouter`, `openai-compatible`, `anthropic` |
| `LLM_API_KEY` | O | provider key; absent key + a real provider ⇒ the platform runs with **no** LLM (`resolveLlmClient` → null), never a silent fallback |
| `LLM_BASE_URL` | O | OpenAI-compatible gateway / proxy / self-hosted endpoint |
| `LLM_MODEL` | O | default model for agents that do not pin one in `agent_config_versions` |
| `REQUIREMENTS_LLM_PROVIDER` / `REQUIREMENTS_LLM_MODEL` | O | per-agent override (SPEC §51); the Spec Auditor uses the `AUDITOR_LLM_*` route above so it never writes and reviews on one route (D-037 — a *different provider* is the intent, a different model+key is what the available free keys allow) |
| `LLM_PRESET` | O | named route from `config/llm-presets.json` (`gemini-free`, `groq-free`, `openrouter-free`, `ollama-local`, `scripted`, `none`, `openai-paid`, `anthropic-paid`); when set, its base URL and model are the defaults (env still overrides) |
| `LLM_FREE_ONLY` | D | `true` — **the project is free-only** (D-029): a route that is not marked `free` in the presets file, and whose host is not a documented free tier or a local/LAN address, is refused; OpenRouter additionally requires a model slug ending in `:free` (paid models share its host) |
| `LLM_DAILY_BUDGET_USD` | D | `10` — enforced before every paid LLM request (§26), UTC day. The worker atomically reserves a 25%-padded worst-case prompt+output estimate, settles actual usage afterward, and blocks unknown-price paid models. Free presets make no reservation; with `LLM_FREE_ONLY=true` expected spend remains $0 |
| `AGENT_MAX_REPAIRS` | D | `1` — the single repair attempt of §49 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | **not read by the code today**: the factory only reads `LLM_API_KEY`. Kept in this table as the names an operator would expect; adopt them (as aliases) if they are preferred over the generic key |
| `OPENROUTER_API_KEY` | O | OpenRouter adapter |
| `OLLAMA_BASE_URL` | O | local/self-hosted OpenAI-compatible endpoint |
| `AUDITOR_LLM_PROVIDER` / `AUDITOR_LLM_PRESET` / `AUDITOR_LLM_BASE_URL` / `AUDITOR_LLM_MODEL` / `AUDITOR_LLM_API_KEY` | O | the Spec Auditor's **own route** (§20): real routes are refused if they resolve to the writer's vendor or reuse its key; there is no silent same-provider fallback. Current free setup: Gemini writer + OpenRouter `:free` auditor (D-055). Scripted tests stay hermetic; the audit row records the actual provider/model |
| `GROQ_API_KEY_SPARE_1` / `GROQ_API_KEY_SPARE_2` | O | extra free-tier keys for manual rotation; note that Groq's request/TPM limits are **per organization**, so spares do not multiply the budget (they only survive a revoked key) |
| `LLM_FAKE_MODE` | D | `true` → deterministic fake provider for tests |

## 6. Builds & code checking (coderunner)

| Var | R/O | Default | Purpose |
|---|---|---|---|
| `WORKSPACES_DIR` | O | `./data/workspaces` | build sandboxes |
| `ARTIFACTS_DIR` | O | `./data` | artifact store root |
| `BUILD_INSTALL_TIMEOUT_MS` | O | `900000` | `npm ci` cap |
| `BUILD_TIMEOUT_MS` | O | `900000` | build cap |
| `BUILD_MEM_LIMIT_MB` | O | `900` | per-job memory cap |
| `BUILD_MAX_CONCURRENCY` | O | `1` | concurrent builds (sandbox: 1, VPS: 2) |
| `CHECK_TIMEOUT_MS` | O | `1200000` | code-check cap |
| `CHECK_VIEWPORTS` | O | `390x844,768x1024,1440x900` | responsive widths (§25A.4) |
| `CHECK_AXE` / `CHECK_LINKS` / `CHECK_SECURITY` | O | `true` | toggle sub-checks |
| `PLAYWRIGHT_BROWSERS_PATH` | O | `.cache/ms-playwright` | chromium location |
| `NPM_REGISTRY_ALLOWLIST` | O | `registry.npmjs.org` | install-time network allowlist |
| `PREVIEW_PORT` / `PREVIEW_BASE_URL` | O | — | static preview server |

## 7. Orchestration & limits (defaults; DB `config_values` wins over env)

| Var | R/O | Default | Purpose |
|---|---|---|---|
| `EMBEDDED_WORKER` | O | `false` | run the orchestrator loop inside the API process. Forced **on** when `DB_DRIVER=pglite` — PGlite is an embedded single-process Postgres and a second process cannot open the same data dir (Phase 1 finding, D-022) |
| `WORKER_CONCURRENCY` | O | `2` | parallel jobs (sandbox: 1–2) |
| `JOB_POLL_INTERVAL_MS` | O | `5000` | orchestrator poll |
| `JOB_LEASE_SECONDS` | O | `120` | lease/heartbeat |
| `LOOP_SPEC_AUDIT_MAX` | O | `3` | §21 |
| `LOOP_CODE_CHECK_MAX` | O | `3` | §26 |
| `LOOP_CLIENT_REVISION_MAX` | O | `5` | client change cycles |
| `LOOP_REQUIREMENTS_MAX_QUESTIONS` | O | `40` | questionnaire cap (§10) |
| `INACTIVITY_REMINDER_HOURS` / `INACTIVITY_MAX_REMINDERS` | O | `24` / `2` | client silence handling (§10) |
| `SEND_RATE_PER_MINUTE` | O | `30` | enforced outbound limit per Instagram connection, fixed 60-second window; excess inline sends are queued and worker sends retry at the next window |
| `WINDOW_WARNING_HOURS` | O | `2` | panel warning before 24 h window closes (§31A) |

## 8. Deploy & ops

| Var | R/O | Purpose |
|---|---|---|
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | O | pg_dump + artifact sync target (default 30) |
| `SMTP_URL` | O | task notification emails (Phase 7) |
| `ALERT_WEBHOOK_URL` | O | ops alerts (dead letters, token expiry, spend cap) |
| `SENTRY_DSN` | O | error tracking (optional) |
| `PANEL_ALLOWED_ORIGINS` | O | CSRF/CORS allowlist |

## 9. Rules

1. `.env` is git-ignored; `.env.example` is the contract and must be updated in the same commit as any new variable.
2. No module reads `process.env` directly except `packages/infra/config`, which validates everything with Zod at boot and **fails fast** with a readable list of missing variables.
3. Anything that a human might want to tune at runtime belongs in `config_values` (DB), not env — env is for deployment-shaped values.

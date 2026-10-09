# Deliverable 2 — Component Architecture

**Status:** Phase 0 design. Companion to `01_system_architecture.md`.

## 1. Layering (inside every process)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Interface layer                                                    │
│  api routes · webhook handler · panel pages · CLI                  │
├─────────────────────────────────────────────────────────────────────┤
│  Application layer (use-cases)                                      │
│  commands: StartRequirementsTurn · ApproveSpec · StartBuild · …     │
│  each use-case = 1 transaction: guards → effects → events → jobs    │
├─────────────────────────────────────────────────────────────────────┤
│  Domain layer (packages/core) — pure TypeScript, no IO              │
│  state machine · guards · completeness engine · window math ·       │
│  priority rules · 10A status rules · loop-limit policy               │
├─────────────────────────────────────────────────────────────────────┤
│  Infrastructure layer                                              │
│  repositories (Drizzle) · job queue · artifact store · LlmClient ·  │
│  channel adapters · crypto · clock · logger                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** interface → application → domain; infrastructure is injected. The domain layer imports nothing from infrastructure (enforced by an ESLint boundary rule + a unit test that fails on violations). This is what makes the state machine 100% unit-testable and the future SaaS extraction mechanical (§2, §P1).

## 2. Component inventory

| Component | Process | Responsibility | Phase |
|---|---|---|---|
| `http-api` | api | REST for panel, webhooks, previews, health | 1 |
| `webhook-verifier` | api | raw-body signature check, dedupe insert | 1 |
| `conversation-engine` | shared | normalize events, thread resolution, per-conversation state (§32) | 1 |
| `channel-instagram` | shared | parse/send via graph.instagram.com, window math, rate bucket | 1 |
| `channel-simulator` | shared | dev/test channel (§8 of IG doc) | 1 |
| `project-state-machine` | shared (core) | transition table, guards, effects | 1 |
| `orchestrator` | worker | job scheduler: claim, route by state, enforce caps, retry policy | 1 |
| `agent-runtime` | worker | prompt assembly, LLM call, schema validation + repair, run logging | 2 |
| `requirements-engine` | shared | questionnaire data model, field updates, contradictions, completeness | 2 |
| `spec-generator` | worker | runs Specification Agent → spec vN + client summary | 3 |
| `approval-tracker` | worker/api | intent parsing, approval recording, spec locking | 3 |
| `spec-auditor-runner` | worker | audit run + revision loop (max 3) | 4 |
| `build-runner` | coderunner | workspace mgmt, coding agent invocation, install/build/test, logs | 5 |
| `preview-server` | api | serve built sites under `/preview/:buildId` | 5 |
| `code-checker` | coderunner | Playwright E2E, responsive, links/console, security, evidence capture | 6 |
| `task-manager` | shared | create/assign/close human tasks (§29, §42) | 1/7 |
| `panel` | panel | dashboard, project page (10 questions §48), actions | 7 |
| `team-assistant` | worker | summaries, explanations, drafts, Stitch prompts (§43, §44) | 7 |
| `artifact-store` | shared | fs now / S3 later, hashing, version paths (§45) | 3 |
| `notifier` | worker | in-panel notifications, email/webhook alerts for urgent tasks | 7 |
| `watchdog` | worker | stranded projects, stuck leases, token expiry, silent clients | 1/7 |
| `admin-cli` | cli | migrate, seed, create admin, requeue jobs, replay webhook | 1 |

## 3. Component interaction for the two hardest flows

### 3.1 Build → Check (Phases 5–6)

```
orchestrator ──BUILD_RUN──▶ build-runner
   │  (state=BUILDING, build vN row WORKSPACE_READY)
   ├─▶ coding-agent → file tree → artifact-store (workspace.tar)
   ├─▶ npm ci && npm run build   (timeout 15 min, mem cap)  → build.log
   ├─▶ npm test (if present)                                 → test.log
   ├─▶ start server on ephemeral port, smoke-check 200      → smoke.json
   ├─▶ if ok: builds.status=BUILT, preview_url=/preview/<id>/ ; enqueue CODE_CHECK
   └─▶ if not: builds.status=FAILED, error_json structured (§40), retry policy
        └─ retries exhausted → FAILED state + human task

code-checker ──▶ loads spec_requirements (+ACs) from DB
   ├─▶ maps each requirement to one or more checks (test file, DOM probe, API probe)
   ├─▶ runs Playwright (chromium) at 390/768/1440 widths; console+network capture; screenshots
   ├─▶ runs acceptance tests generated earlier by the coding agent + generated on the fly if missing
   ├─▶ runs link crawler, axe-core (a11y), `npm audit --json`, secret scan, route-protection probes
   ├─▶ writes verification_results + check_findings + evidence artifacts
   └─▶ status=PASS|FAIL; FAIL → structured feedback → new build (max 3, then BLOCKED/human)
```

**Isolation:** each build gets `data/workspaces/<projectId>/<buildVersion>/`; only the coderunner process can write there; the preview server mounts `.../dist` **read-only**. Resource caps per job (CPU 1, mem 900 MB, wall clock 15 min) so a runaway AI build cannot take down the platform.

**Determinism:** the coding agent's output is saved as a file tree artifact *before* running installs, so a failed build can be re-run without re-calling the LLM.

### 3.2 Client approval (Phase 3)

```
orchestrator ──CLIENT_SEND──▶ channel adapter (Client Summary + quick replies)
client replies "yes looks great" (or taps ✅)
   └─▶ webhook → intent-classifier (agent) → {intent:'APPROVE', confidence:0.93}
        ├─ confidence ≥ 0.85  → record client_approvals(APPROVED, message_id) → lock spec → SPEC_AUDIT
        ├─ 0.5 ≤ conf < 0.85  → send one clarifying question ("Should I consider this approved?"),
        │                        store pending_clarification on conversation_state
        └─ conf < 0.5         → HUMAN task (ambiguous reply) with the quoted message
Neither fast path ever moves to CLIENT_APPROVED without a stored client message id (§10A).
```

## 4. Orchestrator internals

```
loop every 5 s (configurable) + wake on enqueue (LISTEN/NOTIFY):
  claim up to N jobs:   SELECT … WHERE status='PENDING' AND run_at<=now()
                        ORDER BY priority, run_at FOR UPDATE SKIP LOCKED
  for each job:
    ctx = loadProjectContext(job.project_id)
    allowed = JOB_ALLOWED_STATES[job.type].includes(ctx.project.state)
    if !allowed → job.status='PARKED', reason=STATE_MISMATCH   (re-checked on every transition)
    else → execute handler (idempotency_key checked first)
  lease/heartbeat: RUNNING jobs get lease_expires_at bumped; crashed lease → requeued (attempt+1)
  timers: INACTIVITY_CHECK, TOKEN_REFRESH, WATCHDOG scheduled as recurring jobs
```

Policy table (data, in `config_values`, not code):

| Job type | Concurrency | Timeout | Max attempts | Backoff |
|---|---|---|---|---|
| `REQUIREMENTS_TURN` | 4 | 180 s | 3 | 5 s ×2 |
| `SPEC_GENERATE` / `SPEC_REVISE` | 2 | 300 s | 3 | 30 s ×2 |
| `CLIENT_INTENT_PARSE` | 4 | 120 s | 2 | 5 s |
| `SPEC_AUDIT` | 2 | 300 s | 3 | 30 s ×2 |
| `BUILD_RUN` | 1–2 (CPU-bound) | 1800 s | 2 (LLM) / 1 (install) | manual |
| `CODE_CHECK` | 1–2 | 1200 s | 2 | manual |
| `SEND_OUTBOUND` | 4 | 20 s | 5 | 2 s ×2 |
| `WATCHDOG`/`INACTIVITY_CHECK` | 1 | 30 s | 1 | — |

A retryable provider 429 carrying `retryAfterMs` is scheduled at `run_at = provider deadline + 1 s` instead of ordinary backoff (D-052); waits above 24 h or exhausted attempts go to `DEAD_LETTER`. A dead-letter is atomic with a CRITICAL `SYSTEM_ERROR`, a CRITICAL `HUMAN_REVIEW` task and T30 → `BLOCKED` (D-044), so the project cannot keep consuming jobs silently.

## 5. Failure isolation

- One project's stuck job never blocks others (pure DB queue, no shared in-memory state).
- LLM provider failure degrades to `NEEDS_REVIEW` for quality-sensitive agents; `SEND_OUTBOUND` retries.
- coderunner crash ⇒ leases expire ⇒ jobs requeued; build status never silently "in progress" (watchdog).
- Panel/API restart loses nothing: all state is DB; jobs are DB rows.

## 6. Extensibility points (SaaS path, §2)

| Point | Today | Later |
|---|---|---|
| Tenancy | `org_id` everywhere, single row | row-level security + tenant routing |
| Channels | `channel_type` enum + adapter interface | Telegram/WhatsApp/web-chat adapters (§31) |
| Website types | `questionnaires` rows + `applies_to_project_type` | add packages without code (§7) |
| Pricing/deadline | human-only fields | client portal, quotes (explicitly out of MVP) |
| Deploy | single VPS compose | split DB/workers, managed Postgres, object storage |

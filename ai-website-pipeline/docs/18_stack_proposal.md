# Deliverable 18 — Technology Stack Proposal (Phase 0)

**Status:** PROPOSED — requires explicit human approval before any implementation code (SPEC §55A.3).
**Author:** Coding agent (Phase 0)
**Date:** 2026-10-07
**Decisions referenced:** DECISIONS.md #D-001 … #D-014

---

## 1. Requirements that drive the stack choice

From SPEC §1–§59, the stack must support:

| # | Requirement | Source |
|---|---|---|
| R1 | Central orchestrator + state machine, no agent-to-agent calls | §4 |
| R2 | Durable jobs, retries, backoff, loop caps (3 attempts), no infinite loops | §4, §21, §26, §41 |
| R3 | Strongly structured relational persistence with versions (never destroy history) | §33, §34 |
| R4 | ~10 different AI agents with versioned prompts/configs and structured JSON I/O | §49–§51 |
| R5 | Instagram webhook receiver (signature verification, idempotency) + sender | §31, §31A, §41 |
| R6 | Coding agent that must produce **runnable** projects (install, build, test) | §22, §25A |
| R7 | Code checker that **runs** the app: E2E tests, responsive checks, security scan | §25A |
| R8 | Internal Team Panel (auth, dashboard, 10 questions at a glance) | §27, §28, §48 |
| R9 | Observability: per-project state, active agent, last success/failure, retries | §36, §39 |
| R10 | Security: secrets, RBAC, webhook verification, rate limiting, prompt-injection defense | §37, §38 |
| R11 | Extensible later to multi-tenant SaaS without rewrite | §2 |
| R12 | Cheap to run for a small internal team; self-hostable | §2, business context |

---

## 2. Recommended stack (Option A — TypeScript monorepo)

| Layer | Choice | Version (verified 2026-10-07) |
|---|---|---|
| Language | TypeScript (strict) | TS 5.x |
| Runtime | Node.js LTS | 20.x (workspace), recommend 22 LTS on server |
| Monorepo | npm workspaces (pnpm optional) | npm 10.x |
| API / orchestrator host | **Fastify** | 5.12.x |
| Validation / contracts | **Zod** (+ `fastify-type-provider-zod`) | 4.6.x |
| ORM / migrations | **Drizzle ORM** + drizzle-kit | 0.45.x |
| Database | **PostgreSQL 16** (prod) / **PGlite** (dev, CI, sandboxes) | pg16 / @electric-sql/pglite 0.5.x |
| Job queue | **PostgreSQL-backed queue** (`SKIP LOCKED`, transactional enqueue) | custom, ~300 LOC |
| Team Panel | **Next.js App Router** + React + Tailwind | Next 16.x |
| LLM access | Provider-agnostic `LlmClient`: OpenAI, Anthropic, OpenRouter, OpenAI-compatible (Ollama) | SDKs pinned |
| Browser automation (Code Checker) | **Playwright** (Chromium) + axe-core | latest |
| Auth | Argon2id (`@node-rs/argon2`) + DB sessions + optional TOTP | — |
| Logging | **pino** → stdout + `events` / `agent_runs` tables | pino 10.x |
| Testing | **Vitest** (unit/contract) + PGlite integration + Playwright (E2E) | vitest 5.x |
| Artifacts | Filesystem volume behind `ArtifactStore` interface; S3/MinIO later | — |
| Deployment | Docker Compose on a single VPS (Ubuntu 24.04) + Caddy TLS | — |
| CI | GitHub Actions: typecheck, lint, unit, integration | — |

### 2.1 Why TypeScript-first (rationale)

1. **The Coding Agent's output is JavaScript/TypeScript.** Generated sites (landing pages first, then Next/Astro sites) must be installed, built and tested by the same process. A single language removes an entire translation layer between the platform and the artifacts it produces. (R6, R7)
2. **Playwright is the strongest runtime-verification tool** and is native TS; §25A is the single most differentiating requirement of the whole spec — it must not be bolted on. (R7)
3. **One language across API, workers, panel and the generated projects** means one `node_modules` policy, one test runner, one CI, and one skill profile for the internal team. (R12)
4. **Fastify + Zod** gives schema-first REST with runtime validation and auto-generated OpenAPI — exactly what §49 (structured JSON everywhere) and §7 of the API structure require. Zod schemas double as agent I/O contracts (`docs/contracts/*.json` are generated from the same source in Phase 2+).
5. **Drizzle** keeps the schema in versioned TypeScript files with SQL migrations, supports both PostgreSQL and PGlite with the same query code, and has no runtime magic/codegen step to break CI.
6. **Postgres for queue + data + queue-worker locking** removes Redis from the critical path: a state transition and its follow-up job commit in one transaction → the "no lost job / no double job" guarantees required by §4 and §41 fall out of the database, not out of operational discipline.

### 2.2 Why NOT the alternatives (summary; details in §3)

- **Python (FastAPI + Celery + Postgres + Redis):** excellent for AI/pydantic ergonomics, but splits the repo into two languages (generated sites + Playwright + panel), adds Redis for Celery, and still needs a JS runtime for the coding agent's build/test loop. Not worth the split for a 1–5 person internal team.
- **Django:** batteries-included admin is tempting, but the panel is a bespoke operational UI, and Django's ORM/async story is weaker for a long-running worker + browser automation mix.
- **Next.js-only fullstack (no separate API):** fastest to start, but mixes webhook ingestion, long-running jobs and UI in one process — violates the orchestrator/worker separation the spec demands (§4), and makes it impossible to scale the checker independently.
- **Temporal.io / n8n:** Temporal gives durable workflows but is heavy infrastructure to operate for an internal MVP and would fight the spec's own explicit state machine (§3) and DB-as-truth model. n8n is a no-code tool: too weak for the required guardrails, versioning and audit trail.

### 2.3 Concrete cost estimates

| Item | Assumption | Monthly |
|---|---|---|
| VPS (4 vCPU, 8 GB, 160 GB NVMe) | Hetzner CX42-class / UZ provider equivalent | $18–40 |
| Backup storage (pg_dump + artifacts, 50 GB) | S3-compatible / Backblaze B2 | $1–3 |
| Domain + TLS | Caddy/Let's Encrypt | ~$1 |
| Meta / Instagram Messaging API | free (App Review, Business Verification free) | $0 |
| LLM API usage | see below | $60–400 |
| Playwright / Chromium | OSS | $0 |
| **Total infra (excl. LLM)** | | **$20–45** |

**LLM cost per project (estimate, landing-page class, 2026 pricing):**

| Agent | Calls | Tokens in/out (approx.) | Cheap model ($1/$3 per M) | Strong model ($3/$15 per M) |
|---|---|---|---|---|
| Requirements Agent (whole conversation) | 15–30 | 60k / 12k | $0.10 | $0.36 |
| Specification Agent (+up to 2 revisions) | 2–4 | 40k / 25k | $0.12 | $0.50 |
| Spec Auditor | 1–4 | 30k / 8k | $0.06 | $0.20 |
| Coding Agent (landing page, multi-file) | 5–15 | 250k / 120k | $0.60 | $2.55 |
| Code Checker (analysis + fixes loop) | 2–8 | 120k / 30k | $0.21 | $0.81 |
| Team Assistant | 1–10 | 40k / 10k | $0.07 | $0.22 |
| **Per project** | | | **~$1.2** | **~$4.6** |

⇒ At 40 projects/month: **≈$50 (cheap profile) … $190 (strong profile)**. Mixed routing (cheap models for requirements, strong for coding) lands around **$100–150/month**. These are Phase-0 estimates; real numbers will be measured per agent run in `llm_usage` (§36) from Phase 2 onward.

### 2.4 Risks of this stack

| Risk | Impact | Mitigation |
|---|---|---|
| Postgres-as-queue throughput ceiling (~hundreds of jobs/min) | Low for internal tool | `SKIP LOCKED` + indexes; documented BullMQ/Redis upgrade path (Phase 8) |
| PGlite vs Postgres behavioral differences in dev | Medium | Integration tests run against PGlite AND (CI job) real Postgres 16 in Docker; no Postgres-only features beyond JSONB/SKIP LOCKED used |
| Node memory pressure when the Coding Agent builds big projects on the same box | Medium | Dedicated `coderunner` container with CPU/memory caps; artifacts off-box; queue limits concurrency |
| Prompt/LLM non-determinism making tests flaky | High | Agents are called behind an interface with recorded fixtures; contract tests validate schemas, not prose; the simulator channel makes E2E deterministic |
| Single VPS = single point of failure | Medium | Nightly DB backups + artifact sync; documented restore drill; phase 8 can split DB |

---

## 3. Alternatives considered in detail

### Option B — Python core + React panel

`FastAPI + Pydantic v2 + SQLAlchemy 2 + Alembic + arq/Celery + PostgreSQL + Redis + Next.js panel + playwright-python`.

- **Pros:** Pydantic is the best-in-class tool for the "structured JSON between agents" pillar (§49); richest AI library ecosystem; pleasant async.
- **Cons:** two languages and two toolchains; Redis+Celery operational surface; the coding agent's build loop still requires Node anyway; the panel↔API contract needs duplication (`pydantic` + `zod` schemas that can drift unless generated).
- **Verdict:** viable fallback if the team's existing skills are Python-first. If chosen, replace Drizzle with SQLAlchemy/Alembic and the DB queue with arq/Redis; the rest of the architecture documents are stack-neutral.

### Option C — Next.js fullstack only

- **Pros:** one process, fastest time-to-first-preview, Vercel-deployable.
- **Cons:** webhook processing, long-running agent jobs and headless-browser checks inside one request-serving process; serverless timeouts kill §25A; no clean worker isolation; hardest to evolve to multi-tenant.
- **Verdict:** rejected for the core; acceptable only for the Team Panel, which is how we use Next.js in Option A.

### Option D — Temporal.io (or Restate) for durable orchestration

- **Pros:** durable execution, timers, retries as a platform feature.
- **Cons:** extra cluster (or cloud cost), steeper ops, duplicates the explicit state machine the spec requires in the DB, and makes the Team Panel's "current state" read a Temporal API instead of a table.
- **Verdict:** revisit in Phase 8 if cross-project concurrency grows beyond a Postgres queue's comfort zone.

---

## 4. Component→technology map

```
apps/api          Fastify 5 + Zod 4 + Drizzle         (REST + webhooks + panel backend)
apps/worker       Node 20 + node-cron-free scheduler   (orchestrator loop, agent jobs)
apps/coderunner   Node 20 + Playwright + Chromium      (builds & runs generated projects)
apps/panel        Next.js 16 + Tailwind                (Team Panel UI, Phase 7)
packages/core     domain model, state machine, guard rules (pure TS, 100% unit-tested)
packages/db       Drizzle schema + migrations + PGlite/Postgres adapters
packages/agents   agent registry, prompt templates, JSON contracts, LLM adapters
packages/channels Conversation Engine + Instagram adapter + simulator adapter
packages/infra    jobs queue, artifact store, logging, config/secrets, audit
db/               SQL migrations
infra/            docker-compose, Caddyfile, backup/restore scripts
```

Details: `11_folder_structure.md`.

---

## 5. What changing this stack would cost later

| Change | Cost if done in Phase 1–2 | Cost if done in Phase 5+ |
|---|---|---|
| TypeScript → Python core | Medium (schema + services rewritten, docs unchanged) | Very high (agents, queue, checker) |
| Postgres queue → Redis/BullMQ | Low (interface already isolated in `packages/infra/jobs`) | Low–medium |
| Filesystem artifacts → S3 | Low (`ArtifactStore` interface) | Low |
| Next.js panel → other UI | Medium (routes/types only) | Medium |
| Postgres → other RDBMS | High | Very high |

**Approval decision required:** accept Option A, or switch to Option B/C/D before implementation starts.

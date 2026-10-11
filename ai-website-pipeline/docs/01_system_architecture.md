# Deliverable 1 — System Architecture

**Status:** Phase 0 design. References SPEC §1–§59. Decisions: DECISIONS.md #D-001…D-020.

## 1. What the system is

An internal production pipeline that turns Instagram DM conversations into delivered websites. It is **not** a SaaS (§2) and **not** a chatbot (§preamble). One internal team, one primary Instagram business account, many projects in flight (§2).

```
CLIENT ──Instagram DM──▶ Conversation Engine ──▶ Requirements Agent
                                                      │  structured, versioned requirements
                                                      ▼
                                              Specification Agent ─▶ Client Summary ─▶ CLIENT APPROVAL
                                                      │                                   │
                                                      ▼                                   ▼
                                              Spec Auditor ◀─────────────── revision loop (max 3)
                                                      │ PASS
                                                      ▼
                                              Main Coding Agent ─▶ Build vN (runnable project + preview)
                                                      │
                                                      ▼
                                              Code Checker (runtime verification) ◀─┐
                                                      │ FAIL ──structured feedback────┘ (max 3)
                                                      │ PASS
                                                      ▼
                                              TEAM PANEL ──▶ human team ──▶ price/deadline ──▶ delivery
```

## 2. Architectural principles (traceable to the spec)

| P | Principle | Spec |
|---|---|---|
| P1 | **Single orchestrator.** Agents receive tasks, do work, persist results, report status; only the orchestrator decides what runs next. No agent calls another agent. | §4 |
| P2 | **Explicit state machine** in the database. Project state is data, never inferred from prose. | §3 |
| P3 | **Database is the source of truth.** Every artifact/version/approval/audit/run is a row. Filesystem only stores large blobs behind `ArtifactStore`. | §33, §34, §45 |
| P4 | **Versioned everything.** Requirements, specs, summaries, approvals, builds, audits, checks, change requests are append-only version chains. | §34 |
| P5 | **Structured JSON between components.** Workflow decisions never parse prose. | §49 |
| P6 | **Separation of concerns:** UI layer vs business logic, both in the platform and (mandatorily) in generated projects. | §23 |
| P7 | **Human-in-the-loop gates** are first-class states + tasks with an explicit "why". | §42 |
| P8 | **Security by construction:** secrets in env/secret store, client text is untrusted data, webhook signature verification, RBAC, rate limits, audit log. | §37, §38 |
| P9 | **Observability is a feature:** per-agent runs, per-project health, escalation reasons. | §36, §39 |
| P10 | **Config over code:** questionnaires, question packages, prompts, audit rules, thresholds live in data/config, versioned. | §7, §50, §51 |

## 3. Runtime topology

```
                         ┌────────────────────────────────────────────────┐
   Instagram / Meta      │                    VPS                        │
   webhooks  ───────────▶│  ┌──────────┐   HTTPS   ┌──────────────────┐   │
                         │  │  Caddy   │──────────▶│  apps/api        │   │
   Team browser ────────▶│  │  (TLS)   │           │  Fastify         │   │
                         │  └──────────┘           │  · REST /api/v1  │   │
                         │                         │  · /webhooks/*   │   │
                         │                         │  · /preview/*    │   │
                         │                         └───────┬──────────┘   │
                         │                                 │ SQL (Drizzle)│
                         │        ┌────────────────────────▼───────────┐  │
                         │        │            PostgreSQL 16           │  │
                         │        │  state machine · jobs · versions   │  │
                         │        │  events · agent_runs · llm_usage   │  │
                         │        └───────▲───────────────────▲────────┘  │
                         │                │                   │           │
                         │      ┌─────────┴────────┐   ┌──────┴────────┐  │
                         │      │  apps/worker      │   │ apps/coderun. │  │
                         │      │  orchestrator     │   │ builds+E2E    │  │
                         │      │  agents (LLM)     │   │ Playwright    │  │
                         │      └─────────┬────────┘   └──────┬────────┘  │
                         │                │                   │           │
                         │        ┌───────▼───────────────────▼────────┐  │
                         │        │  data/  (artifacts, workspaces)    │  │
                         │        └────────────────────────────────────┘  │
                         │  apps/panel (Next.js) — served by Caddy       │
                         └────────────────────────────────────────────────┘
                                        │ HTTPS
                                        ▼
                         LLM providers (OpenAI / Anthropic / OpenRouter / local)
                         Instagram Graph API (graph.instagram.com)
```

**Deployment unit:** one repository, four processes (api, worker, coderunner, panel) + Postgres + Caddy, orchestrated by docker-compose. All four processes share `packages/core` and `packages/db` — a modular monolith, not microservices.

## 4. Modules (bounded contexts)

| Module | Responsibility | Key tables | Phase |
|---|---|---|---|
| `identity` | team members, sessions, roles, audit of team actions | `team_members`, `sessions`, `team_actions` | 1 (minimal), 7 |
| `clients` | client records + channel identities + merge rules | `clients`, `client_identities` | 1 |
| `conversations` | normalized channel-independent messaging | `conversations`, `messages`, `conversation_state` | 1 |
| `channels` | adapters: `instagram`, `simulator` | `channel_connections`, `webhook_events` | 1 |
| `projects` | project records + **state machine** + transitions + observability | `projects`, `project_state_transitions` | 1 |
| `requirements` | questionnaire schema, answers, statuses (10A), completeness | `requirement_versions`, `requirement_fields`, `field_status_history`, `contradictions` | 2 |
| `specifications` | spec versions, client summaries, approvals, locking | `spec_versions`, `client_summaries`, `client_approvals` | 3 |
| `audits` | spec audit runs, findings, revision loop | `spec_audits`, `audit_findings` | 4 |
| `builds` | build versions, workspaces, previews, logs | `builds`, `build_logs` | 5 |
| `checks` | code checks, per-requirement verification, evidence | `code_checks`, `check_findings`, `verification_results` | 6 |
| `tasks` | human intervention tasks | `tasks`, `comments` | 1 (model), 7 (UI) |
| `agents` | registry, configs, prompt versions, runs, usage | `agent_configs`, `agent_config_versions`, `agent_runs`, `llm_usage` | 2 |
| `orchestration` | transition engine, loop counters, jobs queue, retries, idempotency | `jobs`, `job_attempts`, `idempotency_keys`, `loop_counters` | 1 |
| `changes` | change requests + impact analysis | `change_requests` | 8 |
| `assistant` | internal Team Assistant (summaries, drafts, estimates) | (`agent_runs` + `tasks`) | 7 |
| `files` | artifact store + metadata | `artifacts` | 3 |
| `observability` | events, agent runs, project health | `events`, `agent_runs` | 1 |

Module dependency rule: **modules talk through their public service interface; cross-module DB access is forbidden** except through `packages/db` repositories owned by the module. This keeps the future SaaS extraction (§2) mechanical.

## 5. Control flow of one job (canonical example)

```
1. Instagram webhook arrives            POST /webhooks/instagram
2. api verifies X-Hub-Signature-256     channels/instagram.verifySignature()
3. api dedupes by event id              INSERT INTO webhook_events ... ON CONFLICT DO NOTHING
4. api normalizes → conversation event  channels/conversation-engine
5. api stores message (idempotent)      messages (unique: connection+mids)
6. api enqueues job                     jobs (type=REQUIREMENTS_TURN, idempotency_key=mid)
   └── same transaction as (5)          ⟹ no message without job, no job without message
7. worker claims job                    UPDATE ... WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED)
8. worker loads project state          projects.state must ∈ allowed set for this job type
9. worker calls agent (LLM)             agents/registry → prompt template vN + JSON schema
10. worker validates output (zod)       invalid → 1 repair attempt → else NEEDS_REVIEW
11. worker persists in one transaction:
       requirement fields + status changes (+ history), agent_run row, events row,
       outbound message row (status=QUEUED), next job (or transition + task)
12. worker moves the outbound message   channel adapter sends via graph.instagram.com
       └── outside 24h window → mark SEND_BLOCKED + create HUMAN task (§31A)
13. worker completes job                attempts, duration, cost recorded
```

Rules enforced by construction:

- a state transition and its consequences are always one DB transaction (§P3);
- every job carries an `idempotency_key`; duplicates are no-ops (§41);
- every loop has a counter in `loop_counters` (**source of truth across restarts**) (§21, §26);
- jobs have `run_at`, `attempts`, `max_attempts`, exponential backoff, `dead_letter` state.

## 6. Data flow / artifact layout

Artifacts follow SPEC §45 logical structure, materialized per project under `data/projects/<project_id>/`:

```
data/projects/<ulid>/requirements/v1.json, v2.json
                     spec/v1.md, v1.json, v2.md …
                     client/summary-v1.md, approvals.json
                     audits/spec-audit-v1.json, code-check-v1.json
                     builds/v1/{workspace/, build.log, test.log, checks/}
                     design/ai-design/, stitch-design/
                     tasks/tasks.json (export)
                     logs/agent-runs/, events/
```

Metadata (sha256, size, mime, version, owner module) lives in `artifacts`; the folder is a cache that can be rebuilt from DB + artifacts (§P3).

## 7. Environments

| Env | DB | Queue | LLM | Instagram | Purpose |
|---|---|---|---|---|---|
| `local` | PGlite file or Postgres via compose | Postgres jobs | real keys or `fake` provider | **simulator** channel | development, unit/integration tests |
| `ci` | PGlite ephemeral + Postgres job in CI | Postgres | `fake` provider (recorded fixtures) | simulator + signed fake webhooks | automated verification |
| `staging` | Postgres | Postgres | real keys, cheap models | Meta app in dev mode / test users | acceptance tests before prod |
| `prod` | Postgres | Postgres | real keys per agent config | live Instagram account | internal production |

The **simulator channel** is a first-class channel adapter (not a mock in tests only): it lets the whole pipeline be exercised end-to-end in every environment without Meta access — required because Meta's App Review gates live messaging (§31A). It is disabled in `prod` by config.

## 8. Non-functional targets (MVP)

| Aspect | Target |
|---|---|
| Webhook ingestion latency | < 300 ms p95 (ack immediately, work in queue) |
| Requirements turn turnaround | < 20 s p95 (LLM-dominated) |
| Concurrent projects | 10 comfortably, 50 with tuning (Postgres queue + concurrency caps) |
| Build/check throughput | 2 concurrent coderunner jobs (resource-capped); queue the rest |
| RPO/RTO | RPO 24 h (nightly dump) → later WAL archiving; RTO < 2 h restore drill |
| Data retention | all versions kept forever (by design, §34); PII minimization + redaction policy in `10_security_architecture.md` |

## 9. Explicitly out of scope for MVP

Public registration, billing, multi-tenant management, marketplace, multi-agency admin (§2); Telegram/WhatsApp/web-chat channels (§31); full Design Swap automation (Phase 8, §24); additional website types beyond landing page until Phase 8 (§46).

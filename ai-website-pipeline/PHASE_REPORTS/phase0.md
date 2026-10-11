# PHASE 0 REPORT — Architecture & Stack

**Phase file:** `docs/phases/00_phase0_architecture_and_stack.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-07 · **Status:** COMPLETE — **APPROVED by the human team on 2026-10-07** (stack Option A accepted; Phase 1 authorised; IG route deferred to Meta submission; mixed LLM providers, auditor on a separate provider). Phase 1 started the same day.

> Per the phase definition, this phase writes **no application code**; the repository skeleton contains configuration and documentation only.

## 1. What was built (deliverable checklist, SPEC §56)

| # | Required deliverable | Where | Status |
|---|---|---|---|
| 1 | System architecture | `docs/01_system_architecture.md` | ✅ |
| 2 | Component architecture | `docs/02_component_architecture.md` | ✅ |
| 3 | Database schema (DDL-level) | `docs/03_database_schema.md` | ✅ |
| 4 | Entity relationships | `docs/04_entity_relationships.md` | ✅ |
| 5 | State machine (23 states, transition table, guards, invariants) | `docs/05_state_machine.md` | ✅ |
| 6 | Agent architecture | `docs/06_agent_architecture.md` | ✅ |
| 7 | Agent I/O contracts | `docs/06_agent_architecture.md` §8 + **8 machine-readable JSON Schemas** in `docs/contracts/` | ✅ |
| 8 | API structure | `docs/07_api_structure.md` | ✅ |
| 9 | Instagram integration architecture | `docs/08_instagram_integration.md` | ✅ |
| 10 | Team Panel architecture | `docs/09_team_panel_architecture.md` | ✅ |
| 11 | Security architecture | `docs/10_security_architecture.md` | ✅ |
| 12 | Folder/project structure | `docs/11_folder_structure.md` + repository skeleton | ✅ |
| 13 | Environment variables list | `docs/12_environment_variables.md` + `.env.example` | ✅ |
| 14 | MVP implementation plan | `docs/13_mvp_plan.md` (incl. sequential vs parallel decision) | ✅ |
| 15 | Testing strategy | `docs/14_testing_strategy.md` | ✅ |
| 16 | Deployment strategy | `docs/15_deployment_strategy.md` | ✅ |
| 17 | Known risks | `docs/16_known_risks.md` (incl. all §31A items) | ✅ |
| 18 | Unresolved decisions | `docs/17_open_questions.md` (22 questions + 6 spec observations) | ✅ |
| + | Stack proposal with alternatives/costs/risks | `docs/18_stack_proposal.md` | ✅ |
| + | Meta platform verification (§31A) | `docs/19_meta_platform_findings.md` (dated, sourced) | ✅ |
| + | Decision log | `DECISIONS.md` (D-001…D-021) | ✅ |
| + | Repo skeleton (no feature code) | `apps/`, `packages/`, `db/`, `config/`, `infra/`, `scripts/`, `tests/` | ✅ |

## 2. Headline decisions requiring approval

1. **Stack (Q1):** TypeScript monorepo — Fastify + Zod API, Drizzle + PostgreSQL 16, Next.js panel, Playwright runtime checks, Postgres-backed job queue; PGlite for dev/CI. Alternatives (Python core / Next-only / Temporal) documented with trade-offs. Est. infra **$20–45/mo** + LLM **~$1.2–4.6/project**.
2. **Instagram path (Q2):** Instagram API with Instagram Login (no Facebook Page); adapter designed so the FB-Login route is a swap, not a rewrite.
3. **Simulator channel now (D-013):** Phases 1–7 are developable and testable *without* Meta access, decoupling development from the weeks-long App Review (risk A1).
4. **Sequential development, parallel external tracks:** Meta review / test IG account / LLM keys / hosting / design tokens start now (see `docs/13_mvp_plan.md` §0).

## 3. How it was verified (real results, not claims)

| Check | Command / method | Result |
|---|---|---|
| All 8 agent contracts are valid JSON | `python3 json.load` over `docs/contracts/*.json` | **8/8 valid** |
| All 18 deliverables present and non-empty | directory listing + `wc -l` | **present; 3,000+ lines of design docs** |
| SPEC v2 imported verbatim as SPEC.md | `tr -d '\r' < Writing_v2.md.txt > SPEC.md` | 1,899 lines, CRLF-normalized |
| Phase files available in-repo | copy from `phases.zip` to `docs/phases/` | 11 files (COMMON_RULES + 9 phase files + README) |
| Meta rules verified against **current** official docs (§31A) | two official developer-docs pages (updated 2026-09-16 / 2026-09-28) + 4 corroborating sources, all dated in `docs/19` | findings recorded incl. 24h window, 7-day human_agent, permission names, token lifecycle, rate limits, webhook signature rule, dedupe requirement |
| Environment capability check (what this sandbox can run) | node 20.20 / npm 10.8 / python 3.13 / **no docker, no postgres, no redis, no chromium**; 2 vCPU; ~1.9 GB RAM; 20 GB disk | documented → drove D-004 (PGlite) and the deployment plan |
| Stack candidate versions exist in the registry | `npm view` on fastify, drizzle-orm, @electric-sql/pglite, zod, vitest, next, pino | all resolved (e.g. fastify 5.12.5, drizzle-orm 0.45.3, pglite 0.5.8) |

**What could NOT be verified yet (honest list):** no application exists, so no runtime tests were possible in this phase; Meta findings are documentation-based, not live-API-based (no Meta app exists yet); cost estimates are modelled, not measured.

## 4. Incomplete / risky

- **Not started (correctly):** any implementation, Docker images, CI workflows beyond a placeholder, real LLM prompts.
- **Carried risk:** Meta App Review latency (A1) — mitigated by the simulator, but the *first live Instagram loop* still depends on external approval.
- **Open decisions:** 22 questions in `docs/17_open_questions.md`; Q1–Q6 block Phase 1 start.
- **Environment caveat:** this dev sandbox cannot run Chromium/Postgres/Docker; runtime verification for the Code Checker (Phase 6) must run on the VPS/staging (Q8).

## 5. Open questions (blocking subset)

Q1 stack · Q2 IG route · Q3 Meta submission owner · Q4 LLM provider & budget · Q5 client languages · Q6 hosting/domain. Full list: `docs/17_open_questions.md`.

## 6. Proposed next step

On approval:
1. Answer Q1–Q6 (or accept the proposed defaults).
2. Start **Phase 1** (`docs/phases/01_phase1_instagram_and_conversations.md`): webhook + conversation engine + simulator + state-machine core + project/client creation, with tests that actually run.
3. Simultaneously kick off the parallel tracks (Meta app/verification, test IG account, LLM keys) since those are on the critical path for *live* use.

**APPROVAL RECORDED 2026-10-07.** Answers: Q1 = Option A (TypeScript monorepo) ✅; Q2 = start Phase 1 immediately ✅; Q3 = IG route decided before Meta submission; Q4 = mixed LLM providers (auditor independent) ✅. → Phase 1 underway (`PHASE_REPORTS/phase1.md`).

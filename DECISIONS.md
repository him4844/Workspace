# DECISIONS.md — Architectural Decision Log

Format: `#D-nnn | date | decision | reasoning | status | affected docs`
Required by SPEC §55A.7. Every architectural decision lands here with its reasoning. Statuses: **ACCEPTED** (implemented in design), **PROPOSED** (needs approval), **SUPERSEDED**.

---

**D-001 | 2026-10-07 | Treat SPEC.md v2 as the single authoritative source; the earlier v1 is superseded.**
Reasoning: v2 changes client approval to a single event at the Client Summary, unifies requirement statuses (§10A), mandates runtime verification (§25A), makes Meta constraints explicit risks (§31A) and adds the stack-approval gate (§55A). Everything else derives from v2. Status: ACCEPTED → `SPEC.md`, all docs.

**D-002 | 2026-10-07 | Build order is strictly sequential by SPEC phase; external dependencies are parallel tracks.**
Reasoning: each phase's acceptance test is the next phase's prerequisite (§47), but Meta App Review latency is weeks and independent of development (§31A). So: development sequential; Meta review / IG account / design tokens / LLM keys / hosting run in parallel from week 1. Status: ACCEPTED → `docs/13_mvp_plan.md` §0.

**D-003 | 2026-10-07 | Stack: TypeScript monorepo — Fastify + Zod (API), Drizzle + PostgreSQL (data), Next.js (panel), Playwright (runtime checks), Postgres-backed job queue.**
Reasoning: the Coding Agent's output is JS/TS, so one language removes a translation layer and lets install/build/test run natively (§22, §25A); Playwright is the strongest tool for mandatory runtime verification; Postgres as queue + store gives transactional enqueue and idempotency by construction (§4, §41). Alternatives (Python core, Next-only, Temporal) documented. Status: **PROPOSED — requires human approval (§55A.3)** → `docs/18_stack_proposal.md`.

**D-004 | 2026-10-07 | PGlite for dev/CI instead of requiring Docker/Postgres locally.**
Reasoning: the current dev sandbox has no Docker/Postgres; PGlite is real Postgres (WASM) so SQL semantics stay close, and CI additionally runs the same integration suite against Postgres 16 to catch drift (risk C2). Status: ACCEPTED → `docs/18`, `docs/14`.

**D-005 | 2026-10-07 | Jobs are DB rows with `FOR UPDATE SKIP LOCKED`, not Redis/BullMQ.**
Reasoning: a state transition and its follow-up job must commit atomically (no lost job / no double job, §4, §41); one fewer service to operate; upgrade path to BullMQ isolated behind `packages/infra/jobs` if throughput ever demands it. Status: ACCEPTED.

**D-006 | 2026-10-07 | Agents never perform state transitions; only the orchestrator does (§4).**
Reasoning: traceability, retries, loop protection, and audit all depend on a single choke point. Enforced by architecture (no agent→agent transport; guards live in `packages/core`). Status: ACCEPTED → `docs/06`.

**D-007 | 2026-10-07 | Loop counters live in the database, not memory.**
Reasoning: "no infinite AI loops" (§§21, 26) must survive process restarts and deploys; counters are therefore rows (`loop_counters`), asserted by tests. Status: ACCEPTED → `docs/05` §4.

**D-008 | 2026-10-07 | Enforce §10A at the database level: `CLIENT_CONFIRMED`/`CLIENT_APPROVED_DEFAULT` require a real client message reference (CHECK constraint).**
Reasoning: "never present AI inference as client confirmation" (§53) should be impossible to violate, not merely discouraged. Status: ACCEPTED → `docs/03` §5.

**D-009 | 2026-10-07 | One formal client approval only, at the Client Summary, recorded with the exact message id; approved spec LOCKED; later changes via Change Requests.**
Reasoning: v2 revision note #1 + §§18–19, 35. Approvals table is immutable; re-approval of the same version is idempotent. Status: ACCEPTED → `docs/05` T10/T33, `docs/03` §6.

**D-010 | 2026-10-07 | Keep all 23 SPEC states exactly as listed, including splitting price and deadline into two states with two human actions.**
Reasoning: §3 is explicit; §30 describes the human decision content, not a requirement to merge the states. Status: ACCEPTED (Q9 double-checks with the team) → `docs/05`.

**D-011 | 2026-10-07 | `BLOCKED` stores `blocked_from` so resolution returns the project to the correct state; `FAILED` is quarantined into `BLOCKED` for human triage.**
Reasoning: §42 requires stopping with an explanation, not losing the pipeline position. Status: ACCEPTED → `docs/05` T30–T32.

**D-012 | 2026-10-07 | Instagram integration path: **Instagram API with Instagram Login** (`graph.instagram.com`, permissions `instagram_business_basic` + `instagram_business_manage_messages`); FB-Login route stays as a documented adapter fallback.**
Reasoning: no Facebook Page dependency; simpler OAuth; Meta's current documented path for professional accounts. Status: **PROPOSED (Q2)** → `docs/08`.

**D-013 | 2026-10-07 | A first-class **simulator channel** ships in Phase 1 and every phase is testable without Meta access.**
Reasoning: Meta messaging requires App Review + Business Verification (weeks, rejectable). Without a simulator, Phases 1–7 would be blocked on an external gate. It also makes E2E tests deterministic (fake clock, injected messages). Status: ACCEPTED → `docs/08` §8.

**D-014 | 2026-10-07 | The platform tracks the messaging window per conversation and blocks out-of-window sends, creating a human fallback task; `human_agent` tag is a human-only, config-gated path.**
Reasoning: §31A design consequences; price/deadline messages (§30) cannot legally be sent outside the window except by a human agent within 7 days. Status: ACCEPTED → `docs/08` §5.

**D-015 | 2026-10-07 | Agents call LLMs through a provider-agnostic `LlmClient` with per-agent versioned configs (`agent_config_versions`); structured outputs are JSON-Schema-validated with exactly one repair attempt.**
Reasoning: §49–§51; provider flexibility, cost routing, reproducibility (every run references the config version), and no prose parsing for workflow decisions. Status: ACCEPTED → `docs/06`.

**D-016 | 2026-10-07 | Generated projects are untrusted code: builds run in a resource-capped, secret-free coderunner; previews are cookieless static serving with restrictive CSP.**
Reasoning: §37 security posture; a hallucinated or malicious build must not reach host secrets or the panel origin. Status: ACCEPTED → `docs/10` §6.

**D-017 | 2026-10-07 | Prompt-injection defense is structural: fixed prompt assembly order, client content only inside a delimited DATA block, no agent tool access to side effects, schema-validated outputs.**
Reasoning: §38 requires client messages to be content, never instructions — enforced by assembly rather than by asking the model nicely. Status: ACCEPTED → `docs/06` §4, `docs/10` §5.

**D-018 | 2026-10-07 | The Team Panel never sends price/deadline; the API rejects price/deadline writes whose actor is not a human member.**
Reasoning: §30 is a business rule; structure makes violation impossible rather than a UI convention. Status: ACCEPTED → `docs/09` §5.

**D-019 | 2026-10-07 | Artifacts follow the §45 logical structure on disk, but the database remains the source of truth; `data/` is a regenerable projection.**
Reasoning: §45 describes a logical structure; keeping DB authoritative preserves §34 versioning guarantees and makes backups/restores verifiable. Status: ACCEPTED → `docs/01` §6.

**D-020 | 2026-10-07 | Coderunner concurrency and build resources are capped (1 CPU, 900 MB, 15 min, ≤2 concurrent).**
Reasoning: dev sandbox and a modest VPS cannot host unbounded builds; runaway AI builds must not take the platform down (risk C3). Status: ACCEPTED → `docs/02` §3.1, `docs/12`.

**D-021 | 2026-10-07 | A local git repository is initialized with the Phase 0 commit; `scripts/init-repo.sh` re-creates identity/config for fresh clones.**
Reasoning: the teams' repository is the deliverable surface (§Phase 0 acceptance: "architecture documents committed to the repository"). Verified empirically that git keeps working even if `.git/config` is stripped during workspace transfer, so local commits are safe to keep; the init script restores user identity and hooks on the team's machine. Status: ACCEPTED → `scripts/init-repo.sh`.

---

## Format for future entries

```
**D-0nn | YYYY-MM-DD | <decision in one sentence>**
Reasoning: <why, tied to SPEC sections and risks>
Status: ACCEPTED | PROPOSED | SUPERSEDED by D-0xx → <affected docs>
```

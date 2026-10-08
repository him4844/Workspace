# DECISIONS.md — Architectural Decision Log

Format: `#D-nnn | date | decision | reasoning | status | affected docs`
Required by SPEC §55A.7. Every architectural decision lands here with its reasoning. Statuses: **ACCEPTED** (implemented in design), **PROPOSED** (needs approval), **SUPERSEDED**.

---

**D-001 | 2026-10-07 | Treat SPEC.md v2 as the single authoritative source; the earlier v1 is superseded.**
Reasoning: v2 changes client approval to a single event at the Client Summary, unifies requirement statuses (§10A), mandates runtime verification (§25A), makes Meta constraints explicit risks (§31A) and adds the stack-approval gate (§55A). Everything else derives from v2. Status: ACCEPTED → `SPEC.md`, all docs.

**D-002 | 2026-10-07 | Build order is strictly sequential by SPEC phase; external dependencies are parallel tracks.**
Reasoning: each phase's acceptance test is the next phase's prerequisite (§47), but Meta App Review latency is weeks and independent of development (§31A). So: development sequential; Meta review / IG account / design tokens / LLM keys / hosting run in parallel from week 1. Status: ACCEPTED → `docs/13_mvp_plan.md` §0.

**D-003 | 2026-10-07 | Stack: TypeScript monorepo — Fastify + Zod (API), Drizzle + PostgreSQL (data), Next.js (panel), Playwright (runtime checks), Postgres-backed job queue.**
Reasoning: the Coding Agent's output is JS/TS, so one language removes a translation layer and lets install/build/test run natively (§22, §25A); Playwright is the strongest tool for mandatory runtime verification; Postgres as queue + store gives transactional enqueue and idempotency by construction (§4, §41). Alternatives (Python core, Next-only, Temporal) documented. Status: **ACCEPTED 2026-10-07 — human approved Option A** (§55A.3 gate passed) → `docs/18_stack_proposal.md`.

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
Reasoning: no Facebook Page dependency; simpler OAuth; Meta's current documented path for professional accounts. Status: **PROPOSED — path decision deferred (Q2 answered "unknown"): Meta app submission will pick the route; both adapters stay behind one interface** → `docs/08`.

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

**D-022 | 2026-10-07 | With `DB_DRIVER=pglite` the orchestrator loop runs inside the API process (`EMBEDDED_WORKER` forced on); separate worker processes are only used with PostgreSQL.**
Reasoning: Phase 1 finding — PGlite is an embedded WASM Postgres that holds the data dir for one process only; a second process aborts on open AND a long-running process keeps a snapshot view, so a separately started worker silently sees stale data (verified live: API inserted a job, the standalone worker never claimed it; a third process crashed). `scripts/dev.ts` therefore starts one process in dev and two only for Postgres. Status: ACCEPTED → `docs/12`, `docs/15`, `PHASE_REPORTS/phase1.md`.

**D-023 | 2026-10-07 | Outbound messages that carry no `project_id` are attached to the conversation's open project by the outbound service before any task/event is written.**
Reasoning: Phase 1 test finding — a human-authored message created outside the panel had `project_id = NULL`, so the blocked-send escalation task (SPEC §31A) was invisible in project-scoped queries. Resolving `message.project_id ?? conversation's open project` keeps every escalation attached to the project that owns the conversation. Status: ACCEPTED → `apps/worker/src/services/outbound.ts`.

**D-024 | 2026-10-07 | `jobs_idem_uq` is a plain unique index (not partial); `ON CONFLICT (idempotency_key)` relies on it for job enqueue idempotency.**
Reasoning: Phase 1 finding — a partial index (`WHERE idempotency_key IS NOT NULL`) cannot be inferred by `ON CONFLICT (idempotency_key)`, so every enqueue outside a test failed with "no unique or exclusion constraint matching the ON CONFLICT specification". Postgres treats NULLs as distinct, so a plain unique index still allows many keyless jobs. Status: ACCEPTED → `db/migrations/0001_init.sql`.

**D-025 | 2026-10-08 | `LLM_PROVIDER=scripted` is an explicit provider mode (client persona) for dev demos and CI; the platform never falls back to it, and a missing provider/key yields "no LLM configured" (`resolveLlmClient` → `null`).**
Reasoning: SPEC §51 + COMMON_RULES #7 require that every reported result comes from a real run. Demo/test runs must therefore execute the *production* code path (prompt assembly → contract validation → repair → persistence) while only the network call is replaced. Falling back silently would make "no key" look like "works", which is the kind of fake that later phasing cannot absorb. Status: ACCEPTED → `apps/worker/src/services/llm.ts`, `packages/testing/src/persona.ts`, `docs/14`.

**D-026 | 2026-10-08 | The §10 minimum interval is enforced *before* the LLM call, and §10 inactivity reminders use `replacePendingJob` so each conversation has exactly one live timer.**
Reasoning: two Phase-2 cost/quality findings. (1) The interval guard originally ran after `runTurn`: the model was paid for, then the question was deferred. Deferring now costs zero tokens and only applies when the turn would actually ask something (`plan.kind === 'ASK'` and the last message is not ours). (2) A per-job idempotency key made the job table grow by one timer per question; a keyed replace (`inactivity:<conversationId>`) keeps the queue flat and makes "when will we remind?" a single row. Status: ACCEPTED → `apps/worker/src/handlers/requirements.ts`, `packages/db/src/repositories/queue.ts`.

**D-027 | 2026-10-08 | The live demo console (`GET /`) is a simulator-channel read/act view over production endpoints — it is not the Phase-7 Team Panel and carries no auth beyond the simulator flag.**
Reasoning: COMMON_RULES requires every phase result to be inspectable by a human before the panel exists (§57 "visible in state"). The console reuses `/dev/simulator/*` (same ingestion path as the webhook) plus two read-only helpers (`/dev/simulator/project/:id`, `/dev/simulator/lookup`) instead of introducing a second, parallel backend; it disappears with `CHANNEL_SIMULATOR_ENABLED=false`, so no Phase-7 surface is pre-empted. Status: ACCEPTED → `apps/api/src/routes/simulator-console.ts`.

**D-028 | 2026-10-08 | Question wording belongs to the agent contract (free text, ≤900 chars); tests assert *which field* a question is about, never the literal sentence.**
Reasoning: the §49 contract fixes the shape and limits of a question, not its words — a real model must phrase questions in the client's language. A Phase-2 e2e test broke when the scripted persona switched from machine-style text (`field.path: …`) to human-readable questions, which is exactly the coupling to avoid: `@wpp/testing` now exports `questionTextFor(fieldPath)` and the test counts messages that ask about `design.style`. Status: ACCEPTED → `packages/testing/src/persona.ts`, `tests/e2e/requirements-interview.test.ts`.

**D-029 | 2026-10-08 | The project is **free-only**: `LLM_FREE_ONLY=true` is the default and refuses every route that is not marked free in `config/llm-presets.json` (or on the documented free/local host allowlist), so the pipeline never spends money by accident.**
Reasoning: the user's standing constraint (2026-10-08, Phase-3 approval) is that the whole project must remain completely free — no paid APIs or services. Free routes are the Gemini AI Studio free tier, the Groq free plan, OpenRouter `:free` models (50 requests/day without paid credit) and any local/self-hosted OpenAI-compatible endpoint (Ollama). A refused route resolves to `null` = "no LLM configured", which the pipeline already degrades from honestly (D-025), instead of silently calling a paid provider. `LLM_FREE_ONLY=false` exists as a documented, never-default escape hatch. Status: ACCEPTED → `packages/infra/src/llm-presets.ts`, `packages/agents/src/llm/factory.ts`, `config/llm-presets.json`, `docs/12`, `tests/unit/llm-free-only.test.ts`.

**D-030 | 2026-10-08 | Client approval is a TWO-step conversation: the platform first sends the Client Summary, and only after the client replies does it send the explicit approve/change question; a decision is recorded with the client's `source_message_id` and an unambiguous keyword answer is decided locally.**
Reasoning: the user chose this shape in the Phase-3 gate. It also matches SPEC §18/§19: the summary must be read before it can be approved, and §10A discipline applies to approvals exactly as it does to requirement fields — `client_approvals.source_message_id` is unique, so a retried webhook cannot approve twice, and an `APPROVE` below the configured confidence threshold becomes UNCLEAR → one clarifying question (§21 caps it, then a human task). Status: ACCEPTED → `apps/worker/src/handlers/clientIntent.ts`, `packages/agents/src/spec/agent.ts`, `tests/e2e/spec-approval.test.ts`.

**D-031 | 2026-10-08 | The client never sees an un-audited specification: deterministic audits (§16 traceability, §17 testability, §19 summary↔spec consistency) gate the summary, and a failure gets exactly ONE repair before a human task replaces the send.**
Reasoning: the specification is the document the whole build is measured against, and a wrong summary costs a whole project. Splitting the work — the model writes, `packages/core` audits — keeps the check reproducible and cheap (no second opinion model call), while the bounded repair keeps a weak model from looping (§21/§26 "no infinite loops"). A version that still fails is stored as CHANGES_REQUESTED, the project enters BLOCKED via T30 and a HUMAN_REVIEW task carries the exact gaps, so nothing is lost and nothing untrue is announced. Status: ACCEPTED → `apps/worker/src/handlers/spec.ts`, `packages/core/src/spec/{traceability,rules}.ts`, `tests/e2e/spec-approval.test.ts`.

**D-032 | 2026-10-08 | One specification per requirements version: the `SPEC_GENERATE` hand-off is idempotent (`spec-generate:<requirementVersionId>`), a replayed job returns early, and every new round creates a new version row instead of editing an existing one (§34).**
Reasoning: the hand-off is enqueued from inside the requirements turn, so a crash/retry could otherwise send the client a second summary of the same document — and a specification row that humans and later phases cite must never change silently. Client changes produce v2 with v1 kept (SUPERSEDED), the change request text recorded, and the summary re-sent for a new approval round; the approved version is LOCKED (`lockSpecVersion` is predicate-guarded, so a double webhook is a no-op). Status: ACCEPTED → `apps/worker/src/handlers/{spec,requirements}.ts`, `packages/db/src/repositories/specs.ts`.

---

## Format for future entries

```
**D-0nn | YYYY-MM-DD | <decision in one sentence>**
Reasoning: <why, tied to SPEC sections and risks>
Status: ACCEPTED | PROPOSED | SUPERSEDED by D-0xx → <affected docs>
```

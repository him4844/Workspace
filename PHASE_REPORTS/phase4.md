# PHASE 4 REPORT — Spec Auditor (`§20`), the `§21` audit loop and the `§42` human block

**Phase file:** `docs/phases/04_phase4_spec_auditor.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-08 · **Status:** COMPLETE — **waiting for human approval before Phase 5**
**Update (same day, evening):** the auditor now runs live on its own vendor route and the first
**live audit row is captured** (D-049…D-051) — both the PASS path and the FAIL→BLOCK path are
proven with real providers, not only scripted.

Every number below comes from a command you can re-run; the raw output is in `PHASE_REPORTS/evidence/`.
The whole phase was built and verified **at zero cost** (D-029): the auditor has its own free route, and
every acceptance check is reproducible without any key (`LLM_PROVIDER=scripted`) as well as with one.

---

## 1. What was built (SPEC §20, §21, §42 + D-035…D-039)

| # | Phase-4 task | Where | Status |
|---|---|---|---|
| 1 | **The auditor is not a grammar checker**: five dimensions judged separately — completeness, consistency, ambiguity, coding readiness, client alignment — with a per-dimension `checks` object | `packages/core/src/audit/rules.ts`, `packages/agents/src/audit/agent.ts` | ✅ |
| 2 | **Structured result exactly as the frozen contract** `docs/contracts/spec-audit-output.json` demands: `status`, `score`, `criticalIssues`, `warnings`, `missingRequirements`, `contradictions`, `ambiguities`, `recommendations`, plus issue objects (`code`, `severity`, `description`, `specSection`, `specRequirementCode`, `suggestedFix`) | `packages/agents/src/contracts.ts` (`SpecAuditOutputSchema`) | ✅ |
| 3 | **Deterministic half of the audit** (reproducible, free, language-independent): missing confirmed requirement, untraceable requirement, MUST without acceptance criteria, vague requirement ("beautiful", "fast", "modern", "user-friendly", "qulay", "современный"… with nothing measurable), blocking open question, page nobody specified, summary that names an unknown page | `auditSpecStructure` in `packages/core/src/audit/rules.ts`, 14 unit tests | ✅ |
| 4 | **Merge policy (D-035)**: a structural CRITICAL/MAJOR forces `FAIL` whatever the model answers; the score is capped (CRITICAL ≤30, MAJOR ≤60, MINOR ≤80); a failed dimension's `checks` cannot read `PASS` | `mergeAuditVerdict` | ✅ |
| 5 | **§21 loop**: FAIL → `T13 SPEC_REVISION_REQUIRED` → `T14 SPEC_GENERATING` → Spec Agent revises with the exact issues → **T34 back to the auditor** → re-audit. Ceiling 3 (config `loop.spec_audit.max`, §50) | `apps/worker/src/handlers/audit.ts`, `apps/worker/src/handlers/spec.ts`, `packages/core/src/state-machine/transitions.ts` (T34) | ✅ |
| 6 | **No infinite loops, crash-safe**: the attempt counter *is* the persisted `spec_audits` rows of the cycle (`cycle_key` = the client-approved version) — a restart or a replayed job cannot re-open it (D-038) | `db/migrations/0004_phase4_spec_audit.sql`, `packages/db/src/repositories/audits.ts` | ✅ |
| 7 | **§42 after the ceiling**: `T15 BLOCKED` + one CRITICAL `HUMAN_REVIEW` task whose `reason` explains WHY automation stopped and quotes every unresolved issue with its suggested fix; `aiReport` carries the full verdict; **no further pipeline job is enqueued** | `apps/worker/src/handlers/audit.ts`, `explainAuditBlock()` in core | ✅ |
| 8 | **The client is never woken by the loop** (§21 stays internal): the revision does **not** send a new summary — the auditor's client-alignment check is what proves the approved meaning survived; a revision that changes that meaning FAILS instead | `spec.ts` audit-revision branch, `tests/e2e/spec-audit.test.ts` | ✅ |
| 9 | **Independent auditor route (D-037)**: `AUDITOR_LLM_*` (own key, own model) preferred over the main route; scripted runs stay hermetic; run/audit rows record which model actually answered | `apps/worker/src/services/llm.ts`, `config/agent-configs/agents.json` (`SPEC_AUDITOR`), `config/llm-presets.json` | ✅ |
| 10 | **Auditability**: every attempt persists a `spec_audits` row (verdict, structural findings, structural-forced vs model failure, provider/model) + a Markdown report artifact `…/spec-audit/v<n>-a<attempt>.md` + a `SPEC_AUDIT_RESULT` event | handler + `writeArtifact(label)` | ✅ |
| 11 | **Seeded truth (D-039)**: seeded agent configs now record the model the runtime will send — `db:reset` reports `SPEC_AUDITOR v1 (openai-compatible/qwen/qwen3.8-27b)` | `packages/db/src/seeding.ts` | ✅ |

---

## 2. How it was verified (real results, 2026-10-08)

### 2.1 The suite — `npm run verify` → `evidence/phase4-verify.txt`

```
tsc --noEmit                                  clean
vitest: 16 files, 179 tests                   ALL PASS   (213 s; Phase 3 left 138; +14 audit core, +6 audit e2e, +7 rate-limit, +14 requirements-core incl. the §10 rule, +0 misc regressions)
node scripts/check-docs.mjs                   OK: 23 docs present, contracts valid JSON
EXIT=0
```
(Earlier same-day run: 15 files / 168 tests — see git history of `evidence/phase4-verify.txt`.)

### 2.2 Phase-4 acceptance checks — `tests/e2e/spec-audit.test.ts` (5/5, scripted provider, real everything else)

| Phase-file acceptance check | Test | Result |
|---|---|---|
| A good spec gets PASS | *a good specification gets PASS and reaches READY_FOR_BUILD (§20, T11/T12)* | ✅ `T10→T11→T12`, audit row PASS score 88, all five `checks` PASS, version LOCKED, artifact `…/spec-audit/v1-a1.md`, 0 human tasks, 0 client messages |
| A spec with deliberate gaps gets FAIL **with specific issues** | *deliberate gaps … even when the model says PASS* | ✅ stored spec sabotaged with (a) a confirmed field whose requirement was removed (b) a MUST criterion "the design must be beautiful": verdict FAIL, `modelStatus=PASS` **overruled**, `structuralForcedFail=true`, score ≤60, issues `MISSING_SPEC_REQ` + `AMBIGUOUS_REQUIREMENT ("beautiful" … SPEC-REQ-900)`, `checks.completeness=FAIL`, `checks.ambiguity=FAIL` |
| The loop stops after 3 attempts and creates a human task | *three failures stop the loop, block the project and create a human task with the exact issues* | ✅ attempts `[1,2,3]`, `T13`×2 → `T15`, state `BLOCKED` (`blockedFrom=SPEC_AUDIT`), one CRITICAL task: reason starts *"The Spec Auditor rejected the approved specification 3 time(s) (limit 3); automatic revision has stopped… A human must decide…"* and quotes `AMBIGUOUS_REQUIREMENT`; no `SPEC_AUDIT`/`SPEC_REVISE` job left pending |
| A revision that changes the approved meaning = client-alignment failure | *a revision that changes the approved meaning fails on client alignment* + *FAIL with budget left revises the spec and re-audits without waking the client* | ✅ `CLIENT_ALIGNMENT_FAILURE` lands in `contradictions`, `checks.clientAlignment=FAIL`; the revision path asserts `T13→T14→T34→T12`, audits `[FAIL(1), PASS(2)]` on the same `cycle_key`, and **0 outbound messages** during the loop |

### 2.3 Phase-4 demo — `npm run simulate:phase4` (two runs stored)

* `evidence/phase4-simulate-pass.txt` — happy path: 30 interview turns → spec v1 (30 SPEC-REQ) → two-step approval → **T11 audit PASS (score 88) → T12 READY_FOR_BUILD**, current spec LOCKED, 0 human tasks, 0 client messages during the audit.
* `evidence/phase4-simulate-blocked.txt` — `DEMO_AUDIT_MODE=fail-all`: three audit attempts, transitions `…T10 → T11 → T13 → T14 → T34 → T13 → T14 → T34 → T15`, versions `v1 LOCKED (approved base) · v2 SUPERSEDED · v3 IN_REVIEW`, then **BLOCKED** with the CRITICAL human task (*"…3 time(s) (limit 3) … A human must decide: fix the specification/requirements, talk to the client, or approve a scoped exception"*), 3 `SPEC_AUDIT_RESULT` events, 3 audit artifacts.

### 2.4 Live runs with the supplied free keys (2026-10-08) — writer Gemini AI Studio, auditor OpenRouter `:free`

The routes are now genuinely vendor-separated (D-042/D-045/D-048): the writer is pinned to the
measured `gemini-3.1-flash-lite` (the `gemini-flash-lite-latest` alias answered 503 and once hung a
job for 900 s; the pinned model answered the identical call 200 in 2.96 s), and the auditor is
`openrouter / cohere/north-mini-code:free` with **`reasoningEffort: 'none'`** (D-049 — see §3.1:
without it the reasoning model burned its whole completion cap on hidden thinking and returned
empty content, which dead-lettered the audit).

* **Run #6** (`evidence/phase4-live-run6.txt`) — full interview on the real pipeline: Q1→Q20, the
  §10 option rule proven live (`RESTAURANT` confirmed `website_type.type` with no re-ask), and a
  free-tier 503 storm handled by the book: two turns waited out, the third DEAD_LETTERed → CRITICAL
  `SYSTEM_ERROR` + CRITICAL `HUMAN_REVIEW` (D-044, live).
* **Run #7 — audit-only live leg** (`evidence/phase4-live-audit.txt`) — **the first live audit row**:
  scripted interview → scripted spec → two-step approval → v1 LOCKED → live `SPEC_AUDIT`
  (`provider=openrouter`, `model=cohere/north-mini-code:free`) → **PASS, score 100, all five checks
  PASS, `structuralForcedFail=false`** → T12 **READY_FOR_BUILD**, whole leg ~11 s.
* **Run #8 — spec+audit live leg** (`evidence/phase4-live-spec-audit.txt`) — the §21 loop proven
  live on the FAIL path: the live-written spec (Gemini) fails the live audit with 26 deterministic
  missing-requirement gaps → live revision → 27 gaps → third attempt → **T15 BLOCKED** + human task.
  The auditor correctly refuses an under-specified spec; the writer's thin output is a Phase-3
  follow-up (§3.2), not an auditor defect.

### 2.4a The empty-content dead end (the root cause of the earlier live failures)

Captured exactly (`LLM_DUMP_DIR` replay): the audit request is 9 149 prompt tokens (spec 5 671 +
fields 1 182 + instructions/schema ~2 300); `cohere/north-mini-code:free` answered HTTP 200 in
27.8 s with `finish_reason=length`, `reasoning_tokens=2700`, `content=null`. Three fixes, all in
D-049: `reasoning:{enabled:false}` (same body then answered in **1.03 s** with a valid verdict),
the repair echo substitutes `'(empty response)'` for an empty assistant message (strict providers
400 on empty content), and the repair cap is never clamped below the original. The TPM-budget
warning is now provider-aware: the 8 000 default is the *Groq* free-tier budget; OpenRouter `:free`
has no published TPM and demonstrably serves 9 704-token prompts.

### 2.5 Reproduce in a few minutes

```bash
npm run verify                     # tsc + 168 tests + docs/contract checks
npm run simulate:phase4            # PASS → READY_FOR_BUILD
DEMO_AUDIT_MODE=fail-first npm run simulate:phase4   # one revision, then PASS
DEMO_AUDIT_MODE=fail-all   npm run simulate:phase4   # §21 ceiling → BLOCKED + human task
DEMO_AUDIT_MODE=alignment  npm run simulate:phase4   # client-alignment failure
npm run db:reset && npm run dev    # real console at http://127.0.0.1:3000/
DEMO_LLM=real npm run simulate:phase4              # live audit leg (auditor only)
DEMO_LLM=real DEMO_LIVE_LEGS=spec+audit npm run simulate:phase4   # live spec + audit
```

---

## 3. Incomplete / risky (honest list)

1. **The auditor's judgement is shallower with reasoning off (D-049).** `reasoningEffort: 'none'`
   was the only way to get a non-empty verdict from the free roster (both probed models are
   reasoning models that burn the completion cap): the live PASS scored 100 with empty issue
   buckets on the clean scripted spec. The deterministic `auditSpecStructure` findings and
   `mergeAuditVerdict` remain the structural guarantee — the model can never vote away a
   structural CRITICAL/MAJOR — but the *judgement* half (subtle inconsistencies no rule catches)
   is thinner than it would be with reasoning on. A FAIL is always human-reviewable (report
   artifact + task). If a paid/stronger auditor ever becomes available, re-enable reasoning and
   re-probe before trusting score deltas.
2. **Phase-3 follow-up (writer quality, surfaced BY the auditor — run #8):** the free-tier writer's
   spec implements only a fraction of the 30 confirmed fields (26–27 deterministic gaps), and one
   revision does not close them → BLOCKED. The cap raise (3 000 → 5 000) did not change the gap
   count. Fixing the writer (prompt/model) is Phase-3 scope; the auditor did its job.
3. **Daily-quota 429 is still a scheduling problem, not a retry problem** (unchanged): a ~7 h 45 m
   `retryAfterMs` hint fails the in-run wait budget, the job re-queues on backoff and dead-letters.
   Mitigation is the DEAD_LETTER escalation (D-044, live-proven); the real fix (propagate
   `retryAfterMs` into the job's `runAt`) is still open.
4. **`/api/v1/projects/:id/spec-audit` has never served a live request** — it is covered by the
   inspector tests but the live demo reads the DB directly.
5. **`agent.audit_independent_provider` (seeded config) is documentation only** — nothing enforces
   "auditor ≠ writer provider"; with the OpenRouter route it *is* a different vendor now, and the
   audit rows record provider/model so the claim is checkable (D-051).
6. **Free-tier pacing is a first-class constraint** (SPEC §58): OpenRouter `:free` = 20 RPM / 50 RPD,
   Gemini AI Studio = per-project daily caps (measured 20 req/day on one model; per-model buckets
   are separate). Rosters and limits rotate; re-probe before each live leg.
7. **Not built (later phases, deliberately)**: the Coding Agent, the runtime-verified Code Checker,
   the Team Panel, deployment (Phase 5+). `T12` stops at `READY_FOR_BUILD`; enqueueing `BUILD_RUN`
   is Phase 5's `T16` (documented in `docs/05`).

---

## 4. Deviations from the frozen Phase-0 documents (all recorded, none silent)

* **T34 added** to the transition table (D-036) — §21's automatic return edge did not exist; without it every audit revision would have re-entered through the client.
* **Job matrix extended** (`SPEC_AUDIT` from `CLIENT_APPROVED`, `SPEC_REVISE`/`SPEC_GENERATE` in `SPEC_REVISION_REQUIRED`) — from the jobs column of `docs/05` itself.
* **§21 counter derived from `spec_audits`** instead of `loop_counters` (D-038).
* **`writeArtifact` gained an optional `label`** so two attempts on one version do not overwrite each other's report.

---

## 5. Open questions (need a human answer)

1. ~~The specification call cannot run on the Groq free tier~~ **ANSWERED 2026-10-08**: free Gemini
   AI Studio keys + OpenRouter keys were supplied ("davom et"); the writer runs on Gemini
   (`gemini-3.1-flash-lite`, D-048) and the auditor on OpenRouter `:free` (D-045) — option (A) from
   the earlier list, implemented and live-proven (§2.4). The whole project stayed completely free.
2. **Phase 5 scope** (`docs/phases/05_*` does not exist yet): the Coding Agent must produce an actual
   runnable website (SPEC §22–§25) — in this sandbox that means a generated static/Next.js project
   built without Docker. Confirm the target before I start: **a React/Next static marketing site**
   (matches "website production pipeline" and needs no server), or a smaller plain HTML/CSS build
   first? — also confirm the standing constraint that **Gemini must not write the code** (the coding
   route will be a non-Gemini free model; the assistant authors all repo/pipeline code).
3. **Phase-3 writer follow-up (§3.2):** accept the BLOCKED outcome of run #8 as correct behaviour
   and improve the writer before Phase 5, or adjust the deterministic completeness rule's
   strictness? (Recommendation: keep the rule — an under-specified spec must not reach a coder.)

---

## 6. Proposed next step

**Phase 4 is complete and live-proven; awaiting approval.** On approval: Phase 5 (Coding Agent) per
`SPEC.md` §22–§25, with `T16` starting from the `READY_FOR_BUILD` state — after question 2 (stack)
is answered. The Phase-3 writer follow-up (question 3) can be scheduled alongside Phase 5's first
live build, because a thin spec is exactly what the coding agent would trip over.

**Files to look at first:** `PHASE_REPORTS/evidence/phase4-live-audit.txt` (the live PASS, ~11 s),
`PHASE_REPORTS/evidence/phase4-live-spec-audit.txt` (the live FAIL→BLOCK), then
`tests/e2e/spec-audit.test.ts` (the acceptance checks as executable prose), then
`apps/worker/src/handlers/audit.ts` (the loop itself).

# PHASE 4 REPORT — Spec Auditor (`§20`), the `§21` audit loop and the `§42` human block

**Phase file:** `docs/phases/04_phase4_spec_auditor.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-08 · **Status:** COMPLETE — **waiting for human approval before Phase 5**

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
vitest: 15 files, 168 tests                   ALL PASS   (Phase 3 left 138; +14 audit core, +6 audit e2e, +7 rate-limit, +3 misc)
node scripts/check-docs.mjs                   OK: 23 docs present, contracts valid JSON
EXIT=0
```

### 2.2 Phase-4 acceptance checks — `tests/e2e/spec-audit.test.ts` (6/6, scripted provider, real everything else)

| Phase-file acceptance check | Test | Result |
|---|---|---|
| A good spec gets PASS | *a good specification gets PASS and reaches READY_FOR_BUILD (§20, T11/T12)* | ✅ `T10→T11→T12`, audit row PASS score 88, all five `checks` PASS, version LOCKED, artifact `…/spec-audit/v1-a1.md`, 0 human tasks, 0 client messages |
| A spec with deliberate gaps gets FAIL **with specific issues** | *deliberate gaps … even when the model says PASS* | ✅ stored spec sabotaged with (a) a confirmed field whose requirement was removed (b) a MUST criterion "the design must be beautiful": verdict FAIL, `modelStatus=PASS` **overruled**, `structuralForcedFail=true`, score ≤60, issues `MISSING_SPEC_REQ` + `AMBIGUOUS_REQUIREMENT ("beautiful" … SPEC-REQ-900)`, `checks.completeness=FAIL`, `checks.ambiguity=FAIL` |
| The loop stops after 3 attempts and creates a human task | *three failures stop the loop, block the project and create a human task with the exact issues* | ✅ attempts `[1,2,3]`, `T13`×2 → `T15`, state `BLOCKED` (`blockedFrom=SPEC_AUDIT`), one CRITICAL task: reason starts *"The Spec Auditor rejected the approved specification 3 time(s) (limit 3); automatic revision has stopped… A human must decide…"* and quotes `AMBIGUOUS_REQUIREMENT`; no `SPEC_AUDIT`/`SPEC_REVISE` job left pending |
| A revision that changes the approved meaning = client-alignment failure | *a revision that changes the approved meaning fails on client alignment* + *FAIL with budget left revises the spec and re-audits without waking the client* | ✅ `CLIENT_ALIGNMENT_FAILURE` lands in `contradictions`, `checks.clientAlignment=FAIL`; the revision path asserts `T13→T14→T34→T12`, audits `[FAIL(1), PASS(2)]` on the same `cycle_key`, and **0 outbound messages** during the loop |

### 2.3 Phase-4 demo — `npm run simulate:phase4` (two runs stored)

* `evidence/phase4-simulate-pass.txt` — happy path: 30 interview turns → spec v1 (30 SPEC-REQ) → two-step approval → **T11 audit PASS (score 88) → T12 READY_FOR_BUILD**, current spec LOCKED, 0 human tasks, 0 client messages during the audit.
* `evidence/phase4-simulate-blocked.txt` — `DEMO_AUDIT_MODE=fail-all`: three audit attempts, transitions `…T10 → T11 → T13 → T14 → T34 → T13 → T14 → T34 → T15`, versions `v1 LOCKED (approved base) · v2 SUPERSEDED · v3 IN_REVIEW`, then **BLOCKED** with the CRITICAL human task (*"…3 time(s) (limit 3) … A human must decide: fix the specification/requirements, talk to the client, or approve a scoped exception"*), 3 `SPEC_AUDIT_RESULT` events, 3 audit artifacts.

### 2.4 Real provider runs with the supplied Groq keys — `evidence/phase3-live-real.txt`

The interview ran on `openai-compatible / openai/gpt-oss-120b` for **5 real turns** with genuine Uzbek questions and answers (the first *real* model output in this project), and the run produced two hard facts that are now fixed and measured:

* **429 with the real numbers**: `Limit 8000, Used 1787, Requested 7070` — Groq free reserves `prompt + max_tokens` from an 8 000 TPM budget, so a requirements turn is ~1 call/minute (bounded waits already in place, D-034).
* **Provider 400s from a truncated completion**: `json_validate_failed / "max completion tokens reached before generating a valid document"` on a COMPLETE turn → budget raised 1200 → 1600 (D-039).
* **One contract slip on a real model**: a valid-JSON turn failed the contract validation, was repaired once, and the repair call hit the same minute's limit — the job survived, the *driver* gave up too early; the driver now retries the wait instead of stopping (`DEMO_QUIET_WAITS`).

### 2.5 Reproduce in a few minutes

```bash
npm run verify                     # tsc + 168 tests + docs/contract checks
npm run simulate:phase4            # PASS → READY_FOR_BUILD
DEMO_AUDIT_MODE=fail-first npm run simulate:phase4   # one revision, then PASS
DEMO_AUDIT_MODE=fail-all   npm run simulate:phase4   # §21 ceiling → BLOCKED + human task
DEMO_AUDIT_MODE=alignment  npm run simulate:phase4   # client-alignment failure
npm run db:reset && npm run dev    # real console at http://127.0.0.1:3000/
```

---

## 3. Incomplete / risky (honest list)

1. **A real *full-pipeline* run is still blocked by the free-tier token budget, not by code.** Measured by `npm run prompt-sizes`: the specification call reserves **~7 069 (prompt) + `max_tokens`**; even with the new 3 000 cap that is ~10 000 against an 8 000 TPM ceiling, so Groq's free plan cannot serve it (a cold 429 every time). The interview fits (≈5.9k + 1.6k). Options are in §5 — this is the one thing between us and a green *live* Phase-4 run.
2. **The auditor runs on Groq too, just a different model and key** (`qwen/qwen3.8-27b` vs the writer's `openai/gpt-oss-120b`). The Phase-0 answer ("Spec Auditor on a different provider") is therefore satisfied by *independence of model + key*, not by vendor — impossible with only Groq keys. The audit row records exactly what happened, so this is visible in the data.
3. **The auditor's judgement is only as good as the model behind it.** A free-tier model can miss a subtle inconsistency that no rule catches; the deterministic findings cover the mechanical half, and a FAIL is always human-reviewable (the report artifact + the task). Worth re-checking on the first real PASS.
4. **`agent.audit_independent_provider` (seeded config) is documentation only** — nothing enforces "auditor ≠ writer provider" yet. Enforcing it would block runs where only one route exists, so it is recorded rather than enforced (D-037).
5. **Groq free 200k tokens/day**: a realistic 30-turn real interview plus a specification already exceeds one day's budget on that account, even once the per-minute problem is solved. Free-tier pacing is a first-class constraint of this project, not a bug to fix (SPEC §58).
6. **Not built (later phases, deliberately)**: the Coding Agent, the runtime-verified Code Checker, the Team Panel, deployment (Phase 5+). `T12` stops at `READY_FOR_BUILD`; enqueueing `BUILD_RUN` is Phase 5's `T16` (documented in `docs/05`).

---

## 4. Deviations from the frozen Phase-0 documents (all recorded, none silent)

* **T34 added** to the transition table (D-036) — §21's automatic return edge did not exist; without it every audit revision would have re-entered through the client.
* **Job matrix extended** (`SPEC_AUDIT` from `CLIENT_APPROVED`, `SPEC_REVISE`/`SPEC_GENERATE` in `SPEC_REVISION_REQUIRED`) — from the jobs column of `docs/05` itself.
* **§21 counter derived from `spec_audits`** instead of `loop_counters` (D-038).
* **`writeArtifact` gained an optional `label`** so two attempts on one version do not overwrite each other's report.

---

## 5. Open questions (need a human answer)

1. **The specification call cannot run on the Groq free tier (~10k tokens vs an 8k ceiling).** Pick one:
   * **(A, recommended) Add a free Gemini AI Studio key** (`LLM_PRESET=gemini-free`, no credit card): its free tier allows ~250k TPM and a 1M-token context, which covers the interview *and* the specification *and* the auditor, and it finally makes the auditor a *different vendor* — exactly the Phase-0 intent. Nothing else changes: keys go into `.env` (never committed), and the auditor stays on its own route.
   * **(B) Keep Groq only, and I compact the specification prompt first** (send a reduced requirements view + a leaner task block, target ≤4.5k) — a real prompt redesign with re-verification, and it will still be ~1 call/min with a 200k-token/day ceiling.
   * **(C) Accept scripted-only proof for full-pipeline runs** and use the real keys only for the parts that fit (interview, auditor).
2. **Phase 5 scope** (`docs/phases/05_*` does not exist yet): the Coding Agent must produce an actual runnable website (SPEC §22–§25) — in this sandbox that means a generated static/Next.js project built without Docker. Confirm the target before I start: **a React/Next static marketing site** (matches "website production pipeline" and needs no server), or a smaller plain HTML/CSS build first?

---

## 6. Proposed next step

Phase 5 (Coding Agent) per `SPEC.md` §22–§25, with `T16` starting from the `READY_FOR_BUILD` state that Phase 4 now reaches — **but** only after question 1 is answered, because a live end-to-end proof of Phases 2–4 is worth having before another agent layer is stacked on top. If the answer is (A), I will re-run the real interview → specification → audit chain end-to-end with the Gemini key in place and attach it as the live evidence for Phases 3–4.

**Files to look at first:** `PHASE_REPORTS/evidence/phase4-simulate-pass.txt` (30 seconds), then `tests/e2e/spec-audit.test.ts` (the acceptance checks as executable prose), then `apps/worker/src/handlers/audit.ts` (the loop itself).

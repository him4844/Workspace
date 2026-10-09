# PHASE 4 REPORT — Spec Auditor (`§20`), the `§21` audit loop and the `§42` human block

**Phase file:** `docs/phases/04_phase4_spec_auditor.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Phase-4 close (2026-10-08):** COMPLETE.
**Current status (2026-10-09):** requested P0–P4 remediation is complete and serially verified; Phase 5 has not started. Awaiting explicit approval and the generated-site stack choice.
**Phase-4 live proof:** the auditor ran on its own vendor route, with a real PASS row and a separately observed FAIL→BLOCK path (D-049…D-051). The latest full free chain after the summary/spec remediation is recorded in `evidence/phase4-live-all-fixes.txt` (D-061).

Every number below comes from a command you can re-run; the raw output is in `PHASE_REPORTS/evidence/`.
The project remains free-only (D-029): Gemini writes requirements/specification, OpenRouter `:free` audits; paid routes are blocked by the standing policy. Scripted acceptance checks need no key.

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

### 2.1 Original Phase-4 close suite — `evidence/phase4-verify.txt` (historical baseline)

At the 2026-10-08 Phase-4 close:

```
tsc --noEmit                                  clean
vitest: 16 files, 179 tests                   ALL PASS   (213 s)
node scripts/check-docs.mjs                   OK: 23 docs present, contracts valid JSON
EXIT=0
```
This is the historical Phase-4 close result, not the latest remediation verification. The newer full serial run is in §2.6 and `evidence/phase0-4-remediation-verify.txt`.

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
* **Run #8 — spec+audit live leg** (`evidence/phase4-live-spec-audit.txt`) — historically proved the §21 FAIL→BLOCK route: it reported 26 then 27 deterministic gaps and ended at **T15 BLOCKED** + human task. That first diagnosis (“writer omitted confirmed requirements”) was later superseded: live inspection found 30/30 SPEC-REQ coverage, and the block came from the Phase-3 lexical summary checker rejecting short paraphrases. See D-053/D-061 and the corrected full-chain proof in §2.6; keep this file as historical evidence, not the current quality verdict.

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
npm run verify                    # typecheck + serial Vitest (1 thread) + docs/contracts check
npm run simulate:phase4            # PASS → READY_FOR_BUILD
DEMO_AUDIT_MODE=fail-first npm run simulate:phase4   # one revision, then PASS
DEMO_AUDIT_MODE=fail-all   npm run simulate:phase4   # §21 ceiling → BLOCKED + human task
DEMO_AUDIT_MODE=alignment  npm run simulate:phase4   # client-alignment failure
npm run db:reset && npm run dev    # real console at http://127.0.0.1:3000/
DEMO_LLM=real npm run simulate:phase4              # live audit leg (auditor only)
DEMO_LLM=real DEMO_LIVE_LEGS=spec+audit npm run simulate:phase4   # live spec + audit
```


### 2.6 P0–P4 remediation run (2026-10-09)

The remediation was verified after its final code change with the serial command and raw evidence listed in §3.2. In addition, the latest recorded free live spec+audit run is `evidence/phase4-live-all-fixes.txt`: Gemini generated a 30-SPEC-REQ draft, the §18 summary gate passed, the two-step approval locked v1, and the vendor-separated OpenRouter auditor returned PASS 100 / five checks PASS → `READY_FOR_BUILD`. No P5 coding-agent route was run or implemented.

---

## 3. P0–P4 remediation status and remaining risks (updated 2026-10-09)

### 3.1 Known issues closed in this remediation

| Area | Resolution | Decision / proof |
|---|---|---|
| Provider 429 waits and dead-letter handling | Provider `retryAfterMs` now schedules `jobs.run_at` at the deadline + 1 s; excessive waits/exhausted retries dead-letter, create a critical human task, and T30-block the project. | D-052/D-057; queue and dead-letter tests |
| Client Summary false-block; failed spec drafts | §18 checks now validate the short client-facing summary without requiring verbatim MUST titles. Failed technical-spec candidates and exact gaps are persisted; repair sees the previous candidate; accepted spec persistence is atomic. | D-053/D-058; spec unit/E2E tests; live evidence below |
| Questionnaire clarifiers | Mismatched prompts/options were corrected and pinned with data-driven localized regression tests. | D-054; 11 tests |
| Auditor route and fallback | OpenRouter `cohere/north-mini-code:free` is the tested preset. A real auditor route must use a different vendor and credential from the writer; no silent same-vendor fallback. | D-055; route/free-only tests |
| Spend guard | Paid routes reserve worst-case estimated usage atomically per org/UTC day, with 25% margin; unknown pricing is refused. Free-only routes remain no-cost and bypass paid reservations. | D-056; budget integration tests (5/5) |
| Missing auditor verdict / unhandled failure | Auditor-unavailable and dead-letter paths now leave a persisted, human-visible BLOCKED state rather than an unowned task or indefinite wait. | D-057; dead-letter + audit E2E tests |
| `/spec-audit` API coverage | Fastify HTTP integration tests cover token auth, latest verdict/provider/model, attempts/tasks, and 404. | D-059; 2/2 |
| Prompt visibility | Prompt-size tool now follows the full scripted Phase-2→3→4 flow, including the auditor request. | D-060; 32 calls, `READY_FOR_BUILD` |
| Outbound Instagram pacing | `SEND_RATE_PER_MINUTE` is enforced per connection with a durable 60-second counter; overflow is queued and retried at the next window. Simulator messages bypass the external Graph limiter. | D-062; integration tests (2/2) |
| Test hermeticity / deprecation noise | Tests no longer inherit real `.env` provider routes. Removed a redundant deprecated Fastify option; the final verification emitted no Fastify deprecation warnings. | `tests/helpers/context.ts`, `apps/api/src/app.ts`; full suite below |

### 3.2 Final verification (2026-10-09)

The full suite was run serially to avoid the sandbox's Vitest worker memory limit:

```bash
npm run verify
```
The `verify` script runs Vitest with one thread and file-parallelism disabled to avoid the sandbox's worker-memory failures.

| Check | Result |
|---|---|
| TypeScript | ✅ clean |
| Vitest | ✅ 24 files / 214 tests passed (244.84 s) |
| Documentation/contracts | ✅ 23 docs present; contracts valid JSON |
| Full command | ✅ exit 0; raw output `evidence/phase0-4-remediation-verify.txt` |

### 3.3 Live/provider evidence and its boundary

`evidence/phase4-live-all-fixes.txt` records the complete free live chain: 30/30 SPEC-REQs, Client Summary passes §18, v1 receives the two-step client approval and locks, writer is Gemini and auditor is the different-vendor OpenRouter `:free` route, audit returns PASS 100 with all five checks PASS, and the project reaches `READY_FOR_BUILD`. The scripted prompt-size run records 32 calls and estimates the auditor request at about 7,920 prompt tokens plus 2,500 output tokens (`evidence/phase4-prompt-sizes.txt`).

The live full-chain capture predates the final outbound-throttle-only change; that change is covered by the post-change integration suite. The live chain uses the simulator channel, which intentionally bypasses Meta's Graph API limiter. No real Meta send/receive is claimed.

### 3.4 Still open / externally constrained

1. **Meta Graph integration is unverified.** No Meta test account, app token, review or real Instagram thread is configured here. Real send/receive, permission grants, and long-lived token refresh remain external work.
2. **Free-provider limits rotate and are per provider/project.** The successful live run proves one RESTAURANT persona/model path, not every language/questionnaire or future free-tier roster. Keep `LLM_FREE_ONLY=true`; it is not permission to spend.
3. **Auditor judgement is intentionally shallow on the tested free route.** Reasoning is disabled to avoid empty responses; deterministic structural checks and human BLOCKED escalation remain the safety net, but subtle judgement needs more live evaluation.
4. **Sandbox != production.** Verification used PGlite and scripted HTTP integration; Docker/PostgreSQL deployment and browser/Chromium runs were not available. The later Code Checker, Team Panel, deployment and delivery phases are not built.
5. **Phase 5 has not started.** The generated-site target (React/Next static site vs plain HTML/CSS) is still undecided, and this report is not approval to proceed.

---

## 4. Deviations from the frozen Phase-0 documents (all recorded, none silent)

* **T34 added** to the transition table (D-036) — §21's automatic return edge did not exist; without it every audit revision would have re-entered through the client.
* **Job matrix extended** (`SPEC_AUDIT` from `CLIENT_APPROVED`, `SPEC_REVISE`/`SPEC_GENERATE` in `SPEC_REVISION_REQUIRED`) — from the jobs column of `docs/05` itself.
* **§21 counter derived from `spec_audits`** instead of `loop_counters` (D-038).
* **`writeArtifact` gained an optional `label`** so two attempts on one version do not overwrite each other's report.

---

## 5. Open questions (need a human answer)

1. **Generated-site stack for Phase 5:** React/Next static marketing site, or plain HTML/CSS first? The platform monorepo stack (TypeScript/Fastify/Drizzle) is already approved; this question is about the website the coding agent will generate.
2. **Explicit Phase-5 approval:** after reviewing this remediation report, confirm whether to begin P5. No P5 implementation has started. Any future coding-agent route must remain non-Gemini, vendor constraints and `LLM_FREE_ONLY=true` stay in force.
3. **Non-blocking product policy choices** remain documented in `PHASE_REPORTS/phase3.md` (approval quick replies, reminder policy, and human handling of change requests); they do not authorize or block this remediation close.

---

## 6. Proposed next step

P0–P4 remediation is verified and documented. **Stop here and await the user's explicit Phase-5 approval and generated-site stack choice.** If approved, implement P5 only, starting from `READY_FOR_BUILD`/T16; keep the coding-agent route non-Gemini and keep the entire project free-only. No Phase-5 code has been written in this remediation.

**Review first:** `evidence/phase0-4-remediation-verify.txt` (final 24/214 suite), `evidence/phase4-live-all-fixes.txt` (live PASS chain), `evidence/phase4-prompt-sizes.txt` (prompt measurement), then `DECISIONS.md` D-052…D-062.

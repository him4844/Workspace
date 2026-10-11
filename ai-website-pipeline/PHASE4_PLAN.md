# PHASE 4 PLAN — Spec Auditor (`§20`), the `§21` audit loop, the `§42` human block

**Phase file:** `docs/phases/04_phase4_spec_auditor.md` · **Decision log:** `DECISIONS.md`
**Human decisions taken before starting (2026-10-08):** Phase 4 authorized by *"davom et"* after the Phase-3
report · the whole project must stay **completely free** (D-029) · four Groq free-tier keys supplied for real
runs (`LLM_API_KEY`, `AUDITOR_LLM_API_KEY`, two spares) · the auditor runs on a **separate route** (own key,
own model) — independence by model/key, not vendor, because only Groq keys exist (D-037, stated plainly).

## 1. What Phase 4 must deliver (from the phase file + SPEC §20, §21, §42)

| # | Requirement | Reading of "done" |
|---|---|---|
| 1 | The Spec Auditor reviews the client-approved specification as an independent expert (§20) | Its own LLM route; a locked specification is the only input; the auditor never edits the spec |
| 2 | Exactly five judgements: completeness, consistency, ambiguity, coding readiness, client alignment | One structured object (`docs/contracts/spec-audit-output.json`): `status`, `score`, the five `checks`, and the issue buckets with per-issue `code`/`severity`/`specRequirementCode`/`suggestedFix` |
| 3 | Mechanical defects must not depend on a model's mood | Deterministic audit (`auditSpecStructure`) over the spec, the client summary and the confirmed requirement fields: missing requirement, untraceable requirement, MUST without acceptance criteria, vague requirement, blocking open question, unspecified page, summary naming an unknown page |
| 4 | FAIL must be actionable | The revision request carries the issue codes, the affected requirement/section and the suggested fix — the Spec Agent gets structured JSON, never prose (§49) |
| 5 | The loop is bounded and survives crashes (§21, §26) | Ceiling from config (`loop.spec_audit.max` = 3); attempts counted from persisted `spec_audits` rows of the cycle, not from memory |
| 6 | After the ceiling: BLOCK + human, never a 4th attempt (§21, §42) | `T15 BLOCKED`, one CRITICAL `HUMAN_REVIEW` task whose reason explains WHY and quotes every unresolved issue; automation stops |
| 7 | The client is not woken by internal audit iterations | No summary, no approval question, no status message reaches the client during the loop; the *revision output* is re-audited against the locked, client-approved baseline (a meaning change fails client alignment) |
| 8 | Everything is recorded | `spec_audits` row per attempt (verdict, structural findings, forced vs model failure, provider/model, agent run) + Markdown report artifact + `SPEC_AUDIT_RESULT` event; visible in the inspector API |
| 9 | Zero cost | Auditor on a free route; scripted runs (CI/demo) never touch the network |

## 2. Order of work (sequential — each step is a gate for the next)

1. **Frozen contract first**: `docs/contracts/spec-audit-output.json` read literally → `SpecAuditOutputSchema`
   (+ a `blamedFor` guard so a legitimate FAIL cannot be rejected by a schema complaint about a non-bucket key).
2. **Deterministic core** (`packages/core/src/audit/{rules,index}.ts`): `auditSpecStructure` → findings, worst
   severity, score cap; `mergeAuditVerdict` (structural CRITICAL/MAJOR forces FAIL; score = min(model, cap));
   `explainAuditBlock` for §42. Unit tests before wiring — this is the part that must be reproducible.
3. **Persistence**: `db/migrations/0004_phase4_spec_audit.sql` (`spec_audits`, `cycle_key`, `attempt`,
   `max_attempts`, `status`, `score`, verdict + structural findings JSON, provider/model) and the repository
   (`countCycleAttempts`, `insert`, newer-first list).
4. **Auditor agent**: `packages/agents/src/audit/agent.ts` — a task block that hands the auditor the
   specification, the client summary, the confirmed requirement fields **and the deterministic findings**
   (so the model reasons on top of facts instead of guessing them), temperature 0, own route.
5. **State machine**: assert the Phase-0 table covers §21; add the one missing edge **T34**
   (`SPEC_GENERATING → SPEC_AUDIT`, guarded by an existing locked/approved base) and document it in `docs/05`
   together with the job matrix rows it implies.
6. **Wiring**: `clientIntent` approval → enqueue `SPEC_AUDIT` → handler applies `T11`, runs the audit, then
   PASS → `T12 READY_FOR_BUILD`; FAIL with budget left → `T13` + enqueue `SPEC_REVISE` with the findings →
   `T14` → `SPEC_GENERATING` → new version → **T34** back to the auditor; FAIL at the ceiling → `explainAuditBlock`
   + CRITICAL task + `T15 BLOCKED` with nothing further enqueued.
7. **Config as data (§50)**: auditor row in `config/agent-configs/agents.json` (temperature 0, 2 000 output
   tokens, 120 s), `AUDITOR_LLM_*` env keys, seeded agent config records the model the runtime actually sends.
8. **Tests**: unit (audit rules, merge policy, transition) + `tests/e2e/spec-audit.test.ts` covering the four
   phase-file acceptance checks (good spec passes; deliberate gaps fail even when the model says PASS; three
   failures stop the loop with a human task; a revision that changes approved meaning fails client alignment).
9. **Demo + evidence**: `scripts/simulate-phase4.ts` (`DEMO_AUDIT_MODE=pass|fail-first|fail-all|alignment`),
   `npm run verify`, artifacts into `PHASE_REPORTS/evidence/`, then this report and the commit.

## 3. Risks and how they are handled

| Risk | Handling |
|---|---|
| Auditor approves a spec with real gaps | Deterministic findings force FAIL; score cap; the model can only add failures, never remove one |
| Two attempts overwrite each other's report | `writeArtifact` gained an optional `label` (`v<n>-a<attempt>.md`) |
| Loop re-opens after a crash/restart | Attempt counter derived from persisted rows of the cycle (D-038) |
| Model revision silently changes what the client approved | Auditor's client-alignment dimension + a dedicated e2e case |
| Free-tier 429s / token ceilings | Bounded retry inside the job (D-034); scripted runs are hermetic; the spec-call reservation is measured and reported (`npm run prompt-sizes`) |
| Recorded model ≠ sent model | Seeded agent configs resolve the same chain the runtime does (D-039) |
| Scope creep into Phase 5 | `T12` stops at `READY_FOR_BUILD`; enqueueing `BUILD_RUN` is documented as Phase 5's `T16` |

## 4. Definition of done (SPEC §57)

Backend logic, persisted data, validation, error states, authorization, connected workflow, testable, and
visible in state: `verify` green, the demo run reproducible for all four modes, evidence files written,
`PHASE4_REPORT` presented, commit on top of `1a5b4cb`, then **STOP at the gate** and wait for approval.

# PHASE 2 REPORT — Requirements Agent

**Phase file:** `docs/phases/02_phase2_requirements_agent.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-08 · **Status:** COMPLETE — **waiting for human approval before Phase 3**

Every claim in this report is backed by a command you can re-run. Phase 2 was developed **without Meta
access and without a provider key**: the scripted provider (`LLM_PROVIDER=scripted`) replaces only the
network call — prompt assembly, contract validation, the single repair, persistence, the state machine,
the completeness engine and the artifact writer all execute for real (D-025).

---

## 1. What was built (phase task list, SPEC §5–§13, §10A, §38, §49–§51)

| # | Phase-2 task | Where | Status |
|---|---|---|---|
| 1 | Questionnaire schema as data (18 mandatory categories) + website-type packages (RESTAURANT / ECOMMERCE / EDUCATION / LANDING / CORPORATE) addable without code changes (§7, §50–51) | `config/questionnaires/*.json`, `packages/core/src/requirements/questionnaires.ts` | ✅ |
| 2 | Website type detection from the first message | `packages/core/src/requirements/detect.ts`, `projectsRepo.setProjectType`, event `PROJECT_TYPE_DETECTED` | ✅ |
| 3 | One question at a time, Instagram-sized messages | `packages/core/src/requirements/planner.ts`, handler `sendQuestion` (`toClientMessage` cap 950 chars, quick replies ≤20 chars) | ✅ |
| 4 | Dynamic follow-ups: vague (§8A), contradictions (§8B), business-specific and dependent fields (§8D) | planner order `contradiction → vague/UNCLEAR → DEFAULT_PROPOSED → AI_INFERRED → next EMPTY`, contradiction resolver | ✅ |
| 5 | Internal project vision separating client-confirmed / AI-inferred / not-specified (§9) | `requirement_versions.vision` written by the summary turn, shown in the inspection API | ✅ |
| 6 | Completeness engine on the §10A vocabulary only, limits as config (§10A, §21) | `packages/core/src/requirements/completeness.ts`, `config/defaults.json` (max_questions 40, clarify 2, interval 8 s, inactivity 24 h) | ✅ |
| 7 | "I don't know" handling (§11) | planner `DEFAULT_PROPOSED` + `CLIENT_APPROVED_DEFAULT` status, per-field clarify counter | ✅ |
| 8 | Versioned structured requirements with must / nice_to_have / later (§12–13) | `requirement_versions`, `requirement_fields`, `field_status_history`, migration `0002_phase2_requirements.sql` | ✅ |
| 9 | Prompt-injection protection — client text is data (§38) | fixed 6-block prompt (`packages/agents/src/prompt.ts`), `looksLikeInjection` → one `SECURITY_ALERT` (MINOR, `handled:'as-content'`) | ✅ |
| 10 | Internal requirements summary for the next phase, **no client approval here** (§10) | `data/projects/<id>/requirements/v<n>.md` + `artifacts` row + `summaryArtifactId` + T05 | ✅ |
| + | Requirements turn as a worker job with loop safety, Human-Review escalation, cost accounting | `apps/worker/src/handlers/requirements.ts`, `orchestrator.ts`, `llm_usage` | ✅ |

**Acceptance checks from the phase file**

| Acceptance check | Result |
|---|---|
| Full restaurant-style conversation ends with `REQUIREMENTS_COMPLETE` | ✅ twice: `npm run simulate:requirements` (§3.2) and a live run against the running API (§3.3) |
| Contradiction (minimal design vs many animations) triggers a clarification question | ✅ e2e `a contradiction between two client answers is clarified before completion (§8B)` |
| Injection ("ignore your instructions") is treated as ordinary content | ✅ e2e `prompt injection stays data … (§38)` — one alert, no behaviour change, no extra agent power |
| Status never reaches `CLIENT_CONFIRMED` without an explicit client message reference | ✅ e2e `CLIENT_CONFIRMED without a real client message is rejected and recorded (§10A)` + DB CHECK + `FIELD_UPDATES_REJECTED` |
| Structured requirements are inspectable by a human | ✅ `npm run inspect`, `GET /api/v1/projects/:id/requirements`, dev console `GET /` (D-027) |

---

## 2. Headline decisions made in Phase 2 (details in `DECISIONS.md`)

- **D-025 — `LLM_PROVIDER=scripted` is an explicit mode, never a fallback.** The persona client runs the
  production path in demos and CI; a missing key with a real provider yields *no LLM configured*, so
  "works without a key" can never be mistaken for "provider works".
- **D-026 — the §10 minimum interval is checked *before* the LLM call, and inactivity uses
  `replacePendingJob`.** Deferring a turn costs 0 tokens; one live reminder per conversation instead of
  one job per question.
- **D-027 — the dev console is a simulator-channel viewer over production endpoints**, not a Phase-7
  panel. It dies with `CHANNEL_SIMULATOR_ENABLED=false`.
- **D-028 — question wording belongs to the contract, not to tests.** `@wpp/testing` exports
  `questionTextFor(fieldPath)`; tests assert *which field* is being asked.

Two runtime changes worth flagging for review:

- `packages/agents/src/runtime.ts`: invalid JSON **after** the single repair now yields `NEEDS_REVIEW`
  (was `FAILED`/retryable). The handler opens a Human-Review task and does not retry the job — an agent
  that cannot follow the §49 contract must not be looped (§21/§26).
- The planner treats a *dependent* mandatory field as inapplicable when its gate is unsatisfied
  (e.g. `payments.providers` while the client says "no online payments") — it neither blocks completion
  nor gets asked (§8D).

---

## 3. How it was verified (real results, 2026-10-08)

### 3.1 `npm run verify` — typecheck + full test suite + docs integrity

```
tsc --noEmit                                  → 0 errors
Test Files  9 passed (9)
     Tests  96 passed (96)                    # ~98 s
OK: 23 docs present, contracts valid JSON
```

Breakdown: unit 61 (state machine 17, requirements core 24, security/window 11, config data 9),
integration 20 (ingestion/repositories 11, webhook HTTP 7, requirements API 2), e2e 16 (Phase-1 slice 5,
Phase-2 interview 11). The Phase-2 e2e file covers: happy path to `REQUIREMENTS_COMPLETE` (T01→T02→T03→T05,
completeness 1.000, mandatory ≥18 all settled, artifact + `vision`, no client-facing approval question),
§7 type detection (UNKNOWN → RESTAURANT), §8A vague → UNCLEAR → clarified, §8B contradiction → clarification
`RESOLVED`, §10 agent cannot self-declare completion, §10A bogus `sourceMessageId` rejected, repair exactly
once then success, §38 injection contained, §21 question cap → Human Review, §10 inactivity → two reminders
then escalation.

### 3.2 `npm run simulate:requirements` (in-memory, safe to repeat)

```
seeded config: GENERAL v1 f29 | RESTAURANT v1 f10 | ECOMMERCE v1 f11 | EDUCATION v1 f8 | LANDING v1 f6 | CORPORATE v1 f8
agent config: REQUIREMENTS v1 (none/gpt-5-mini) · config values: 13
one restaurant DM → 30 scripted Q/A turns → REQUIREMENTS_COMPLETE
completeness 1.000 · mandatory incomplete [] · questions_asked 30
agent runs 32 (32 SUCCESS, repairs 0) · jobs 61 DONE / 1 PENDING (the inactivity timer)
summary artifact sha256=7edfd91894e37eaa… (654 B) · 0 human tasks
transitions T01 → T02 → T03 → T05
```

### 3.3 Live run: real server, real HTTP, real DB file, real worker

```
$ LLM_PROVIDER=scripted LOG_LEVEL=info npm run dev      # API :3000 + embedded worker (PGlite, D-022)
$ DEMO_PLAIN=1 DEMO_SENDER_ID=igsid_verify_a npm run demo:live
```

`npm run demo:live` talks to the API exactly like Instagram (simulator channel) and like the client
(answering each question with the persona value **of the field the pipeline is actually asking about**),
then prints the structured result from the inspection API:

```
  Q1  Sayt ochishdan asosiy maqsadingiz nima — mijozlar nima qilishini xohlaysiz?
  A1  Mijozlar restoranimizni topib, menyuni ko‘rib, stol bron qilishi uchun
  Q2  Kompaniya yoki brend nomi qanday bo‘ladi?        A2  Osh Baraka
  Q3  Asosiy mijozlaringiz kimlar? …                   A3  Toshkentdagi 25-45 yoshli oilalar va ofis xodimlari
  … 30 questions, one per turn, no repeats …
state: REQUIREMENTS_COMPLETE  type: RESTAURANT  turns: 31
completeness: 100%  fields: 39  mandatory confirmed: 24/24  open contradictions: 0
summary artifact: data/projects/01a11b52-03af-730a-b560-5106405d34d1/requirements/v1.md
field statuses: { CLIENT_CONFIRMED: 30, EMPTY: 9 }        # the 9 are optional fields the persona never had
transitions: T01, T02, T03, T05 · open tasks: 0 · window hoursLeft 23.99
jobs: 61 DONE / 1 PENDING (inactivity timer) · agent runs 32, all SUCCESS · LLM: scripted
```

The live round-trip also exercised the operational paths in the same run: §10 deferral
(`{"ageMs":2054,"minInterval":8,"msg":"question deferred to respect the minimum interval"}`), the
outbox having exactly **31 outbound** messages for 30 answers (one question per turn, none duplicated),
and `GET /dev/simulator/project/:id` + `GET /dev/simulator/lookup` serving the console.

**Human-visible surface for this phase (the pre-panel inspection path):** `npm run inspect`,
`/api/v1/projects/:id/requirements` (fields + §10A statuses + `pendingFieldPath` + summary markdown), and
the dev console at `http://<host>:3000/` where a human can type as the client and watch completeness,
field table, contradictions, open tasks and the internal summary update live.

### 3.4 Commands you can re-run

```bash
npm run verify                 # typecheck + 96 tests + docs check
npm run db:reset               # recreate the dev DB (PGlite does not survive a sandbox restore)
LLM_PROVIDER=scripted npm run dev &    # API :3000 + embedded worker; open / for the console
npm run demo:live              # drive the running API over HTTP (≈4 min: 30 questions, §10 interval 8 s)
npm run simulate:requirements  # the same journey in memory, no server needed
npm run inspect                # CLI dump: projects, requirements, jobs, transitions, artifacts
```

---

## 4. Incomplete / risky (honest list)

1. **No real LLM has been called yet.** Everything above ran on the scripted provider; `createLlmClient`
   (OpenAI-compatible + Anthropic HTTP) is written and unit-covered at the client level, but the first
   live-provider run needs a key. Until then, prompt quality for a real model is *unverified* — the
   contracts, limits and repair path are.
2. **The scripted demo's answers are a persona, not a client.** Some optional fields stay `EMPTY` (9 of 39
   in §3.3) and the demo driver must be told the live pending field (`requirement_versions.pending_field_path`)
   to answer sensibly; a real model does not need that hint.
3. **Question wording is model-owned.** The persona ships human-readable Uzbek questions as data
   (`QUESTION_TEXT`); with a real provider the wording will differ, and only the contract limits are
   guaranteed (D-028).
4. **PGlite does not survive sandbox restores.** After a restore, `npm run migrate`/`seed` fail with
   `PGlite failed to initialize properly`; `npm run db:reset` rebuilds the dev DB (data loss acceptable for
   dev/CI — D-004/D-022, `PHASE_REPORTS/phase1.md` §4.6).
5. **Vision/score fields are structural.** `requirement_versions.vision` and the completeness score are
   persisted and shown, but no UI lists "AI-inferred vs client-confirmed" per field other than through the
   API/console table; a proper diff view is Phase-7 work.
6. **Cost accounting is recorded, not enforced.** `llm_usage` rows and mock pricing exist
   (`costUsd` = 0.0000 on the fake provider); the `$10/day` cap is config but not yet a hard gate (§26),
   because no paid provider is enabled.
7. **Do not run the test suite while the dev server is up.** One `vitest run` with the API+worker
   process alive ended in `Worker forks emitted error / Worker exited unexpectedly` (94/96 + 1 error);
   with the server stopped the same command is 96/96 green. It is sandbox resource contention (PGlite +
   fork workers), not a failing test — stop the server before `npm run verify`.
8. **Rate limiting remains structural** (unchanged from Phase 1) and the real Meta send path is still
   untested against the Graph API — both deliberate, both listed again for honesty.

---

## 5. Open questions (need a human answer)

1. **LLM providers & keys (blocking for Phase 3 quality, not for starting it).** Which providers for the
   main agents and for the Spec Auditor (Phase 0 decision: *different* provider for the auditor)? A key is
   needed to validate prompt quality against a real model; until then Phase 3 can start on the scripted
   provider.
2. **Budget cap.** Default `LLM_DAILY_BUDGET_USD=10` is recorded but not enforced — should Phase 3 wire it
   as a hard gate before any paid call?
3. **Instagram route (still open from Phase 0, Q3).** Instagram-Login vs Facebook-Login for the Meta
   submission; the code targets Instagram-Login today. No Phase-2 impact.
4. **Human-agent tag.** Still `HUMAN_AGENT_TAG_ENABLED=false`. Phase 3 will send the *client approval*
   request — automated, inside the 24 h window, so the tag is not needed yet; confirm it stays off.
5. **Approval UX for Phase 3.** The client will be asked to approve the specification in a DM (§16): one
   message with a short summary + "reply 'OK' to approve", or a two-step (send summary → ask)? The phase
   file allows both; a decision simplifies the implementation.

---

## 6. Proposed next step

**Phase 3 — Specification Agent & client approval (`docs/phases/03_*.md`)** on top of the Phase-2
foundation: the Spec Agent consumes the internal summary + structured requirements, produces the technical
specification with traceability (REQ → SPEC-REQ → acceptance criteria) and the client-facing summary,
registers version v1, sends exactly one approval request, and locks the approved version (T06…T10).

**Awaiting your explicit approval to start Phase 3.**

# PHASE 3 PLAN — Specification Agent & Client Approval

**Phase file:** `docs/phases/03_phase3_specification_and_client_approval.md` · **Decision log:** `DECISIONS.md`
**Human decisions taken before starting (2026-10-08):** Phase 3 approved to start · **the whole project must stay
completely free** (no paid services anywhere in the pipeline) · client approval is **two-step** (summary first,
then an explicit approve/change request) · LLM keys will be provided by the human (free-tier keys).

## 1. What Phase 3 must deliver (from the phase file)

| # | Task | Acceptance evidence |
|---|---|---|
| 1 | Specification Agent → Technical Specification (§15) with traceability REQ → SPEC-REQ → AC (§16) | every MUST requirement field maps to ≥1 `SPEC-REQ-xxx`, each with ≥1 testable `AC-xxx` |
| 2 | Testable acceptance criteria for every major feature (§17) | traceability audit fails loudly on a non-testable AC (no "beautiful", "fast") |
| 3 | Client Summary generated FROM the specification, simple language, `[APPROVE]` / `[REQUEST CHANGES]` (§18) | summary is written by the same agent run from the same object; consistency check rejects a summary that names a page/feature the spec does not contain |
| 4 | Versioning: client change → new spec version, old preserved, summary regenerated, approval requested again (§19) | v1 stays readable after v2 exists; `client_approvals` records both events |
| 5 | Approved version becomes LOCKED; later changes become Change Requests (§35) | `PATCH` on a locked spec → `409 SPEC_IS_LOCKED`; `POST /change-requests` → 201 `REQUESTED` |
| 6 | States: REQUIREMENTS_COMPLETE → SPEC_GENERATING → CLIENT_REVIEW → CLIENT_CHANGES_REQUESTED / CLIENT_APPROVED | T06/T07/T08/T09/T10 rows in `project_state_transitions` |

## 2. Free-of-charge constraint (new, from the human)

The pipeline must run end to end at **zero cost**. Concretely:

- `LLM_FREE_ONLY=true` is the **default**: `createLlmClient` refuses a provider whose endpoint is not a known-free
  one (or the local machine), and the platform behaves like "no LLM configured" — never a silent paid call.
- `config/llm-presets.json` lists the free routes (Gemini AI Studio free tier, OpenRouter `:free`, Groq free plan,
  local Ollama/LM Studio) with their real limits; the paid routes are listed but marked `free: false`.
- Docs (`docs/12`) gain a "free providers" table with sources and the data-training caveat of free tiers.

## 3. Implementation order (sequential; each step keeps `tsc` + tests green)

1. **Config/infra:** `config/llm-presets.json`, `packages/infra/src/llm-presets.ts`, config keys `LLM_PRESET`,
   `LLM_FREE_ONLY`, factory guard, docs/12, D-029.
2. **Contracts:** `packages/agents/src/contracts.ts` — `SpecificationOutputSchema` (mirrors
   `docs/contracts/specification-output.json`), `ClientIntentSchema` (mirrors `client-intent-output.json`).
3. **Core (`packages/core/src/spec/`):** `types.ts` (SpecDocument, SpecRequirement, AcceptanceCriterion,
   SpecStatus), `traceability.ts` (coverage audit + orphan detection), `consistency.ts` (summary ↔ spec),
   `versioning.ts` (next version, editability/lock rules), `intent.ts` (deterministic approval keywords per
   language + two-step state derivation). Pure functions, unit-tested.
4. **Data:** migration `0003_phase3_specification.sql` — `spec_versions`, `spec_requirements`,
   `acceptance_criteria`, `client_approvals`, `change_requests`; schema + `repositories/specs.ts`
   (create/insert/list/get, lock, record approval, change requests); seeding of the SPECIFICATION agent config
   + `spec.*` config values from `config/`.
5. **Agents:** `packages/agents/src/spec/agent.ts` — spec generation/revision prompt, client-intent prompt.
6. **Worker:** handlers `spec.ts` (`SPEC_GENERATE`, `SPEC_REVISE`) and `clientIntent.ts`
   (`CLIENT_INTENT_PARSE`, `CLIENT_APPROVAL_TIMEOUT`), registry + `JOBS_ALLOWED_IN_STATE`, and the hand-off
   from the requirements handler to `SPEC_GENERATE` (T06).
7. **API/console:** `GET /api/v1/projects/:id/spec`, `PATCH …/spec-sections/:id` (lock guard),
   `POST …/change-requests`; console gets a spec panel and the two-step approval flow in the chat.
8. **Tests:** unit (traceability, consistency, versioning/lock, intent, presets), integration (spec repo,
   locked edit, CR), e2e `spec-approval.test.ts` (full v1 → change → v2 → approve → LOCK, old version kept,
   summary/spec never contradictory, one approval only).
9. **Drivers + docs + report:** `npm run simulate:phase3`, live run against the dev server, DECISIONS,
   docs/07, 12, 13, 14, phase status, `PHASE_REPORTS/phase3.md`, commit, STOP for approval.

## 4. Out of scope (do not implement now)

Spec Auditor (Phase 4), coding (Phase 5), Code Checker (Phase 6), Team Panel UI (Phase 7). The Approval
timeout job stays a stub only if the reminder path is already covered by `INACTIVITY_CHECK`; otherwise it is
implemented minimally (one reminder, then a human task).

## 5. Risks

- **Free-tier rate limits** (Gemini Flash 5–15 RPM / 100–1,000 RPD; Groq 30 RPM / 1,000 RPD; OpenRouter 20 RPM /
  50 RPD) will be hit by a 30-question interview: the runtime already caps tokens and the interval guard spaces
  requests; the docs will state the limits honestly and the demo stays on the scripted provider.
- **Model quality on a free model**: the traceability audit + one repair attempt is the structural defense;
  failures become a human task, not a silent bad spec.
- **Approval by keyword** can be wrong: only messages classified `APPROVE` with confidence ≥ threshold (0.85)
  and a stored `source_message_id` become an approval; anything else gets exactly one clarifying question.

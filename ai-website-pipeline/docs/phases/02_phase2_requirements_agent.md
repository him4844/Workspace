# Phase 2 - Requirements Agent

**Goal:** Collect complete, structured requirements from the client through Instagram.

**Read in SPEC.md first (sections):** 5-13, 10A, 11, 12, 38, 40, 49-51

Also follow 00_COMMON_RULES.md.

## Tasks
1. Questionnaire schema as data (18 mandatory categories) plus website-type question packages (e-commerce, restaurant, education, landing page, corporate). New packages must be addable without changing agent code (Section 7).
2. Website type detection from the first message.
3. One question at a time; short messages suitable for Instagram.
4. Dynamic follow-up questions only for vague answers, contradictions, missing business-specific requirements, and dependent requirements (Section 8).
5. Internal project vision with clear separation of client-confirmed, AI-inferred, and not-specified items (Section 9).
6. Completeness engine using ONLY the unified status vocabulary in Section 10A. Configurable limits (max questions, max clarification cycles, inactivity reminder) stored in config.
7. Handling of "I don't know" answers per Section 11.
8. Versioned structured requirements object (Section 12) with must / nice_to_have / later priorities (Section 13).
9. Prompt-injection protection: client messages are data, never instructions (Section 38).
10. Output an internal requirements summary for the next phase. Do NOT ask the client for a separate approval here (Section 10).

## Deliverables / acceptance checks
- Full restaurant-style conversation test ends with status REQUIREMENTS_COMPLETE
- Contradiction test (minimal design vs many animations) triggers a clarification question
- Injection test (client asks the AI to ignore instructions) is treated as ordinary content
- Statuses never move to CLIENT_CONFIRMED without an explicit client message reference

## Definition of done
Phase 2 is done when the acceptance checks pass and the structured requirements can be inspected.

## NOT in this phase
Specification generation, client approval, coding.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.


---

## Status: COMPLETE — 2026-10-08 (awaiting human approval before Phase 3)

All ten tasks above are implemented as data + engine + one agent turn; the four acceptance checks were
re-run against the live system and quoted in `PHASE_REPORTS/phase2.md`:

- full restaurant-style conversation ends in `REQUIREMENTS_COMPLETE` (31 client turns, completeness 1.000,
  39 fields, 24/24 mandatory, summary artifact written);
- contradiction test (minimal design vs many animations) triggers a clarification question and resolves it;
- injection test is flagged once (`SECURITY_ALERT`) and treated as ordinary content;
- no field reaches `CLIENT_CONFIRMED` without a real client message reference (`CLIENT_TRUTH_NEEDS_SOURCE`).

Evidence: `npm run verify` (typecheck + 96 tests + docs check), `npm run simulate:requirements`,
`npm run demo:live` against the running API (dev console at `/`). Decisions added: D-025 … D-028.

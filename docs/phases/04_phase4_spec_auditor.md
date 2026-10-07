# Phase 4 - Spec Auditor

**Goal:** Automatically verify that the approved specification is complete, consistent, unambiguous and ready for a coding agent.

**Read in SPEC.md first (sections):** 20, 21, 42, 40, 49

Also follow 00_COMMON_RULES.md.

## Tasks
1. Spec Auditor agent: completeness, consistency, ambiguity, coding readiness, client alignment (Section 20), returning the structured JSON result.
2. Revision loop: FAIL sends structured issues to the Specification Agent, which produces a new version; maximum 3 automatic attempts (Section 21).
3. After 3 failures: state BLOCKED, create a human task, show the exact unresolved issues. No infinite loops.
4. State transitions: CLIENT_APPROVED -> SPEC_AUDIT -> READY_FOR_BUILD or SPEC_REVISION_REQUIRED or BLOCKED.
5. Human-in-the-loop rule (Section 42) with a clear explanation of WHY a human is needed.

## Deliverables / acceptance checks
- A good spec gets PASS
- A spec with deliberate gaps (missing payment details, vague word like 'beautiful') gets FAIL with specific issues
- Loop stops after 3 attempts and creates a human task
- A revised spec that changes the client's approved meaning is flagged as a client-alignment failure

## Definition of done
Phase 4 is done when the acceptance checks pass.

## NOT in this phase
Coding agent.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

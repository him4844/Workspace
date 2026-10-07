# Phase 6 - Code Checker

**Goal:** Verify the generated website against the approved specification and run an automatic correction loop.

**Read in SPEC.md first (sections):** 25, 25A, 26, 42, 16, 17, 49

Also follow 00_COMMON_RULES.md.

## Tasks
1. Compare approved spec to the generated application across the 18 areas in Section 25.
2. MANDATORY runtime verification per Section 25A: build, start the app, run automated tests generated from acceptance criteria, responsive checks, basic link/console/asset checks, basic security checks. Attach evidence.
3. Record how each requirement was verified: RUNTIME_TESTED, STATIC_ONLY, or NOT_VERIFIED.
4. Never PASS a build that could not be built or run.
5. Feedback loop: FAIL sends structured feedback to the Coding Agent, then re-check; maximum 3 attempts (Section 26).
6. After 3 failures: stop automation and create a human review task showing all failed checks, attempted fixes, and the current version.
7. State transitions: CODE_AUDIT -> TEAM_REVIEW (PASS) or CODE_REVISION_REQUIRED or BLOCKED.

## Deliverables / acceptance checks
- A correct build gets PASS with runtime evidence
- A build with a deliberately removed feature gets FAIL naming the missing requirement
- A build that fails to compile is FAIL
- Loop stops after 3 attempts with a human task
- Critical security issue stops automation immediately

## Definition of done
Phase 6 is done when the acceptance checks pass. This completes the first full vertical slice (Section 47): Instagram -> requirements -> spec -> approval -> audit -> build -> code check.

## NOT in this phase
Team Panel UI beyond the minimal inspection tools.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

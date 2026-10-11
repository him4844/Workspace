# Phase 5 - Main Coding Agent (start with a landing page)

**Goal:** Generate a runnable website from an approved, audited specification.

**Read in SPEC.md first (sections):** 22, 23, 49-51, 40, 45

Also follow 00_COMMON_RULES.md.

## Tasks
1. Main Coding Agent receives ONLY the approved, audited Technical Specification as the source of truth.
2. Start with ONE simple website type: landing page. Do not attempt all website types.
3. Strict separation of UI layer and business logic/backend (Section 23) so the design can be replaced later.
4. Implement responsive UI plus error, loading and empty states; produce a runnable project, tests where appropriate, and build/deployment information.
5. Never invent major functionality that is not in the specification. If something critical is undefined, record an issue instead of guessing (Section 22).
6. Store each build as a versioned artifact with a preview.
7. State transitions: READY_FOR_BUILD -> BUILDING -> CODE_AUDIT (or FAILED with a structured error).

## Deliverables / acceptance checks
- A landing page spec produces a project that builds and runs
- Preview is reachable
- UI components contain no business logic (separation check)
- Build is stored as Build v1 with logs

## Definition of done
Phase 5 is done when the generated landing page builds, runs, and the build is versioned and viewable.

## NOT in this phase
Code Checker, Team Panel, other website types.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

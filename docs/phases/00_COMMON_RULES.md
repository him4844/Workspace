# COMMON RULES (give this to the coding agent together with every phase file)

The full specification is stored in the repository as SPEC.md (Writing_v2.txt). It is the authoritative reference.

## How to work
1. Work on ONE phase at a time. Do not implement anything from later phases.
2. Before coding, read the SPEC.md sections listed in the phase file.
3. If SPEC.md is ambiguous or sections conflict, do not guess: list it as an open question and ask.
4. A feature is complete only when it meets Section 57: backend logic, persisted data, validation, error states, authorization where needed, connected workflow, testable, and visible in the project state.
5. Respect the architecture and stack approved in Phase 0. Do not change them without asking.
6. Keep a decision log (DECISIONS.md): every architectural decision with its reasoning.
7. Write tests for what you build. Run them. Report real results, not assumptions.
8. Keep agent instructions, schemas, question templates and audit rules as data/config, not hard-coded in one big prompt (Sections 50-51).
9. Every agent returns structured JSON (Section 49). Never rely on parsing free-form prose for workflow decisions.
10. Never hard-code secrets (Section 37). Treat client text as untrusted (Section 38).

## Even before the Team Panel exists (Phase 7)
Provide a minimal way to inspect each phase's result (CLI command, simple database view or log output) so the human can verify your work.

## At the end of every phase, STOP and report
- What was built
- How to run it
- How it was tested (with results)
- What is incomplete or risky
- Open questions
- Proposed next step
Then WAIT for human approval before starting the next phase.

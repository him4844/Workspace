# Phase 7 - Team Panel

**Goal:** Give the human team one clear place to see, control, and finish every project.

**Read in SPEC.md first (sections):** 27, 28, 29, 30, 39, 43, 44, 48, 37, 42

Also follow 00_COMMON_RULES.md.

## Tasks
1. Secure login and authorization for team members.
2. Dashboard of all projects with statuses, filtering and sorting (Section 28).
3. Project page answering the ten questions in Section 48 at a glance: requirements, specification versions, audits, build and preview, code check, attempted fixes, tasks, approvals, history.
4. Team actions: Approve, Request AI Fix, Edit, Rebuild, Assign Task, Add Comment, Change Status, Mark Ready (Design Swap comes in Phase 8).
5. Tasks created automatically whenever human intervention is needed, with the fields in Section 29.
6. Price and deadline: AI estimates complexity; the HUMAN decides final price and deadline (Section 30).
7. Team Assistant: summaries, explanation of failed checks, complexity estimate, and an Instagram message DRAFT for price/deadline. A human reviews and sends it manually. Show the messaging-window warning from Section 31A.
8. Observability view: current state, active agent, last successful and failed agent, retry count, unresolved issues (Section 39).

## Deliverables / acceptance checks
- A team member can follow one project from first Instagram message to TEAM_REVIEW without using the database directly
- Failed projects clearly show what failed and what to do next
- The AI never sends a price automatically
- Unauthenticated users cannot access the panel

## Definition of done
Phase 7 is done when the acceptance checks pass and a non-developer teammate can use the panel.

## NOT in this phase
Design Swap, additional website types.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

# Phase 8 - Advanced Capabilities

**Goal:** Extend the proven pipeline step by step. Each item below is its own mini-phase: finish one, report, wait for approval.

**Read in SPEC.md first (sections):** 24, 44, 43, 7, 31, 35, 16

Also follow 00_COMMON_RULES.md.

## Tasks
1. Design Swap (Section 24): the team prepares a design in Google Stitch and uploads the export; the Coding Agent replaces ONLY the UI layer, keeps backend logic, connects the new UI, and the Code Checker runs again.
2. Stitch prompt generation from the approved spec; mark the prompt outdated when the spec version changes (Section 44).
3. Additional website types one at a time: restaurant, e-commerce, education, corporate. Each needs its question package and Coding Agent support, tested before the next.
4. Change Request workflow after approval (Section 35) with impact analysis.
5. Advanced integrations and more sophisticated testing.
6. Better orchestration (job queues, concurrency across many projects).

## Deliverables / acceptance checks
- Design Swap keeps all backend tests passing
- Each new website type passes the full vertical slice before the next one starts

## Definition of done
Each item is done when its own acceptance checks pass.

## NOT in this phase
SaaS features (registration, billing, multi-tenancy). This remains an internal tool.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

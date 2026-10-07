# Phase 3 - Specification and Client Approval

**Goal:** Turn complete requirements into a verified-quality specification and get ONE client approval.

**Read in SPEC.md first (sections):** 14-19, 34, 35, 12, 10A

Also follow 00_COMMON_RULES.md.

## Tasks
1. Specification Agent producing the Technical Specification (Section 15) with traceability IDs: REQ -> SPEC-REQ -> AC (Section 16).
2. Testable acceptance criteria for every major feature (Section 17).
3. Client Summary generated FROM the Technical Specification, in simple language, with [APPROVE] / [REQUEST CHANGES] (Section 18).
4. Versioning: client changes create a new spec version, old versions are preserved, summary regenerated, approval requested again (Section 19).
5. Approved version becomes LOCKED. Later changes become Change Requests (Section 35).
6. State transitions: REQUIREMENTS_COMPLETE -> SPEC_GENERATING -> CLIENT_REVIEW -> CLIENT_CHANGES_REQUESTED / CLIENT_APPROVED.

## Deliverables / acceptance checks
- Spec v1 -> client requests change -> spec v2 -> client approves -> v2 locked; v1 still stored
- Client Summary and Technical Spec never contradict each other
- Attempt to edit a locked spec is rejected and requires a Change Request
- Every important requirement has a traceable source and acceptance criteria

## Definition of done
Phase 3 is done when the acceptance checks pass and the approval flow works end to end through Instagram.

## NOT in this phase
Spec Auditor, coding.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.

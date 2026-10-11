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


---

## Status: COMPLETE — 2026-10-08 (awaiting human approval before Phase 4)

All six tasks are implemented; the four acceptance checks were re-run against the live system and are
quoted in `PHASE_REPORTS/phase3.md`:

- spec v1 → client requests a change → spec v2 → client approves → **v2 LOCKED, v1 stored**
  (`npm run simulate:phase3`, `tests/e2e/spec-approval.test.ts`);
- Client Summary and Technical Specification never contradict each other — the summary is generated
  FROM the specification and the §19 consistency audit blocks a mismatch (it also blocks a summary
  that names a page/feature the specification does not contain);
- an edit attempt against a locked specification is rejected (`409 SPEC_IS_LOCKED`) and the only open
  door is a Change Request (§35), verified over HTTP in the e2e suite;
- every client-confirmed requirement field reaches the specification with a traceable `SPEC-REQ` entry
  and at least one testable acceptance criterion (§16/§17) — an incomplete specification becomes a
  human task instead of a client message (D-031).

Production notes: the client approval is **two-step** (D-030), the free-only rule applies to every
provider choice (D-029), and one specification exists per requirements version (D-032). Evidence (run
2026-10-08) is stored under `PHASE_REPORTS/evidence/`: `phase3-verify.txt` (typecheck + 12 files /
138 tests + docs check), `phase3-simulate.txt` (`npm run simulate:phase3`), `phase3-live-run.txt`
(`npm run demo:live` with `DEMO_PHASE3=1` against the running API + dev console specification panel).

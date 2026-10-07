# Deliverable 14 — MVP Implementation Plan

**Status:** Phase 0 design. Source: SPEC §46 (phases), §47 (no overengineering), §58 (final acceptance scenario), COMMON_RULES. Each phase ends with a report + explicit human approval (no skipping — §55A.5).

## 0. Sequencing decision: what is sequential, what runs in parallel

**Sequential (cannot be parallelized — each phase's acceptance is the next phase's prerequisite):**
`P0 → P1 → P2 → P3 → P4 → P5 → P6` (first full vertical slice, §47). Then `P7 → P8`.

**Parallel tracks (start NOW, run alongside development):**

| Track | Why it must start early | Owner |
|---|---|---|
| **A. Meta path** — create Meta app, business verification, App Review for `instagram_business_manage_messages` (+Human Agent), screencast, privacy policy URL | External review takes weeks; it gates *live* Instagram but not development (simulator covers P1–P6) | human team |
| **B. Instagram setup** — professional account, "Allow access to messages", test IG account | 30 minutes of work, unlocks Standard-Access smoke tests | human team |
| **C. Design tokens + brand** — colors/fonts for AI-generated landing pages; Stitch workspace | Needed by Coding Agent quality bar (P5) | human team |
| **D. Decisions in `17_open_questions.md`** — LLM provider choice, hosting, roles, message locale | Blocks nothing in P0, blocks P2 (LLM keys) and P7 (roles) | human team |
| **E. Panel visual design** (Figma/mockups) | Panels dev starts P7; design can be prepared meanwhile | human team |

**Critical path = A (Meta review)**. Everything else is internal and fast. Recommendation: file the Meta App Review the same week Phase 1 starts.

## 1. Phase-by-phase plan (maps to SPEC §46)

Every phase delivers: working feature + tests that actually ran + a minimal inspection path for humans (COMMON_RULES) + a PHASE_REPORTS file.

| Phase | Deliverable | Acceptance test (from spec + ours) | Est. size |
|---|---|---|---|
| **P0** *(this document set)* | Docs 01–19, stack proposal, skeleton, DECISIONS.md | Human reads and approves stack + architecture (§55A.3) | done |
| **P1 Instagram & conversations** | webhook (verify+dedupe), conversation engine, simulator adapter, send path, project+client creation, state machine core (states up to INTAKE), agent_runs table, logs, minimal inspector (`pnpm inspect:conversation`) | echo test via simulator AND via real IG test account (if track B done); duplicate webhook no-op; two clients never mixed; messages persisted | 3–5 days |
| **P2 Requirements Agent** | questionnaire data model + GENERAL + 5 packages, dynamic question logic, 10A statuses, completeness engine, contradiction detection, "I don't know" handling, injection defense, internal summary | restaurant conversation reaches `REQUIREMENTS_COMPLETE`; contradiction triggers clarification; injection treated as content; no status → CLIENT_CONFIRMED without message ref | 5–8 days |
| **P3 Specification & approval** | Spec Agent (structured spec + traceability REQ→SPEC-REQ→AC + acceptance criteria), Client Summary, one approval via IG, versioning, LOCK, change requests | v1 → change → v2 → approve → v2 locked, v1 preserved; summary ↔ spec never contradict; locked spec edit rejected; approval only with message id | 4–6 days |
| **P4 Spec Auditor** | auditor agent + findings, revision loop (max 3), BLOCKED + human task, alignment check | good spec PASS; gapped spec FAIL with specific issues; loop stops at 3 → task; meaning-changing revision → alignment failure | 3–4 days |
| **P5 Coding Agent (landing page)** | spec→project generator, UI/business separation, error/loading/empty states, build runner, artifact+preview, build versioning | landing spec → project builds & runs; preview reachable; separation check; Build v1 with logs | 6–10 days |
| **P6 Code Checker** | runtime verification (build/start/E2E/responsive/links/console/a11y/security), per-requirement method labels, feedback loop (max 3), human escalation | correct build PASS with runtime evidence; removed feature FAIL naming the requirement; non-compiling build FAIL; loop stops ×3; critical security stops immediately | 5–8 days |
| **P7 Team Panel** | auth+RBAC, dashboard, project page (10 questions), tasks, price/deadline with human-only rule, Team Assistant drafts, observability, window warnings | one project followed from first DM to TEAM_REVIEW without touching the DB; AI never sends price; unauth users blocked | 6–10 days |
| **P8 Advanced** (mini-phases) | Design Swap, Stitch prompt versioning, additional website types (restaurant → e-commerce → education → corporate), CR workflow, better orchestration | Design Swap keeps backend tests green; each new type passes the full vertical slice before the next starts | iterative |

## 2. MVP scope guardrails (§47)

**In:** the vertical slice above, page-per-website-type = landing page only, channels = Instagram + simulator, single org, single IG account, no design swap until P8.

**Out (explicitly):** registration/billing/tenancy (§2), Telegram/WhatsApp (§31), all 5 website types at once, multi-account Instagram, client self-service portal, price automation.

## 3. Engineering workflow per phase

```
1. read the phase file + relevant SPEC sections (as required by the phase doc)
2. update DECISIONS.md if anything new is decided
3. implement: domain → infra → handlers → api → (panel from P7)
4. write tests as you go; run `npm run verify` (typecheck, lint, unit, integration, contract)
5. run the phase's acceptance script (real, not claimed — COMMON_RULES #7)
6. produce PHASE_REPORTS/phaseN.md: built / how to run / how tested (results) / incomplete & risky / open questions / next step
7. STOP. Wait for approval.
```

## 4. Estimates & order-of-magnitude calendar

Assuming one experienced full-stack dev + this AI-assistant workflow, part-time human involvement for approvals:

| Milestone | Calendar (from approval) |
|---|---|
| P1 done (live-ish Instagram echo) | week 1–2 |
| P2 done (requirements) | week 3–4 |
| P3–P4 done (spec + audit) | week 5–6 |
| P5–P6 done → **first full vertical slice (§47)** | week 7–9 |
| P7 done (usable Team Panel) | week 10–12 |
| P8 items | thereafter, one at a time |

Meta App Review (track A) should be filed in week 1–2 so that approval lands before the slice is complete.

## 5. Risks to this plan

See `16_known_risks.md` — top three: Meta approval latency (mitigated by simulator), LLM output quality on the coding agent (mitigated by loop caps + checker), and sandbox resource limits for builds (mitigated by concurrency caps and the dedicated coderunner).

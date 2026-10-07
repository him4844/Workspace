# Deliverable 10 — Team Panel Architecture

**Status:** Phase 0 design. Source: SPEC §27, §28, §29, §30, §39, §43, §48. Built in Phase 7 (minimal inspection CLI/screens exist from Phase 1 per COMMON_RULES).

## 1. Principles

1. **Clarity over visual complexity (§48).** Every project page answers the 10 questions without navigation: what is this, what state, what did AI complete, what failed, what needs a human, what did the client ask, what spec was approved, what was built, what the checker found, what to do next.
2. **Humans decide money/time.** The panel never sends a price/deadline automatically (§30).
3. **The panel is a thin client over the REST API** — no business logic in React; all guards (state transitions, locks, windows) are enforced server-side.
4. **Everything visible is derived from DB rows** — no hidden state, no "trust me" displays (§39).

## 2. Information architecture

```
/login
/dashboard                  projects table: state, client, assignee, last activity, open tasks, alerts
/projects/:id               ← the "10 questions" page (tabs below)
    Overview                status card · next required action · blockers · window warning · money/time
    Conversation            Instagram thread (read), drafts, send box, handover toggle
    Requirements            fields + 10A statuses, completeness, contradictions, overrides (with reason)
    Specification           versions, lock badge, Client Summary sent/accepted, audit reports
    Build                   build versions, logs (SSE), preview link/iframe, artifacts
    Code Check              PASS/FAIL, per-requirement verification table (RUNTIME/STATIC/NOT_VERIFIED), evidence
    Design                  AI design refs, Stitch prompt (versioned), Design Swap upload (Phase 8)
    Tasks & Comments        open/closed tasks, comments, assignment
    Timeline                merged events + state transitions (append-only history §34)
    Assistant               summary, explain-failure, complexity estimate, drafts (price/deadline/Stitch)
/tasks                      my tasks, all tasks, filters by priority/type
/clients/:id                client record, identities, projects, notes
/agents                     agent configs, versions, activation/rollback, usage/cost
/queue                      jobs: pending/running/parked/dead-letter; retry/cancel (ADMIN)
/settings                   team members, roles, config_values (loop limits, window thresholds), integrations
/integrations/instagram     connection status, token expiry, re-auth button, webhook health
```

## 3. The ten questions (§48) → data sources

| Question | Source |
|---|---|
| 1 What project is this? | `projects` + `clients` + `project_type` |
| 2 Current status? | `projects.state` + `project_state_transitions` (latest) |
| 3 What has AI completed? | counts per module: requirements completeness, spec version, build version, check status |
| 4 What failed? | latest `spec_audits.status=FAIL` / `code_checks.status=FAIL` + findings by severity |
| 5 What requires human action? | open `tasks` + `watchdog` alerts (blocked, window closed, token expiry) |
| 6 What did the client request? | requirements fields with `source_message_id`, contradictions, change requests |
| 7 What spec was approved? | `spec_versions.status=LOCKED` + `client_approvals(APPROVED).recorded_at` + summary artifact |
| 8 What did the coding agent build? | `builds` latest BUILT + artifact tree + preview URL |
| 9 What did the checker find? | `code_checks` latest + `verification_results` + `check_findings` grouped by severity |
| 10 What should I do next? | **`nextAction` derivation** (below) |

### 3.1 `nextAction` derivation (server-side, deterministic)

A small pure function maps `(state, openTasks, latest audit/check, window status, blockers)` → `{title, description, primaryActionButton}`. Examples:

| State/condition | Next action shown |
|---|---|
| `TEAM_REVIEW` + check PASS | "Review the build, then mark ready for pricing" → `[Mark ready for pricing]` |
| `PRICE_PENDING` | "Set the final price" → `[Set price]` (human input form) |
| `DEADLINE_PENDING` | "Set the deadline and send the draft" → `[Set deadline]`, `[Send draft]` (window warning if closed) |
| `BLOCKED` (check failed ×3) | "Automation stopped. Review the failed checks and fix or reassign" → `[Open failed checks]` |
| any + window closed | "Messaging window closed — contact the client another way" → `[Create follow-up task]` |
| any + token NEEDS_REAUTH | "Instagram connection expired — reconnect" → `[Reconnect]` |

## 4. Team actions (§27) and their implementation

| Button | API | Effects |
|---|---|---|
| Approve (internal step) | `POST /projects/:id/transitions` T25 | state → `PRICE_PENDING`, task `PRICE_DECISION` |
| Request AI Fix | `POST /projects/:id/transitions` T23 + `POST /projects/:id/builds {instructions}` | new build version; coding agent gets team instructions as **additional context** (still spec-bound) |
| Edit | panel edits (requirements field override / spec change request) | never edits a LOCKED spec in place → creates `change_requests` (§35) |
| Rebuild | `POST /projects/:id/builds` | build vN+1 from same locked spec |
| Design Swap | `POST /builds/:id/design-swap` (Phase 8) | UI-layer replacement build; backend tests must stay green (§24) |
| Assign Task | `PATCH /tasks/:id {assignee_member_id}` | assignment + notification |
| Add Comment | `POST /projects/:id/comments` | recorded with member id |
| Change Status | restricted transitions (T30 Block, T31 Resolve, T28, T29) | reason required; logged |
| Mark Ready | `POST /projects/:id/transitions` T28/T29 | delivery prep → completed |

**Every button** → server re-validates (state guard + role) → writes `team_actions` + `events` (§37, §39).

## 5. Price & deadline UX (§30)

```
PRICE_PENDING:
  [Complexity estimate card]  AI: complexity=medium, est. hours 18–26, risks=[payment integration]
  [Set final price]           human form: amount, currency, note      → stored with set_by member
DEADLINE_PENDING:
  [Set deadline]              human date picker                        → stored
  [Draft message]             Team Assistant draft (editable textarea)
  [Send]                      guarded send: window check → open? send : (human_agent eligible? tag : block+task)
```
The API **rejects** price/deadline writes whose actor is not a human member (`actor_type=HUMAN`), which is how "AI must not send final price" is enforced structurally, not by convention.

## 6. Observability panel (§39)

Per project card + project header:
`current state · active agent (running job/agent_run) · last successful agent (type, when, duration) · last failed agent (type, when, errorCode) · retry counts (loop_counters, job attempts) · unresolved issues (open findings + contradictions + tasks) · human intervention required (bool + reason)`.

Plus `/queue` for ADMIN: dead letters, parked jobs (`STATE_MISMATCH`), lease expiries, LLM error summary, cost per project (from `llm_usage`).

## 7. Roles (§37)

| Role | Can |
|---|---|
| `VIEWER` | read everything |
| `MEMBER` | + comments, tasks, drafts, send messages, rebuilds, request AI fixes |
| `LEAD` | + transitions (T23/T25/T28/T29/T30/T31), trigger audits/checks, lock specs, set price/deadline |
| `ADMIN` | + members, agent configs, queue ops, integrations, config_values |

Role checks are server-side middleware; the UI hides what the role cannot do but never *only* hides it.

## 8. Frontend stack notes

- Next.js App Router, React Server Components for all reads; server actions call the API with the member's session.
- Minimal client JS: build-log viewer (SSE), task badge poll (~30 s), markdown preview, diff viewer for spec versions.
- No external CDN assets (self-hosted fonts/icons) — internal tool, works offline in the office network.
- Dark/light theme, keyboard-first navigation for speed, and a compact "operator" density mode.
- Accessibility: WCAG-AA contrast, full keyboard operability, semantic landmarks (we audit our own panel with axe in CI — practice what the code checker preaches).

# Deliverable 17 — Known Risks

**Status:** Phase 0. Includes the mandatory Meta/Instagram items from SPEC §31A. Re-review at every phase boundary.

Scale: **L** likelihood, **I** impact (H/M/L). Every risk has a mitigation and an owner. "Design consequence" means the architecture already assumes the risk is real.

## A. Platform / external risks (§31A mandatory)

| # | Risk | L | I | Mitigation / design consequence | Owner |
|---|---|---|---|---|---|
| A1 | **Meta App Review + Business Verification for messaging access takes weeks and can be rejected** | H | H | Simulator channel makes P1–P7 fully developable now (design consequence); file review in week 1; screencast script prepared; fallback = FB-Login route adapter; worst case: phase 8+ delays live launch, not delivery quality | human team |
| A2 | **Messaging window (24 h / 7-day human_agent) blocks replies**, esp. price/deadline messages (§30, §31A.4) | H | M | Window clock stored per conversation; panel warning 2 h before expiry; sender blocks outside window → `SEND_BLOCKED` + human fallback task; `human_agent` path for human-authored replies ≤7 d after approval; no re-engagement template exists — client must re-initiate | platform |
| A3 | "Allow access to messages" toggled off (silent webhook stop, sends fail 200/2534041) | M | H | Webhook watchdog (no inbound for N h while expected) + panel banner + runbook check; documented in onboarding checklist | ops |
| A4 | Token expiry (60-day long-lived; refreshable only if ≥24 h old and not expired) | M | H | Daily refresh job + expiry tracking + `NEEDS_REAUTH` banner + human task; alert at 14/7/1 days left | platform |
| A5 | Rate limits (≈100/s text, 10/s media, 750/h comment replies) exceeded by bursts | L | M | Self-imposed 30 msg/min per connection token bucket; 429 backoff; queue | platform |
| A6 | Message tags deprecated (CONFIRMED_EVENT_UPDATE etc. deprecated 2026-04-27; error 100) | M | M | We use **no** IG tags except optional `human_agent`; tags are configuration, never hard-coded | platform |
| A7 | Meta rule changes without notice (docs unversioned) | M | M | Findings dated (`19_meta_platform_findings.md`) + re-verify at Phase 1 and pre-launch; adapter isolation limits blast radius | platform |
| A8 | Compliance: automated-experience disclosure (California/Germany), opt-outs, policy breach | M | H | Disclosure line in first bot message (configurable locale); no cold outreach possible by design; human review of outbound drafts for pricing | human team |
| A9 | Test-user/role mistakes cause "works for admins, silent for clients" | M | M | Role checklist in runbook + simulator tests independent of Meta roles | ops |

## B. AI quality & cost risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| B1 | Requirements Agent misses a critical field → downstream spec gap | M | H | Completeness engine (statuses, not vibes §10); mandatory categories; auditor's completeness check; human sees field table |
| B2 | Spec Auditor passes a weak spec (false PASS) | M | H | Strong model for auditor; independent provider where possible; coding agent records `specIssues[]`; checker compares build↔spec; humans review at TEAM_REVIEW |
| B3 | Coding agent produces broken/unbuildable code | H | M | Build runner gates every build; 3 fix loops; build failure never reaches TEAM_REVIEW; fixtures in P6 tests |
| B4 | Code Checker false PASS (over-trusting) — the exact failure §25A exists to prevent | M | H | Deterministic evidence required (tests, console/network logs, screenshots); per-requirement `RUNTIME_TESTED/STATIC_ONLY/NOT_VERIFIED`; "cannot run ⇒ FAIL"; never mark PASS without running |
| B5 | Prompt injection via client messages (§38) | M | H | Prompt assembly + delimiters + content-only clause + schema-validated outputs + no agent tools; injection attempts logged for visibility |
| B6 | Hallucinated client requirements presented as confirmed | M | H | 10A rules + DB CHECK constraint (CLIENT_CONFIRMED requires source message id) |
| B7 | LLM cost blowout | M | M | per-agent token caps, daily spend cap, cheap-model routing for requirements, usage dashboard |
| B8 | Model quality/cost drift after provider updates | M | M | Agent configs are versioned rows; runs record model+version; rollback = activate previous config version |
| B9 | Infinite/expensive loops | M | H | All loops capped in DB (`loop_counters`); loop cap tests; watchdog |

## C. Engineering & operations risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| C1 | Postgres-as-queue scaling ceiling | L | M | Fine for internal volume; documented BullMQ/Redis upgrade path isolated in `packages/infra/jobs` |
| C2 | PGlite ≠ Postgres behavioral drift | M | M | **Not mitigated yet** (`AUDIT.md` P1-1/P1-2). The integration suite runs on PGlite only and there is no Postgres driver, so the planned "CI also runs against real Postgres" control does not exist. `npm run schema:drift` covers schema drift only, not query behaviour. Open until P8; no exotic features are used, which limits the exposure |
| C3 | Build/check jobs starve the box (CPU/RAM) | M | M | Caps (1 CPU, 900 MB, 15 min), max concurrency, dedicated coderunner container |
| C4 | Single VPS = single point of failure | M | H | Nightly off-box backups, restore drill, documented RTO<2 h; ops runbook |
| C5 | Version history accidentally overwritten (violates §34) | L | H | Append-only repositories + DB grants; tests assert old versions remain |
| C6 | Locked spec edited silently (§19 violation) | L | H | `status=LOCKED` guard + API rejects; change requests only; tests |
| C7 | Human team bypasses the pipeline (edits DB / sends manually in Instagram app) | M | M | Panel-first runbook; DMs sent from the app won't be in the conversation record — accept + document; "manual send" tasks ask for the message text so history stays complete |
| C8 | Sandbox/dev environment lacks Docker/Postgres/Chromium → "works in dev" illusions | M | M | Environment matrix documented; staging mirrors prod; runtime checks run in staging |
| C9 | Timezone/locale confusion (Tashkent UTC+5, client messages in uz/ru/en) | M | M | Store UTC, display local; locale field per client; translated message templates |

## D. Product/process risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| D1 | Scope creep into SaaS features (§2 forbids) | M | M | Explicit out-of-scope list in every phase report; `org_id` prepared but unused |
| D2 | Design Swap destabilises working backends (§24) | M | M | Phase 8 gated: backend tests must pass after swap; UI/domain separation from P5 |
| D3 | Human review becomes the bottleneck (low-quality AI output → endless fixes) | M | M | Quality bar per phase; checker evidence makes failures visible early; loop caps prevent silent waste |
| D4 | Client approval ambiguity ("ok" ≠ approval) | M | M | Intent classifier with confidence thresholds + clarifying question; approval requires explicit message + ≥0.85 confidence; else human task |

## E. Risk register maintenance

- Review at every phase report; add/remove with a line in `DECISIONS.md`.
- Any risk that materialises becomes an `events(SECURITY_ALERT|SYSTEM_ERROR)` entry + a task when a human must act.
- A1–A5 are re-verified against `19_meta_platform_findings.md` before launch (checklist in `08_instagram_integration.md` §9).

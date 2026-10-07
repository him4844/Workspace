# PHASE 1 REPORT — Instagram Gateway & Conversations

**Phase file:** `docs/phases/01_phase1_instagram_and_conversations.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-07 · **Status:** COMPLETE — **waiting for human approval before Phase 2**

Visible in this report: every claim below is backed by a command you can re-run (real outputs, not plans).
Phase 1 was developed and verified **without Meta access** (D-013 simulator channel); the real-Instagram
checks are blocked only on the Meta app (see §5).

---

## 1. What was built (phase task list, SPEC §31/§31A/§32/§33/§41)

| # | Phase-1 task | Where | Status |
|---|---|---|---|
| 1 | Webhook endpoint with signature verification (`X-Hub-Signature-256`, GET handshake) | `apps/api/src/routes/webhooks.ts`, `packages/channels/src/instagram/verify.ts` | ✅ |
| 2 | Channel-independent Conversation Engine (normalised events, one transaction per inbound) | `packages/channels/src/engine.ts`, `events.ts` | ✅ |
| 3 | Identify/create client → create project → store every message with timestamps | `packages/db/src/repositories/identity.ts`, `engine.ts` | ✅ |
| 4 | Send DM replies through the API (window guard + simulator/Instagram adapters) | `packages/channels/src/instagram/send.ts`, `apps/worker/src/services/outbound.ts` | ✅ |
| 5 | Idempotency: duplicate delivery creates nothing new | `webhook_events` unique index + `messages(conversation_id, channel_message_id)` + job idempotency keys | ✅ |
| 6 | Track last client message time per conversation (window warning data) | `conversations.last_client_message_at`, `window_expires_at`, `packages/core/src/window.ts` | ✅ |
| 7 | Explicit state machine, initial `NEW → INTAKE` (T01/T02) | `packages/core/src/state-machine/transitions.ts` (33 transitions), `projects.ts` audit table | ✅ |
| 8 | Central logging + agent-run log table (no AI yet) | `packages/infra/src/logger.ts` (pino), `agent_runs` + `events` tables, `observability.ts` | ✅ |
| + | Postgres-backed job queue + orchestrator (claim/lease/backoff/dead-letter/park) | `packages/db/src/repositories/queue.ts`, `apps/worker/src/orchestrator.ts` | ✅ |
| + | Human inspection path while the Team Panel does not exist | `npm run inspect` (CLI) + `/api/v1/*` inspector API (`X-Internal-Token`) | ✅ |
| + | Phase-1 tests: unit, integration, HTTP, end-to-end | `tests/` (5 files, 50 tests) | ✅ |

**Acceptance checks from the phase file**

| Acceptance check | Result |
|---|---|
| A test client sends a message and receives an automatic echo reply | ✅ proven twice: `npm run simulate` (§3.2) and a live HTTP round-trip against the running API (§3.3) |
| Two different test clients never see each other's conversation | ✅ `ingest.test.ts` "keeps two clients completely separate" + simulate §1 (two projects, two conversations) |
| Duplicate webhook test passes | ✅ 3 levels: message level, webhook-event level (HTTP), and raw `webhook_events` level |
| Messages and projects persisted | ✅ `npm run inspect` / `/api/v1/projects`, `/api/v1/messages` |
| Human can inspect stored conversations | ✅ `npm run inspect`, `/api/v1/conversations/:id/messages`, `/dev/simulator/outbox` |

---

## 2. Headline decisions made in Phase 1 (details in `DECISIONS.md`)

- **D-022 — PGlite is single-process: dev runs the orchestrator inside the API process.** Found the hard way:
  with a standalone worker process against the same `.pglite` dir the worker never saw the job the API inserted
  (a long-running PGlite process holds a snapshot), and a third process aborts on open. `EMBEDDED_WORKER` is now
  forced on for `DB_DRIVER=pglite`; Postgres (server) keeps two real processes/containers. `scripts/dev.ts`
  follows the same rule automatically.
- **D-023 — Outbound messages without `project_id` are attached to the conversation's open project** inside the
  outbound service, so §31A blocked-send escalations are always visible on the project.
- **D-024 — `jobs_idem_uq` is a plain unique index.** A partial index cannot be inferred by
  `ON CONFLICT (idempotency_key)`, which made every real enqueue fail until fixed.
- State-machine corrections found by tests: `T30` (any → BLOCKED) accepts a reason from either `opts.reason` or
  `context.reason`; `ECHO_REPLY` (the Phase-1 placeholder for the requirements turn) is allowed in
  `REQUIREMENTS_IN_PROGRESS` so a parked echo job is released when a blocked project resumes (T31).

---

## 3. How it was verified (real results, 2026-10-07)

### 3.1 `npm run verify` — typecheck + full test suite + docs check

```
Test Files  5 passed (5)
     Tests  50 passed (50)          # 54s
OK: 23 docs present, contracts valid JSON
```

Unit (24): all 33 transitions × 23 states disallow sweep, guard tests T02/T05/T06/T10/T13/T15/T16/T17/T21/T26/T27/T31/T33,
HMAC accept/reject/tamper, handshake, 24 h boundary exclusivity, human-agent window.
Integration (17): first contact creates client+conversation+project+job, replay idempotency, cross-client isolation,
project reuse, window timestamp, T01/T02 audit trail, webhook-event dedupe, attachments, message count;
HTTP: signed 200→INTAKE, unsigned/wrong-secret 403 + `SECURITY_ALERT`, duplicate → `duplicates: 1`, batch → 2 projects.
End-to-end (5): worker answers two clients, one reply per turn, no double-send on retry, out-of-window →
`SEND_BLOCKED` + `MANUAL_SEND` task, parked job released after the state resumes.

### 3.2 `npm run simulate` (self-contained in-memory demo)

```
=== 1. Two clients send messages ===
client A → project … state=INTAKE (created client=true, project=true)
client B → project … state=INTAKE (created client=true, project=true)
different conversations: true
=== 2. Duplicate webhook replay ===
first delivery duplicate=false, replay duplicate=true (expected false then true)
messages for client A: 1 → 2 after the replay (expected +1 then +0)
=== 3. Worker processes the queue (echo reply through the window guard) ===
jobs before: [{"status":"PENDING","n":3}] | tick: {"processed":3,"parked":0,"failed":0,"empty":true}
  << [RECEIVED] Salom! Restoranim uchun sayt kerak
  >> [SENT] Assalomu alaykum! Xabaringiz uchun rahmat — tez orada savollaringizni beraman. (WPP intake)
=== 4. Window guard: an expired 24h window blocks the send ===
message status: SEND_BLOCKED (expected SEND_BLOCKED)
human tasks created: 1 → MANUAL_SEND
=== 5. State machine history ===
…: T01(NEW→NEW) → T02(NEW→INTAKE)
=== 6. Final database summary ===
projects=2 conversations=2 | jobs=[{"status":"DONE","n":4}] | agent runs recorded: 3
```

### 3.3 Live HTTP round-trip (real server, real DB file, real worker)

```
$ curl -X POST /dev/simulator/inbound -d '{"senderId":"igsid_live_demo2","text":"…onlayn do‘kon kerak","mid":"live_mid_002"}'
{"ok":true,"data":{"duplicate":false,"clientCreated":true,"projectCreated":true,…,"projectState":"INTAKE"}}
$ curl /dev/simulator/outbox      → {"count":2,"messages":[… "status":"SENT", "text":"Assalomu alaykum!… (WPP intake)" …]}
$ curl /dev/simulator/stats       → jobs DONE 2; window_expires_at = client message + 24h; pendingOutbound 0
$ curl /api/v1/projects (token)   → 2 projects, state INTAKE
$ curl /api/v1/projects (no token) → 401
```

### 3.4 Commands you can re-run

```bash
npm run migrate     # applies db/migrations/0001_init.sql to .pglite
npm run seed        # org + admin + simulator connection + 11 config values
npm run dev         # API :3000 with embedded worker (pglite) — or API+worker (postgres)
npm run simulate    # the acceptance demo above (in-memory, safe to repeat)
npm run inspect     # human-readable dump: projects, jobs, conversations, messages, timeline
npm run verify      # typecheck + tests + docs integrity
```

---

## 4. Incomplete / risky

1. **Real Instagram send/receive is untested against Meta.** Everything above runs on the simulator channel,
   which pushes the *same* payload shape through the *same* parser and ingestion path as the webhook.
   The Graph call itself (`POST /<IG_ID>/messages`) needs a live token; the adapter is written per the
   documented contract (docs/19) but cannot be exercised here (no Meta app, no network egress guarantee).
2. **Token lifecycle is not automated yet.** Long-lived token refresh (`ig_refresh_token`) and the 24 h/7 day
   window bookkeeping exist as data and window math; the `TOKEN_REFRESH` job is a not-implemented stub
   (planned with Phase 8 hardening).
3. **Attachment media is stored as metadata only** — no media download/re-hosting (deliberate: hosting policy
   belongs with the panel/storage design, Phase 7+).
4. **`ECHO_REPLY` is a placeholder.** It answers with `ECHO_REPLY_TEMPLATE`; the real requirements turn (§9)
   arrives in Phase 2. The scheduler job table and the guard rails (state gating, parking, human tasks) are
   already the production ones, so Phase 2 swaps the handler, not the plumbing.
5. **Rate limiting is structural, not enforced.** `SEND_RATE_PER_MINUTE` is config; a token-bucket enforcement
   point exists in the outbound path design but is not wired until a second channel/agent makes it matter.
6. **Single-VPS assumptions.** PGlite for dev; PostgreSQL + separate worker containers are documented
   (docs/15) but not yet run — no Docker in this sandbox.
7. **Behavioural gap worth knowing:** a conversation can legitimately collect several inbound messages before the
   worker answers (the simulate §2 replay shows one reply per *turn*); this is the intended §21/§26 loop-safety
   behaviour, not a bug — the phase-2 turn handler will merge rapid messages.

---

## 5. Open questions (need a human answer)

1. **Instagram route for the Meta submission (still open from Phase 0, Q3).** Instagram-Login (no Facebook Page,
   `graph.instagram.com`) vs Facebook-Login (linked Page, `graph.facebook.com`). Phase 1 code targets the
   Instagram-Login route; switching later is an adapter/config change, but the App Review submission differs.
2. **Human-agent tag (§31A).** `HUMAN_AGENT_TAG_ENABLED=false` by default. Turning it on changes *who* may send
   inside the 7-day window (human replies only, and price/deadline messages may only go out this way). Confirm the
   default stays off until the team actually answers DMs manually.
3. **Test Instagram account** (needed for the first real end-to-end test): do we have one, and does it have the
   `instagram_business_manage_messages` permission assigned?
4. **Project naming.** Projects created from DMs currently have `name = NULL` and `type = UNKNOWN` until the
   requirements turn asks the client. Fine to keep until Phase 2?

---

## 6. Proposed next step

**Phase 2 — Requirements Agent (`docs/phases/02_*.md`):** replace the echo placeholder with the real
requirements turn: questionnaire-as-data (§50–51), one question per turn, structured JSON output (§49),
completeness tracking, `REQUIREMENTS_IN_PROGRESS → REQUIREMENTS_COMPLETE`, loop cap
`LOOP_REQUIREMENTS_MAX_QUESTIONS`, and the same human-inspection path (`npm run inspect`).

Blocked-only-on-you items for Phase 2: an **LLM provider key** (mixed providers were approved; the auditor must
run on a *different* provider) and the **budget cap** value (Phase 0 default: $10/day).

**Awaiting your explicit approval to start Phase 2.**

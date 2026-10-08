# Deliverable 7 — API Structure

**Status:** Phase 0 design. Source: SPEC §27–§32, §39, §49. Style: REST + JSON, Zod-validated, OpenAPI generated.

## 1. Conventions

- Base path `/api/v1` (except webhooks and previews). Version in path; breaking changes bump `v2`.
- Auth: **session cookie** (`HttpOnly`, `Secure`, `SameSite=Lax`, rotating) for the Team Panel; **HMAC-signed internal token** (`X-Internal-Token`) for worker/coderunner → api calls; webhooks use Meta's `X-Hub-Signature-256`.
- All responses use an envelope:
  ```json
  { "ok": true, "data": { ... }, "meta": { "requestId": "..." } }
  { "ok": false, "error": { "code": "SPEC_IS_LOCKED", "message": "...", "details": {} } }
  ```
  Error codes are machine-readable and stable; UI maps them to human text.
- Pagination: `?limit=&cursor=` (opaque cursor = `(created_at,id)`); default 25, max 100.
- Idempotency: write endpoints that can be retried accept `Idempotency-Key`; server stores it in `idempotency_keys`.
- Concurrency: PATCH endpoints accept `If-Match: <updated_at ISO>` (optimistic locking) → 409 on conflict.
- Every state-changing human action writes a `team_actions` row and an `events` row.
- Rate limits: global 300 req/min/IP; auth endpoints 10/min/IP; message-send 30/min (protects the Instagram quota, §31A).

## 2. Endpoint map

### 2.1 Webhooks (no session auth; signature-verified)

| Method | Path | Purpose |
|---|---|---|
| GET | `/webhooks/instagram` | Meta verification handshake (`hub.mode=subscribe`) → echo `hub.challenge` with `hub.verify_token` check |
| POST | `/webhooks/instagram` | inbound events; verify `X-Hub-Signature-256` (HMAC-SHA256, raw body), dedupe by event id, persist raw, ack 200 fast, enqueue jobs |
| GET/POST | `/webhooks/:channel/:connectionId` | reserved for future channels (§31) |

### 2.2 Auth & users

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | email+password (argon2id), rate-limited, sets session cookie |
| POST | `/auth/logout` | revokes session |
| GET | `/auth/me` | current member + role |
| POST | `/auth/mfa/verify` | TOTP (optional per member, Phase 7) |
| GET/POST/PATCH | `/members` | ADMIN only: list/invite/update (no public registration, §2) |

### 2.3 Projects (the hub)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | filters: `state`, `clientId`, `assignee`, `q`, `sort` (dashboard §28) |
| GET | `/projects/:id` | the "10 questions" payload (§48): state, active agent, last success/failure, retries, open tasks, counts |
| PATCH | `/projects/:id` | name, assignee, notes (never `state` — see transition endpoint) |
| POST | `/projects/:id/transitions` | **human-initiated transitions only** (T23, T25, T26, T27, T28, T29, T30, T31, T33); body `{transitionId, reason?, payload?}`; validated against `05_state_machine.md` |
| GET | `/projects/:id/timeline` | `events` + `project_state_transitions` merged, paginated |
| GET | `/projects/:id/observability` | §39: current state, active agent, last ok/failed agent, retry counts, unresolved issues |
| GET | `/projects/:id/artifacts` | artifacts list with kind filter |
| GET | `/projects/:id/export` | zip of the §45 logical structure (team-only) |

### 2.4 Clients & conversations

| Method | Path | Notes |
|---|---|---|
| GET | `/clients`, `/clients/:id` | client + identities + projects |
| GET | `/conversations` | filter by project/client/status/window |
| GET | `/conversations/:id/messages` | paginated; includes drafts |
| POST | `/conversations/:id/messages` | send as team member; **window guard**: outside window → `409 SEND_WINDOW_CLOSED` + suggestion (HUMAN_AGENT tag if eligible / other channel), creates fallback task (§31A) |
| POST | `/conversations/:id/drafts` | create a draft (AI or human); `POST /drafts/:id/send` sends after human confirmation (§30) |
| POST | `/conversations/:id/handover` | pause AI handling; `POST /handover/release` resume |

### 2.5 Requirements

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/requirements` | current version: fields, statuses, completeness, contradictions |
| GET | `/projects/:id/requirements/versions` | version chain (§34) |
| PATCH | `/projects/:id/requirements/fields/:fieldPath` | human override; requires `reason` + records `field_status_history` with `actor=HUMAN`; cannot set `CLIENT_CONFIRMED` without message ref (§10A) |
| POST | `/projects/:id/requirements/recompute` | re-run completeness engine (after overrides) |
| GET | `/questionnaires` | list schemas/packages; POST to add a package (config-as-data, §7) |

### 2.6 Specifications, summaries, approvals, audits

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/specs` | versions + status (DRAFT/LOCKED/SUPERSEDED) |
| GET | `/specs/:id` | structured JSON; `?format=md` for the rendered document |
| POST | `/projects/:id/specs/:id/lock` | LEAD/ADMIN; only after `client_approvals(APPROVED)` exists |
| POST | `/projects/:id/specs/:id/revisions` | creates a Change Request instead of editing a locked spec (§35) |
| GET | `/projects/:id/client-summaries` | summaries per spec version |
| POST | `/projects/:id/approvals` | record approval/changes-requested **with `messageId`** (normally automatic from webhook) |
| GET | `/projects/:id/audits` | spec audits with findings |
| POST | `/projects/:id/audits` | trigger audit run (LEAD) |
| GET | `/projects/:id/change-requests` | list; POST to create; PATCH `status` transitions |

### 2.7 Builds, previews, checks

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/builds` | versions, statuses, preview URLs, logs refs |
| POST | `/projects/:id/builds` | start build from locked spec (T16); optional `{instructions}` for revision builds |
| GET | `/builds/:id` | status + metadata + `buildSucceeded` |
| GET | `/builds/:id/logs` | `?stream=&since=` (SSE stream variant `?follow=1`) |
| GET | `/preview/:buildId/*` | static preview of a built site (served by api/Caddy; isolated path, no cookies) |
| POST | `/builds/:id/design-swap` | Phase 8: upload Stitch export (`multipart`) → new build with replaced UI layer (§24) |
| GET | `/projects/:id/code-checks` | check runs with per-requirement verification table (§25A) |
| POST | `/projects/:id/code-checks` | trigger check (LEAD) |
| GET | `/code-checks/:id/evidence/:artifactId` | screenshots, traces, logs |

### 2.8 Tasks, comments, assistant

| Method | Path | Notes |
|---|---|---|
| GET | `/tasks` | filters: status, project, assignee, type, priority |
| POST | `/tasks`, PATCH `/tasks/:id` | create/update; status transitions validated |
| POST | `/tasks/:id/comments` | comment |
| GET/POST | `/projects/:id/comments` | project comments |
| POST | `/projects/:id/assistant/summarize` | Team Assistant: project summary |
| POST | `/projects/:id/assistant/explain-failure` | explain failed audit/check in plain language |
| POST | `/projects/:id/assistant/estimate` | complexity estimate (§30, informational) |
| POST | `/projects/:id/assistant/price-draft` | draft Instagram price/deadline message → returns **draft**, never sends (§30) |
| POST | `/projects/:id/assistant/stitch-prompt` | generate Google Stitch prompt, tagged to current spec version (§44) |

### 2.9 Agents & orchestration (internal / ADMIN)

| Method | Path | Notes |
|---|---|---|
| GET | `/agents` | agent configs + versions |
| POST | `/agents/:id/versions` | publish new config version (prompt/model/schema) |
| POST | `/agents/:id/versions/:v/activate` | activate/rollback |
| GET | `/agent-runs` | filter by project/agent/status; includes usage/cost |
| POST | `/agent-runs/:id/retry` | enqueue a retry with a new run |
| GET | `/jobs` | queue inspection: status, attempts, dead letters |
| POST | `/jobs/:id/retry`, `/jobs/:id/cancel` | ADMIN |
| GET | `/usage` | LLM cost per project/agent/month (§36) |

### 2.10 Dev-only (disabled unless `CHANNEL_SIMULATOR_ENABLED=true`)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | human dev console (HTML) for the simulator channel — chat view + live project/requirements state (**implemented**, D-027) |
| POST | `/dev/simulator/inbound` | inject a client DM as if from Instagram; goes through the *same* parser + ingestion path as the webhook (**implemented**) |
| GET | `/dev/simulator/outbox` | messages the system "sent", optional `?conversationId=` (**implemented**) |
| GET | `/dev/simulator/stats` | queue stats, conversation overview and the active `LLM_PROVIDER` (**implemented**) |
| GET | `/dev/simulator/project/:id` | project card for the console: state, completeness, fields, contradictions, open tasks, summary (**implemented**) |
| GET | `/dev/simulator/lookup?senderId=` | resolve a demo sender to conversation + project + messages (**implemented**, console reload) |
| POST | `/dev/simulator/:connectionId/inbound` … | earlier drafts of the same endpoints; the connection is resolved from the channel, so no id is required |
| POST | `/dev/simulator/clock` | advance simulated time (tests the 24h window & inactivity jobs deterministically) — *not implemented*; tests pull future-dated jobs forward instead |
| POST | `/dev/webhooks/instagram/replay` | replay a captured Meta payload with a valid signature — *not implemented* |

### 2.10.1 Inspection API implemented so far (Phase 1–2, `X-Internal-Token`)

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | liveness (no DB) / readiness (DB + migrations + queue) |
| GET | `/api/v1/projects` | project list (state, type, client, conversation) |
| GET | `/api/v1/projects/:id` | project + conversation/window (`hoursLeft`) + transitions + event timeline + open tasks |
| GET | `/api/v1/projects/:id/requirements` | version (incl. `completeness`, `pendingFieldPath`, `vision`), every field with its §10A status, contradictions, summary artifact markdown |
| GET | `/api/v1/conversations/:id/messages` | full message page (audit order) |
| GET | `/api/v1/messages`, `/api/v1/jobs`, `/api/v1/agent-runs` | operational views for humans before the panel exists |
| POST | `/api/v1/conversations/:id/send` | internal human/dev send (window guard + §31A escalation still apply) |

### 2.11 Health & ops

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | liveness (no DB) |
| GET | `/readyz` | readiness (DB + migrations + queue) |
| GET | `/metrics` | Prometheus text (Phase 7 optional) |

## 3. Webhook processing contract

1. Read **raw body** (no JSON body parser before signature check).
2. Verify `X-Hub-Signature-256` = `sha256=<hmac>` with app secret; invalid → `403`, log `SECURITY_ALERT` (§37).
3. Insert into `webhook_events` (`UNIQUE(channel, external_event_id)`); duplicate → 200 `{ok:true}` and `WEBHOOK_DUPLICATE` event, no further work (§41).
4. Respond **200 within ~300 ms**; all work is enqueued.
5. Never let tenant-specific state affect the response body (no data leakage).

## 4. Panel integration

The Next.js panel talks to the API **server-side** (server components/actions) with the member's session cookie forwarded; no CORS needed, no token in the browser. Panel routes mirror the API 1:1 (`/projects/[id]`, `/projects/[id]/requirements`, …). Browser-side polling is limited to a small set of live views (build logs via SSE, task badge counts).

## 5. OpenAPI

Generated from the same Zod schemas used for validation (`fastify-type-provider-zod` → `@fastify/swagger`). CI publishes `docs/openapi.json` as an artifact and fails on breaking changes to `v1` (schema diff check). The panel's API client is generated from it from Phase 7.

# Deliverable 11 — Security Architecture

**Status:** Phase 0 design. Source: SPEC §37, §38, §40, §42, §10A (trust rules), §31A (platform).

## 1. Threat model (what we are actually defending)

| Asset | Threat | Impact |
|---|---|---|
| Instagram account access (tokens) | theft/leak → impersonation, DMs to clients | critical |
| Client PII in conversations | unauthorized access, over-sharing indoors | high |
| Approved specifications & price data | tampering, silent modification (§19, §34) | high |
| Generated code / build environment | malicious code from LLM or client content executing on the host | critical |
| LLM keys / provider accounts | abuse → cost blowout | high |
| Webhook endpoint | spoofed events/DoS | medium |
| Panel | account takeover, privilege escalation | high |

Non-goals for MVP: tenant isolation (single org now, `org_id` prepared), DDoS-grade edge protection, SOC2 paperwork.

## 2. Secrets management (§37)

- **Never hard-coded.** `.env` files are git-ignored; `.env.example` documents every key (`12_environment_variables.md`).
- Prod: Docker secrets / systemd `EnvironmentFile` with `0600`; optional Vault/SOPS later.
- Rotation: app secret, LLM keys, DB password, `TOKEN_ENCRYPTION_KEY` — documented rotation runbook; `TOKEN_ENCRYPTION_KEY` rotation re-encrypts `channel_connections` in one maintenance job.
- Secrets never enter: logs, `agent_runs.input_summary`, artifacts, prompt payloads, error messages sent to clients. A redaction filter runs on all log fields and on any LLM input containing project data.
- CI: no secrets in GitHub Actions; prod deploy uses a deploy key scoped to the repo.

## 3. Instagram/Meta-specific controls

| Control | Implementation |
|---|---|
| Webhook authenticity | `X-Hub-Signature-256` HMAC-SHA256 over raw body, constant-time compare; invalid → 403 + alert (§31A(5)) |
| Replay/duplicate | `webhook_events` unique index; idempotency keys on jobs (§41) |
| Token at rest | AES-256-GCM with `TOKEN_ENCRYPTION_KEY`; scopes/expiry tracked; daily refresh job with alert; `NEEDS_REAUTH` banner |
| Token in transit | TLS only; token never in URLs logged by proxies (use POST bodies for token exchange) |
| Rate-limit safety | per-connection token bucket + platform-side 30 msg/min cap; 429 backoff; never retry window-violation errors |
| Least privilege | app asks only `instagram_business_basic` + `instagram_business_manage_messages` (+ Human Agent feature only if needed) |
| Auditability | every outbound message row (incl. drafts, sent-by, human_agent flag) is immutable and visible in the panel |

## 4. Panel & API security

| Area | Control |
|---|---|
| AuthN | email+password (Argon2id, per-user salt, min 12 chars policy), optional TOTP; sessions = opaque random 256-bit ids, `HttpOnly; Secure; SameSite=Lax`, 12 h idle / 30 d absolute, rotated on login and privilege change |
| AuthZ | RBAC middleware (`VIEWER/MEMBER/LEAD/ADMIN`) on every route; row-level checks (member assigned or LEAD/ADMIN) where relevant; **deny by default** |
| CSRF | SameSite cookies + double-submit token on state-changing panel actions; API requires `X-Requested-With` for cookie-auth mutations |
| Rate limiting | global 300/min/IP; login 10/min/IP + exponential lockout; send 30/min/connection |
| Input validation | Zod schemas on every route (fastify-type-provider-zod); unknown fields rejected; body size caps; upload MIME+size validation |
| Injection | parameterized SQL only (Drizzle); no shell interpolation — build commands run from a fixed allowlist with array argv, never `sh -c` on user content |
| SSRF | URL fetching (link crawler, media) goes through an allowlist proxy with private-IP blocking |
| File paths | artifact paths are server-generated IDs; any user-supplied path is rejected (no traversal) |
| Headers | helmet defaults + strict CSP on the panel (no inline scripts beyond nonces), HSTS, `X-Frame-Options: DENY` for the panel; previews served from a separate path with `sandbox` CSP and no cookies |
| Audit | `team_actions` + `events` for every mutation; append-only grants on history tables (§34) |

## 5. LLM-specific security

| Risk | Control |
|---|---|
| **Prompt injection** (§38) | Fixed prompt assembly order; client text only inside the delimited DATA block; system instructions never contain project data; output schema validation rejects any response that isn't the expected shape; agents have **no tools** except explicitly enabled ones (none that can move money/send messages) |
| Data exfiltration via prompt | Agents never receive secrets or tokens; only spec-level project data; provider data-retention setting chosen deliberately (see open questions) |
| Hallucinated actions | Agents cannot perform state transitions (§4 of agent doc); the only side-effect channel is the orchestrator's typed effect list |
| Cost abuse | per-agent token caps, daily spend cap in `config_values`, alerts at 80% |
| Model/provider outage | retry policy + provider fallback config per agent |

## 6. Generated-code sandbox

The coding agent's output is **untrusted code**:

1. Builds run in the `coderunner` container as a non-root user with **no secrets mounted** (no DB creds, no tokens) — it only gets the spec and the workspace.
2. Resource caps per job: 1 CPU, 900 MB RAM, 15 min wall clock, no network beyond npm registry allowlist during install (configurable; some sites need external APIs — then allowlisted hostnames only).
3. The process is killed on cap breach; logs preserved.
4. Previews are served as static files with a restrictive CSP, `X-Frame-Options: SAMEORIGIN`, no API cookies, and a separate cookie-less origin/path.
5. `npm audit`, secret scanning and route-protection probes run as part of the code check (§25A.6).
6. Phase 8 option: run coderunner jobs in per-build containers (or gVisor) if the team starts building higher-risk sites.

## 7. Data protection

- PII minimization: conversations stored because they are the requirements record; no extra fields beyond what the project needs.
- Retention: versions are kept (business requirement §34); PII redaction on request is an explicit human operation with audit trail. Retention policy parameters are an open question (`17_open_questions.md` Q12).
- Backups are encrypted at rest; restore tested quarterly (drill in `15_deployment_strategy.md`).
- Access: only team members with accounts; VIEWER role for non-technical staff where possible.
- Client data is never sent to third parties other than the chosen LLM provider (documented in an internal DPIA note), never to analytics services.

## 8. Security requirements from SPEC §58 scenario (§25A.6 in the checker)

The Code Checker's basic security pass on *generated* sites checks: dependency vulnerabilities, exposed secrets, unprotected routes, missing auth on admin paths. Critical issues found there → `CODE_AUDIT → BLOCKED` immediately (T21, §42) — automation stops and a human takes over.

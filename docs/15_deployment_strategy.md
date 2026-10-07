# Deliverable 16 — Deployment Strategy

**Status:** Phase 0 design. Internal tool, single team (§2): optimize for **simplicity, recovery and auditability**, not scale.

## 1. Target environment

| Item | Choice | Notes |
|---|---|---|
| Host | 1 Linux VPS (Ubuntu 24.04 LTS), 4 vCPU / 8 GB / 160 GB NVMe | Hetzner-class ~€18/mo or a local/UZ provider; static IP |
| Container runtime | Docker + Docker Compose | matches dev; no Kubernetes |
| Reverse proxy | Caddy | automatic TLS (Let's Encrypt), `/` → panel, `/api` → api, `/webhooks` → api |
| Processes | `api`, `worker`, `coderunner`, `panel`, `postgres`, `caddy` | 6 compose services |
| Backups | nightly `pg_dump` + artifact rsync → off-box object storage; 30-day retention | script in `infra/scripts/backup.sh` |
| Monitoring | `/healthz`, `/readyz`, pino logs to journald; optional uptime pinger + alert webhook | no Prometheus in MVP |
| Domain | `panel.<domain>` (or `/`), `api.<domain>` optional | webhook URL must be stable: `https://<domain>/webhooks/instagram` |

**Sandbox/dev note:** the current dev workspace has no Docker/Postgres/Redis/Chromium. Local dev therefore runs with `DB_DRIVER=pglite` and the simulator channel; production-parity checks (real Postgres, real Chromium, real builds) run in CI and on the VPS. This is a deliberate, documented trade-off — not a claim that PGlite == Postgres.

## 2. Environments

| Env | Purpose | Data | Instagram | LLM |
|---|---|---|---|---|
| `local` | development | disposable | simulator | fake or real (dev keys) |
| `ci` | automated verification | ephemeral | simulator + signed replays | fake |
| `staging` | pre-production acceptance (phase reports, §58 scenario dry-run) | copy-free, real-ish | Meta app in dev mode + test IG account (Standard Access) | real, cheap models |
| `prod` | internal production | real | live IG account (Advanced Access) | real, per-agent configs |

Rule: the SPEC §58 acceptance scenario runs in `staging` with the test IG account before `prod` go-live.

## 3. Build, release, rollback

```
git tag vX.Y.Z  → CI (verify) → build images → push to registry (or local registry)
→ on VPS: docker compose pull && docker compose up -d --no-deps api worker coderunner panel
→ migrate: docker compose run --rm api npm run migrate   (forward-only, idempotent)
→ smoke: /healthz, /readyz, a simulator conversation turn
→ if smoke fails: docker compose rollback to previous image tags (documented per release)
```

- **Migrations are forward-only**; destructive changes require a two-step deploy (add → backfill → switch → drop later). No down-migrations in prod.
- **Zero-drama rule:** deploy during working hours; a broken deploy pauses the orchestrator (workers stopped first: `docker compose stop worker coderunner`, then api/panel, then reverse).
- **Feature flags** in `config_values` for risky switches (e.g. `HUMAN_AGENT_TAG_ENABLED`).

## 4. Backups & restore

| What | How | Frequency | Retention |
|---|---|---|---|
| Postgres | `pg_dump -Fc` → off-box | nightly | 30 daily + 6 monthly |
| Artifacts (`data/`) | `rsync` incremental / object storage sync | nightly | 30 days; builds are reproducible |
| Secrets | not backed up in plaintext; stored in the team's password manager | on change | — |

**Restore drill (quarterly, documented + timed):**
1. provision fresh Postgres container → `pg_restore`
2. restore artifacts
3. boot api/worker with prod env → `/readyz` green
4. verify: latest 10 projects open in the panel with intact versions and state history
5. record RTO in `PHASE_REPORTS/ops-restore-drill.md`

## 5. Operations runbook (first entries)

| Situation | Action |
|---|---|
| Worker stuck / queue backing up | check `/queue` panel; inspect leases; `POST /jobs/:id/retry`; restart `worker` container |
| LLM provider down | check per-agent config; activate fallback model version; jobs retry automatically |
| Instagram token expired | panel banner + task; reconnect via `/integrations/instagram`; verify webhook health |
| Dead-lettered jobs | inspect payload + error; fix root cause; retry; if data issue → manual corrective transition (audited) |
| Project BLOCKED | open the task, read findings, decide: fix inputs → T31 resolve; or manual development |
| Disk > 80% | prune old workspace tarballs (keep `data/projects/*` artifacts); adjust retention |
| Suspected token compromise | rotate `TOKEN_ENCRYPTION_KEY`, re-auth IG connection, rotate app secret, review `events` for anomalies |

## 6. Cost & capacity plan

| Resource | Baseline | Peak | Guard |
|---|---|---|---|
| CPU | api+worker ~0.5 core idle | build/check bursts (1 core each) | `BUILD_MAX_CONCURRENCY`, `CHECK` caps |
| RAM | ~1.5 GB total idle | +900 MB per build job | caps + queue |
| Disk | 20–40 GB usable (Postgres + workspaces) | prune workspaces after N builds (config) | nightly `df` check + alert |
| LLM | see `18_stack_proposal.md` §2.3 | daily cap `LLM_DAILY_SPEND_CAP_USD` | alert at 80% |

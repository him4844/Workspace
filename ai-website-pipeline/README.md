# AI-Powered Website Production Pipeline (WPP)

Internal production pipeline that turns Instagram DM conversations into delivered websites:
**client DM → Requirements Agent → Specification → one client approval → Spec Auditor → Coding Agent → Code Checker (runtime) → Team Panel → human team → price/deadline → delivery.**

It is an **internal tool**, not a SaaS (§2 of SPEC). One team, one primary Instagram business account, many concurrent projects.

## Authoritative documents

| File | What it is |
|---|---|
| `SPEC.md` | The master specification (v2) — authoritative reference (§55A.1) |
| `docs/00…19` | Phase 0 deliverables: architecture, DB, state machine, agents, API, Instagram, panel, security, folder structure, env vars, MVP plan, testing, deployment, risks, open questions, stack proposal, Meta findings |
| `docs/contracts/*.json` | Agent input/output JSON Schemas (§49) |
| `docs/phases/` | The per-phase working instructions + COMMON_RULES (§46) |
| `DECISIONS.md` | Running architectural decision log (§55A.7) |
| `PHASE_REPORTS/` | One report per phase, produced at each stop-and-approve gate |

## Status

**Phases 0–4 are built and verified. Phases 5–8 are not started.**

| Phase | Scope | State |
|---|---|---|
| P0 | Architecture & stack, 18 deliverables, agent I/O contracts | ✅ `PHASE_REPORTS/phase0.md` |
| P1 | Instagram gateway, conversations, state machine, job queue, simulator channel | ✅ `PHASE_REPORTS/phase1.md` |
| P2 | Requirements Agent — questionnaire-as-data, structured requirements, completeness engine | ✅ `PHASE_REPORTS/phase2.md` |
| P3 | Specification Agent, client summary, two-step approval | ✅ `PHASE_REPORTS/phase3.md` |
| P4 | Spec Auditor, §21 audit loop, vendor-separated free route | ✅ `PHASE_REPORTS/phase4.md` |
| P5 | Coding Agent (`BUILD_RUN`) | ❌ handler is `notImplemented` |
| P6 | Code Checker (`CODE_CHECK`) | ❌ handler is `notImplemented` |
| P7 | Team Panel (`apps/panel`), sessions, RBAC | ❌ README only |
| P8 | Deploy & ops (`apps/coderunner`, Postgres, backups, `TOKEN_REFRESH`) | ❌ README only |

Verify a clean checkout exactly as CI does:

```bash
npm ci
npm run verify   # docs integrity → schema drift → typecheck → 31 files / 270 tests
```

**`AUDIT.md` is an independent deep analysis and audit of P0–P4** — every tracked file read, every
reported claim re-executed, findings with `file:line` evidence and a prioritised remediation plan.
Every **P0, P1 and P2** finding it raised is fixed on this branch, each behind a test:

- **P0-1** Uzbek negation was read as approval (`Tasdiqlamayman` → APPROVE 0.95). Negation markers now
  veto the local fast path *and* an agent APPROVE. See `packages/core/src/spec/intent.ts`.
- **P1-1** `DB_DRIVER=postgres` silently opened an embedded PGlite database. It now fails fast with
  `DB_DRIVER_UNSUPPORTED` — there is still no Postgres driver.
- **P1-2** CI ran only the docs check. It now runs the whole `verify` pipeline on Node 20 and 22.
- **P1-3** `.env.example` had drifted (11 read vars undocumented, 42 documented vars read by nothing,
  one wrong name). It is now exact, and `tests/unit/config-env-parity.test.ts` keeps it that way.
- **P1-4** The agent error-code enum drifted between runtime, Zod and the JSON contract.
  `AgentErrorCode` is now derived from one list, and `tests/unit/contract-parity.test.ts` guards it.

- **P2-1/P2-2** Three route modules each registered their own root-level auth hook, the internal
  token was compared with `!==`, and `/dev/simulator/*` was gated only by a flag that defaults to
  `true`. One guard module now owns all of it, compares in constant time, and requires a loopback peer.
- **P2-3** `WATCHDOG` had no handler, so such a job dead-lettered and blocked its project. `HANDLERS`
  is now a total `Record<JobType, JobHandler>` — the next omission is a compile error.
- **P2-4** `estimateTokens` assumed 4 chars/token for every script. It is now script-aware
  (Latin 4, Cyrillic 2, CJK 1.5) and never more permissive than before.
- **P2-5** `docs/08`, `docs/10` and `docs/16 A5` called the send limiter a "token bucket"; it is a
  fixed 60-second window. The docs now say so, the boundary burst is pinned by a test, and the
  function can no longer be called from inside a transaction.
- **P2-6/P2-7** The unreachable `LLM_QUOTA_EXHAUSTED` branch is gone, and so are six `eslint-disable`
  comments that silenced a linter which is not installed.

## Next steps

1. Install ESLint + Prettier and the `docs/14 §7` boundary check, so the lint stage the docs promise
   actually exists (`AUDIT.md` P2-7).
2. Decide the generated-site stack — AUDIT.md §8D recommends static HTML/CSS/vanilla JS, so the P6
   checker needs no build step and the free-tier token budget survives.
3. Then P5 — Coding Agent (`docs/phases/05_*`), with a real Postgres driver if it is to run outside
   one process.
4. Still open from the audit: the envelope-shape gap recorded in D-067, and P3-2/P3-3/P3-5 (a
   self-contradicting evidence file, scripted-persona warnings and demo artifacts) — all three are
   left alone deliberately, for the reasons given in `AUDIT.md` §0A.

## How the finished system will run (target, from `docs/15_deployment_strategy.md`)

```bash
# dev (works without Docker/Postgres/Chromium — uses PGlite + simulator channel)
npm run dev            # api + worker
npm run seed           # admin user, questionnaires, agent configs
npm run simulate       # drive a full restaurant conversation end-to-end

# prod (single VPS) — NOT WORKING YET (P8)
# infra/docker-compose.yml references four Dockerfiles that do not exist (api, worker, coderunner,
# panel) and sets DB_DRIVER=postgres, which no driver implements: the API now refuses to boot with
# DB_DRIVER_UNSUPPORTED rather than silently using PGlite. Until P8 lands, only the dev path above runs.
docker compose -f infra/docker-compose.yml up -d
```

## Repository layout

See `docs/11_folder_structure.md`. In short: `apps/` (api, worker, coderunner, panel) · `packages/` (core, db, agents, channels, infra, testing) · `db/migrations` · `config/` (questionnaires, agent configs as data) · `data/` (runtime artifacts) · `infra/` · `scripts/` · `tests/`.

## Working agreement (from `docs/phases/00_COMMON_RULES.md`)

One phase at a time · tests must actually run and real results reported · config and prompts are data, not code · every agent returns structured JSON · never hard-code secrets · client text is untrusted · after every phase: STOP, report, wait for approval.

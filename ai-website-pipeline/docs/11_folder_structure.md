# Deliverable 12 — Folder / Project Structure

**Status:** Phase 0 design (stack Option A). Skeleton directories exist in the repo; no feature code yet (§Phase 0 rules).

## 1. Repository layout (monorepo, npm workspaces)

```
ai-website-pipeline/
├── SPEC.md                      # the master specification (Writing_v2) — authoritative (§55A.1)
├── DECISIONS.md                 # running architectural decision log (§55A.7)
├── README.md                    # what this is, how to run, phase status
├── PHASE_REPORTS/               # one report per phase (COMMON_RULES)
├── docs/                        # Phase 0 deliverables (this folder)
│   ├── 01_system_architecture.md … 19_meta_platform_findings.md
│   ├── contracts/               # agent I/O JSON Schemas (files mirroring agent_config_versions)
│   ├── phases/                  # 00_COMMON_RULES.md + phase files (from phases.zip)
│   └── architecture/            # diagrams (mermaid sources + exported SVG)
├── apps/
│   ├── api/                     # Fastify: REST /api/v1, /webhooks/*, /preview/*, /dev/simulator/*
│   │   ├── src/routes/*.ts      # one file per resource (projects.ts, requirements.ts, …)
│   │   ├── src/plugins/*.ts     # auth, rbac, rate-limit, error-envelope, raw-body
│   │   └── src/server.ts
│   ├── worker/                  # orchestrator + agent execution
│   │   ├── src/orchestrator/    # claim loop, dispatch, retries, timers
│   │   ├── src/handlers/*.ts    # one handler per job type
│   │   └── src/index.ts
│   ├── coderunner/              # build + runtime verification (Playwright)
│   │   ├── src/runner/          # install/build/test executor, resource caps
│   │   ├── src/checks/          # e2e.ts, responsive.ts, links.ts, console.ts, security.ts, a11y.ts
│   │   └── src/index.ts
│   └── panel/                   # Next.js Team Panel (Phase 7)
│       ├── app/…                # routes mirroring the API
│       └── src/features/…       # project page tabs, task board, agent console
├── packages/
│   ├── core/                    # DOMAIN: pure TS (no IO) — state machine, guards, completeness, windows
│   ├── db/                      # Drizzle schema + repositories + migrations runner + seeds
│   ├── agents/                  # agent registry, prompt assembly, LlmClient adapters, contracts (zod)
│   ├── channels/                # conversation engine + instagram adapter + simulator adapter
│   ├── infra/                   # jobs queue, artifact store, crypto, logger, config, clock
│   └── testing/                 # fixtures, fake LLM provider, PGlite harness, webhook signer
├── db/
│   └── migrations/              # NNNN_*.sql (drizzle-kit generated, reviewed)
├── config/
│   ├── questionnaires/          # GENERAL.json + packages (RESTAURANT.json, ECOMMERCE.json, …)  (§7, §50)
│   ├── agent-configs/           # seed definitions for agent_config_versions (§51)
│   └── defaults.json            # config_values defaults (loop limits, thresholds, caps)
├── data/                        # runtime artifacts (git-ignored)
│   ├── projects/<projectId>/{requirements,spec,client,audits,builds,design,tasks,logs}   (§45)
│   └── workspaces/<projectId>/<buildVersion>/      # build sandboxes
├── infra/
│   ├── docker-compose.yml       # postgres, api, worker, coderunner, panel, caddy
│   ├── Dockerfile.api|worker|coderunner|panel
│   ├── Caddyfile
│   └── scripts/{backup.sh,restore.sh,deploy.sh,rotate-token-key.sh}
├── scripts/
│   ├── init-repo.sh             # git init + hooks for a fresh clone
│   ├── dev.sh                   # run api+worker(+panel) locally
│   ├── seed.ts                  # admin user, questionnaires, agent configs, config defaults
│   ├── replay-webhook.ts        # signed Meta payload replay (§8 of IG doc)
│   └── simulate-conversation.ts # end-to-end simulator demo (Phase 1 acceptance)
├── tests/
│   ├── unit/                    # pure domain tests (fast)
│   ├── integration/             # PGlite + repositories + queue
│   ├── contract/                # agent output schemas against fixtures
│   └── e2e/                     # full vertical slice via simulator (+ Playwright for panel)
├── .env.example
├── tsconfig.base.json
├── package.json                 # workspaces + scripts (dev, build, test, verify, migrate, seed)
└── .github/workflows/ci.yml
```

## 2. Rules that keep this structure honest

1. **`packages/core` has zero dependencies on Node APIs** (no fs, no net) — pure functions only. Enforced by lint boundary + test.
2. **Apps never import from another app.** Shared code lives in `packages/*`.
3. **`db` is the only package allowed to hold SQL strings.** Everything else goes through repositories.
4. **`config/` is seeded into the DB**; runtime reads config from the DB (so the team can change loop limits without deploy, §10), while the files remain the versioned source of truth for review.
5. **No feature from a later phase** (COMMON_RULES #1) — each phase adds its own folders/files only.
6. **`data/` is runtime, not source.** Deleting it must never lose anything irrecoverable: artifacts are re-exportable from DB+artifacts table; workspaces are re-buildable.

## 3. Generated project structure (output of the Coding Agent — Phase 5+)

Never mixed with the platform repo. Each build workspace follows a fixed, spec-driven layout that the checker can rely on:

```
workspace/
├── package.json          # scripts: dev, build, start, test
├── src/
│   ├── ui/               # presentation only — NO business logic (§23)
│   ├── domain/           # business logic, framework-free
│   └── adapters/         # data/api access, swappable
├── public/
├── tests/                # includes AC-derived e2e specs
├── README.md             # how to run/deploy (required by §22)
└── .env.example
```

This mirrors §23 (UI vs logic separation) and is asserted by the code checker's "separation check" (Phase 6 acceptance).

## 4. Naming conventions

- DB tables `snake_case` plural; TS types `PascalCase`; files `kebab-case.ts`; job types `SCREAMING_SNAKE`.
- Migration files `NNNN_short_description.sql`, forward-only.
- Artifacts `<kind>-v<N>.<ext>` inside the §45 layout.
- Agent contract files `<agent>-output.json` (version in the schema body, not the filename).

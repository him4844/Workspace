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

**Phase 0 — Architecture & Stack: COMPLETE, awaiting human approval.**
No feature code has been written, per `00_phase0_architecture_and_stack.md` and §55A.3.

- ✅ 18/18 required deliverables (SPEC §56) → `docs/`
- ✅ Stack proposal with alternatives, costs, risks → `docs/18_stack_proposal.md`
- ✅ Meta/Instagram platform rules verified against current official docs → `docs/19_meta_platform_findings.md`
- ✅ Open questions requiring human decisions → `docs/17_open_questions.md`
- ✅ Agent I/O contracts as machine-readable JSON Schema → `docs/contracts/`
- ⏳ **Blocked on:** approval of the architecture + stack, and answers to Q1–Q6

## Next steps after approval

1. Phase 1 — Instagram gateway + conversations + state machine core (`docs/phases/01_*`), using the **simulator channel** until Meta access is live.
2. Parallel tracks (start immediately, independent of coding): Meta app + Business Verification + App Review (risk A1); test Instagram account; LLM keys; hosting decision.

## How the finished system will run (target, from `docs/15_deployment_strategy.md`)

```bash
# dev (works without Docker/Postgres/Chromium — uses PGlite + simulator channel)
npm run dev            # api + worker
npm run seed           # admin user, questionnaires, agent configs
npm run simulate       # drive a full restaurant conversation end-to-end

# prod (single VPS)
docker compose -f infra/docker-compose.yml up -d   # postgres, api, worker, coderunner, panel, caddy
```

## Repository layout

See `docs/11_folder_structure.md`. In short: `apps/` (api, worker, coderunner, panel) · `packages/` (core, db, agents, channels, infra, testing) · `db/migrations` · `config/` (questionnaires, agent configs as data) · `data/` (runtime artifacts) · `infra/` · `scripts/` · `tests/`.

## Working agreement (from `docs/phases/00_COMMON_RULES.md`)

One phase at a time · tests must actually run and real results reported · config and prompts are data, not code · every agent returns structured JSON · never hard-code secrets · client text is untrusted · after every phase: STOP, report, wait for approval.

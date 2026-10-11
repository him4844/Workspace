# Deliverable 15 — Testing Strategy

**Status:** Phase 0 design. Source: SPEC §25A, §41, §52, §57, §58; COMMON_RULES #7 ("run tests, report real results").

## 1. Test pyramid

```
        ▲  E2E (few, high value)            tests/e2e/         simulator conversation + Playwright panel
       ╱ ╲ Contract (agent I/O)            tests/contract/    schemas vs fixtures, valid & invalid examples
      ╱   ╲ Integration (real DB)          tests/integration/ PGlite + repositories + queue + webhooks
     ╱     ╲ Unit (domain, exhaustive)     tests/unit/        state machine, guards, completeness, windows
```

Rule: **the domain layer is tested exhaustively at the unit level** because every guard in `05_state_machine.md` is a pure function; integration/E2E then only prove wiring.

## 2. Unit tests (`packages/core`)

| Area | Cases (minimum) |
|---|---|
| State machine | every allowed transition fires; **every disallowed pair is rejected** (generate the matrix from the table and assert wholesale); T-cell guards (T05 completeness, T10 approval ref, T16 lock, T19 build-succeeded, T21 critical-security) |
| Loop counters | 3rd spec-audit failure → BLOCKED; counters survive process restart (re-read from DB fixture); no transition resets counters without an explicit human flag |
| Completeness engine | all mandatory statuses ∈ {CONFIRMED, APPROVED_DEFAULT, N/A} → complete; one EMPTY blocks; open contradiction blocks; 10A promotion rules |
| 10A status rules | `CLIENT_CONFIRMED` without `source_message_id` → rejected; mapping of legacy words (CONFIRMED→CLIENT_CONFIRMED etc.) |
| Window math | 24 h open/close, exact boundary, restart on new inbound, 7-day click-to-direct window variant, human_agent eligibility (≤7 d) |
| Priority rules | MUST outranks LATER; priorities never dropped silently |
| Next-action derivation | panel `nextAction` table cases (10 examples) |

Coverage target for `packages/core`: **≥ 90% lines, 100% of transition guards**.

## 3. Integration tests (PGlite; the real-Postgres job is a P8 item and does not exist yet)

> **Status (2026-10-11, `AUDIT.md` P1-1 / P1-2).** Every integration test below runs on PGlite only.
> There is no Postgres driver in the codebase — `packages/db/src/client.ts` now refuses
> `DB_DRIVER=postgres` with `DB_DRIVER_UNSUPPORTED` instead of quietly opening an embedded database —
> so the "Postgres 16 CI service container" cannot be wired up. The schema-drift half of item 1 *is*
> automated: `npm run schema:drift` compares the Drizzle schema against `db/migrations/*.sql` and is a
> required CI step. The "migrations apply on real Postgres" half is deferred to P8.

1. Migrations apply cleanly from zero on PGlite (real Postgres 16: deferred to P8, no driver yet) — schema drift check.
2. Repositories: insert/read/version chains (requirements v1→v2, spec v1→v2, build v1→v2) with "old versions still present" assertions (§34).
3. Idempotency: insert the same `webhook_events` twice → 1 row; enqueue the same `idempotency_key` twice → 1 job; duplicate `messages(channel_message_id)` → 1 row.
4. Jobs queue: claim under `SKIP LOCKED` with two simulated workers → no double processing; expired lease → requeued; attempts/backoff; dead-letter after max attempts.
5. Transactionality: a transition that fails mid-effect leaves **zero** partial writes.
6. Approval/lock: lock spec → update attempt rejected; approval without message ref rejected.
7. Webhook handler: valid signature 200 + persisted; invalid signature 403 + no rows; missing `X-Hub-Signature-256` 403.
8. `requirement_fields` CHECK constraint: direct SQL attempt to set CLIENT_CONFIRMED without message id fails.

## 4. Contract tests (agents)

Each file in `docs/contracts/*.json` ships with `exampleValid` and `exampleInvalid`:

- every agent's output schema must validate `exampleValid`;
- `exampleInvalid` must be rejected with the expected path(s);
- the schema in `agent_config_versions.output_schema` is byte-identical to the repo file (drift test).

**Fake LLM provider** (`packages/testing`): deterministic, scripted responses per test scenario (e.g. "restaurant conversation", "vague design answer", "injection attempt", "invalid JSON twice"). Every agent-level test runs offline and reproducibly — no live model calls in CI (COMMON_RULES #7 requires real results, and real results require determinism).

**Live smoke tests** (opt-in, `npm run test:live-llm`): 1 call per agent against the configured provider, asserting schema-valid output. Run manually before phase reports when API keys exist; failures reported honestly.

## 5. E2E tests

### 5.1 Simulated Instagram full slice (drives all of P1–P7)

`tests/e2e/vertical-slice.spec.ts` — scripted through the simulator:

```
inbound "I need a website for my restaurant"
 → project NEW→INTAKE→REQUIREMENTS_IN_PROGRESS
 → scripted answers (10 turns, incl. one vague answer + one "I don't know" + one contradiction)
 → REQUIREMENTS_COMPLETE → SPEC_GENERATING → CLIENT_REVIEW
 → outbox contains Client Summary with quick replies
 → inbound "yes, approve" → CLIENT_APPROVED (approved spec locked, vN)
 → SPEC_AUDIT PASS → READY_FOR_BUILD → BUILD_RUN (fake coding agent fixture) → CODE_AUDIT
 → fake checker PASS → TEAM_REVIEW
 → team sets price+deadline via API (human member) → draft sent → IN_DEVELOPMENT … COMPLETED
assertions at every state: transition history rows, events, artifacts, no orphan tasks
```
Negative variants: auditor FAIL ×3 → BLOCKED; checker FAIL ×3 → BLOCKED; send outside window → SEND_BLOCKED + task; duplicate webhook replay → no duplicate messages.

### 5.2 Panel E2E (Playwright, from P7)

Login → dashboard → open project → the 10 questions present → open check evidence → set price → unauth access blocked (403) → role restrictions (VIEWER cannot transition).

### 5.3 Code checker's own E2E (P6, the product feature)

Fixture applications live in `tests/e2e/fixtures/`:
- `good-landing` (should PASS with runtime evidence),
- `missing-feature` (should FAIL naming the requirement),
- `broken-build` (must be FAIL: "could not build"),
- `noisy-console` + `broken-links` + `bad-responsive` (targeted FAIL/PARTIAL),
- `unprotected-admin-route` (security finding).

These fixtures are the P6 acceptance tests (§Phase 6) and prove the checker is not over-trusting the LLM (deterministic tool evidence).

## 6. Test data & isolation

- Each test gets a fresh PGlite database + temp artifacts dir; no shared state.
- Clock is injectable (`Clock` interface): window/inactivity tests use a fake clock; simulator `/dev/simulator/clock` uses the same abstraction.
- Secrets: tests never read real env secrets; `.env.test` provides dummies; the fake LLM provider needs none.

## 7. CI (`npm run verify` locally = same script)

The Phase 0 target pipeline:

```
typecheck (tsc -b) → lint (eslint + boundaries) → unit → integration (PGlite)
→ integration-postgres (service container) → contract → e2e (simulated slice)
→ schema-drift check → openapi breaking-change check
```

What `.github/workflows/ci.yml` actually runs today — `npm run verify`, on Node 20 and Node 22, with
the cheap gates first so a failure costs seconds instead of minutes:

```
docs integrity → schema-drift → typecheck → unit + integration + e2e (PGlite, serial)
```

Stages that are **not** present, and why (`AUDIT.md` P1-2):

| Missing stage | Reason |
|---|---|
| `lint (eslint + boundaries)` | no ESLint or Prettier config is installed, despite six `eslint-disable` comments in the source (P2-7) |
| `integration-postgres` | no Postgres driver exists (§3 above, P1-1) |
| `openapi breaking-change check` | no OpenAPI document is generated from the Fastify routes |
| `contract` as its own stage | it exists, just not separately: `tests/unit/contract-parity.test.ts` runs inside the suite |

Any phase is only "done" when `verify` is green **and** the phase's acceptance script has been run and its real output quoted in the report (COMMON_RULES #7, §57).

## 8. What we will NOT claim (honesty rules, §52)

- "Tested" is only written next to an actual command + result output.
- Static-only verification is labelled `STATIC_ONLY` in check results (§25A) — including our own platform features when the environment cannot run something (e.g. no Chromium available in a sandbox: the report says so explicitly).
- Flaky tests are quarantined with an issue, not muted silently.

---

## 9. Status after Phase 3 (2026-10-08) — what actually exists

Specification Agent, the deterministic audits (§16/§17/§19), versioning (§34), the two-step client
approval (§18/§19, D-030) and the lock + change-request path (§35) exist end to end; `npm run
simulate:phase3` and `tests/e2e/spec-approval.test.ts` drive them, and the dev console shows the
specification panel (version, status, approval step, traceability, version history, change requests).
The audits are real gates: an un-traceable specification never reaches the client (D-031).
Phase-3 evidence is stored in `PHASE_REPORTS/evidence/` (`phase3-verify.txt`, `phase3-simulate.txt`,
`phase3-live-run.txt` — the live run reached v2 `LOCKED` with 31/31 traceability over real HTTP).

## 9.1 Status after Phase 2 (2026-10-08) — what actually exists

| Layer | File(s) | Tests |
|---|---|---|
| Unit — state machine | `tests/unit/state-machine.test.ts` | 17 |
| Unit — requirements core (completeness, planner, apply, detection, questionnaire data) | `tests/unit/requirements-core.test.ts` | 24 |
| Unit — security, window math, config data (`config/` is the source of truth) | `tests/unit/security-and-window.test.ts`, `tests/unit/config-validation.test.ts` | 11 + 9 |
| Integration — ingestion + repositories (real PGlite) | `tests/integration/ingest.test.ts` | 11 |
| Integration — HTTP webhook (signature, dedupe, batch) | `tests/integration/webhook-http.test.ts` | 7 |
| Integration — requirements inspection API | `tests/integration/requirements-api.test.ts` | 2 |
| E2E — Phase-1 slice (echo, parking, blocked send) | `tests/e2e/simulated-conversation.test.ts` | 5 |
| E2E — Phase-2 requirements interview (11 scenarios incl. §8A vague, §8B contradiction, §10A bogus source, repair, injection, caps, inactivity) | `tests/e2e/requirements-interview.test.ts` | 11 |
| Unit — specification core (§16 traceability, §17 testability, §18/§19 summary consistency, §34/§35 lock rules, §18 intent) | `tests/unit/spec-core.test.ts` | 22 |
| Unit — free-only routing + preset catalogue (D-029) | `tests/unit/llm-free-only.test.ts` | 11 |
| E2E — Phase-3 specification + two-step client approval (9 scenarios incl. change→v2, traceability failure, unclear reply, replay idempotency, locked-edit 409, approval reminder, model failure) | `tests/e2e/spec-approval.test.ts` | 9 |

`vitest run` = **12 files / 138 tests**, `tsc --noEmit` clean. The scripted provider is the default in
tests (`packages/testing`), so the suite is deterministic and offline; the same provider can be
selected in the running system with `LLM_PROVIDER=scripted` for demos (D-025).

**Live acceptance drivers (not part of `vitest run`, quoted in `PHASE_REPORTS/phase2.md` and `phase3.md`):**

```bash
npm run simulate:requirements   # in-memory: seeds config/ + one restaurant DM → REQUIREMENTS_COMPLETE
npm run simulate:phase3         # in-memory: interview → spec v1 → summary → change → v2 → approval → LOCKED
npm run dev                     # LLM_PROVIDER=scripted …: API :3000 + embedded worker (PGlite, D-022)
npm run demo:live               # drives the RUNNING API over HTTP (simulator channel) and prints the result
```

Phase-3 E2E tests run the pipeline one job per `tick` (`maxJobs: 1`): a single tick would follow the
requirements hand-off straight into the specification job, and each test decides what the specification
agent sees and when it runs (§14).

Operational note: stop the dev server (`npm run dev`) before the suite — with the API+worker process
alive the fork workers can die under memory pressure (`Worker exited unexpectedly`), which looks like a
test failure but is sandbox contention.

Playwright/Chromium is **not** available in this sandbox: browser-level tests remain Phase-6 work and
are explicitly reported as not-run until a VPS with Chromium exists (§8 honesty rules).

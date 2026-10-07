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

## 3. Integration tests (PGlite + real Postgres job in CI)

1. Migrations apply cleanly from zero on PGlite **and** Postgres 16 (CI service container) — schema drift check.
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

```
typecheck (tsc -b) → lint (eslint + boundaries) → unit → integration (PGlite)
→ integration-postgres (service container) → contract → e2e (simulated slice)
→ schema-drift check → openapi breaking-change check
```
Any phase is only "done" when `verify` is green **and** the phase's acceptance script has been run and its real output quoted in the report (COMMON_RULES #7, §57).

## 8. What we will NOT claim (honesty rules, §52)

- "Tested" is only written next to an actual command + result output.
- Static-only verification is labelled `STATIC_ONLY` in check results (§25A) — including our own platform features when the environment cannot run something (e.g. no Chromium available in a sandbox: the report says so explicitly).
- Flaky tests are quarantined with an issue, not muted silently.

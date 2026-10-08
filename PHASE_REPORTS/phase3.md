# PHASE 3 REPORT — Specification Agent, Client Summary & two-step client approval

**Phase file:** `docs/phases/03_phase3_specification_and_client_approval.md` · **Report per:** `docs/phases/00_COMMON_RULES.md`
**Date:** 2026-10-08 · **Status:** COMPLETE — **waiting for human approval before Phase 4**

Every claim in this report is backed by a command you can re-run, and the command output is stored in
`PHASE_REPORTS/evidence/` so the numbers below can be checked without re-running anything.

Phase 3 was developed **without Meta access and without a provider key**, under the standing rule that
the whole project must stay **completely free** (D-029). The scripted provider (`LLM_PROVIDER=scripted`)
replaces only the network call — prompt assembly, contract validation, both deterministic audits, the
single repair, persistence, versioning, the state machine and the artifact writer all execute for real
(D-025). The same runs are reproducible against any free provider (Groq / Gemini free / OpenRouter
`:free` / local Ollama) with zero code changes — only `.env`.

---

## 1. What was built (SPEC §14–§19, §34–§35, §38, §49–§52)

| # | Phase-3 task | Where | Status |
|---|---|---|---|
| 1 | Specification Agent: requirements snapshot → one structured LLM run → validated `SpecificationOutput` (§14–§15, §49) | `packages/agents/src/spec/agent.ts`, `packages/agents/src/contracts.ts` (`SpecificationOutputSchema`), `apps/worker/src/handlers/spec.ts` | ✅ |
| 2 | Deterministic audits as real gates: §16 traceability, §17 testability, §19 summary consistency + unknown-field / orphan-AC checks; ONE repair attempt, then `SPEC_TRACEABILITY_FAILED` + `CHANGES_REQUESTED` + human task (D-031) | `packages/core/src/spec/{traceability,rules}.ts` | ✅ |
| 3 | Client Summary generated **from the specification** by `renderSpecMarkdown`, never by a second free-form generation; the client never receives the technical document or price/deadline (§18, §30) | `packages/core/src/spec/render.ts`, artifact `…/spec/v<n>/client-summary.md` | ✅ |
| 4 | **Two-step** client approval (D-030): Client Summary → wait for the client's reply → explicit approval question with the two labels → APPROVE / REQUEST_CHANGES / UNCLEAR, confidence threshold 0.85 + keyword fast-path from config (data, §50) | `apps/worker/src/handlers/clientIntent.ts`, `packages/core/src/spec/intent.ts`, `config/defaults.json` (`spec.*`) | ✅ |
| 5 | Approval hygiene: dedupe by `source_message_id`, ≤2 clarifying questions for UNCLEAR replies, 48 h reminder ×1 → `CLIENT_SILENT`, timers cancelled when a decision arrives (§21 no loops) | same as #4, `client_approvals` table | ✅ |
| 6 | Versioning (§34, D-032): exactly one specification per requirements version; a change request from the client produces **v2 traced to the client's words**, v1 is preserved as `SUPERSEDED`, both stored with sha256 artifacts | `specsRepo`, `spec_versions` + `spec_requirements` + `acceptance_criteria` | ✅ |
| 7 | Approval → lock (§19): `LOCKED` + project `CLIENT_APPROVED`; any edit of an approved version is rejected with `409 SPEC_IS_LOCKED`; the only door is a Change Request (§35) with a recorded `CHANGE_REQUEST` event | `apps/api/src/routes/spec.ts`, `assertSpecWritable` | ✅ |
| 8 | Free-only routing (D-029): `LLM_PRESET` + `LLM_FREE_ONLY=true` default; a non-free route is refused (no client, honest “no LLM configured” — never a paid call) | `packages/infra/src/llm-presets.ts`, `config/llm-presets.json`, `packages/agents/src/llm/factory.ts` | ✅ |
| 9 | Human inspection surface: `GET/PATCH /api/v1/projects/:id/spec`, requirement detail, change-request list/decision, `GET /api/v1/spec-config`, and the dev-console specification panel (version, status, approval step, traceability, history) | `apps/api/src/routes/spec.ts`, `routes/simulator-console.ts` | ✅ |
| 10 | Migration `0003_phase3_specification.sql`: `spec_versions`, `spec_requirements`, `acceptance_criteria`, `client_approvals`, `change_requests` (+ enums, unique guards, `source_message_id` dedupe) | `db/migrations/0003_phase3_specification.sql` | ✅ |

**Acceptance checks from the phase file**

| Acceptance check | Result |
|---|---|
| spec v1 → client change → v2 → client approves → **v2 LOCKED, v1 stored** | ✅ `simulate:phase3` §5–§6 and the live run (`PHASE_REPORTS/evidence/phase3-live-run.txt`) |
| Client Summary and Technical Specification never contradict each other | ✅ §19 audit is a gate (unit `spec-core`, e2e “summary that names a page the spec lacks is blocked”); the summary is rendered FROM the spec, so drift is structurally impossible |
| Edit attempt against a locked specification is rejected | ✅ `409 SPEC_IS_LOCKED` over real HTTP in both drivers and in `tests/e2e/spec-approval.test.ts` |
| Every client-confirmed field reaches the spec as a traced `SPEC-REQ` with ≥1 testable AC | ✅ 30/30 (simulate) and 31/31 (live, after the client's change), `AC: 30/31`, all `testable` |

---

## 2. Headline decisions made in Phase 3 (details in `DECISIONS.md`)

- **D-029 — free-only is enforced in code, not in documentation.** `LLM_FREE_ONLY=true` is the default;
  `decideRoute` refuses presets marked `free:false` and endpoints outside the free allowlist
  (`generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`; localhost/LAN always allowed).
  A refused route yields **no LLM client** — the pipeline must say “no LLM configured”, never silently
  fall back to a paid one. `tests/unit/llm-free-only.test.ts` (11 tests) pins this.
- **D-030 — the approval is two-step by the human's explicit choice.** Message 1 is the Client Summary;
  the explicit approval question is only asked after the client has replied (any reply counts as “seen”).
  This prevents the §18 failure mode where a client scrolls past the summary and taps the button.
- **D-031 — deterministic audits gate everything the client sees.** An un-traceable or un-testable
  specification is never sent to a client: the handler tries exactly one repair, then escalates
  (`CHANGES_REQUESTED`, project `BLOCKED`, `HUMAN_REVIEW` task). No silent best-effort.
- **D-032 — one specification per requirements version.** The `SPEC_GENERATE` job is idempotent per
  requirements version (`spec-generate:<versionId>`), and the lock is a predicate-guarded UPDATE, so a
  double click, a replayed webhook or a second worker cannot produce two approved specifications.

Two runtime notes worth a reviewer's eye:

- The dev entrypoint (`apps/worker/src/services/llm.ts`) now builds the scripted client with
  `createPipelineLlm()` — persona routing by task. The first live run exposed the earlier
  requirements-only wiring (spec run answered in requirements shape → `NEEDS_REVIEW`); fixed and
  re-verified live in the run quoted below. This was a **dev/demo wiring bug only**; tests and the
  production path were never affected.
- `GET …/spec` now also returns the derived `approvalStep`
  (`SEND_SUMMARY → AWAIT_SUMMARY_ACK → AWAIT_DECISION → DECIDED`), the same value the console shows —
  so the two-step state is observable over the API, not only in the UI.

---

## 3. How it was verified (real results, 2026-10-08)

### 3.1 The suite — `npm run verify` (`PHASE_REPORTS/evidence/phase3-verify.txt`)

```
tsc --noEmit                 → 0 errors
vitest run                   → 12 files / 138 tests passed (158 s)
node scripts/check-docs.mjs  → OK: 23 docs present, contracts valid JSON
```

New in Phase 3: `tests/unit/spec-core.test.ts` 22/22 (§16/§17/§19/§34/§35 logic + `deriveApprovalStep`),
`tests/unit/llm-free-only.test.ts` 11/11 (D-029 routing), `tests/e2e/spec-approval.test.ts` 9/9
(generate → summary → two-step ask → change → v2 → approve → lock → 409; traceability failure →
human task; unclear reply → clarifying question; replay → no duplicate; reminder; model failure).

### 3.2 In-memory acceptance driver — `npm run simulate:phase3` (`evidence/phase3-simulate.txt`)

```
turns=30  state=CLIENT_REVIEW  completeness=100%
spec v1 status=IN_REVIEW  SPEC-REQ: 30  AC: 30 (testable: 30)
traceability (§16): 30/30 client-confirmed fields implemented by a SPEC-REQ
transitions: T01 → T02 → T03 → T05 → T06 → T07
… client replies → approval question (step 2) → client asks for a change
  v1  status=SUPERSEDED SPEC-REQ=30
  v2  status=IN_REVIEW  SPEC-REQ=31   ← the client's words are in the spec, not only in the chat
… APPROVE (KEYWORD, 0.95) → v2 LOCKED  lockedAt=2026-10-08T14:26:28Z, project CLIENT_APPROVED
PATCH /spec → 409 SPEC_IS_LOCKED   POST /change-requests → 201 REQUESTED
events: SPEC_GENERATED×2, SPEC_LOCKED×1, APPROVAL_RECORDED×2, CHANGE_REQUEST×1, SPEC_TRACEABILITY_FAILED×0
jobs: 69 DONE / 1 PENDING      open human tasks: 0      LLM calls: 38 (6 specification/intent)
```

### 3.3 Live run over real HTTP — `npm run demo:live` with `DEMO_PHASE3=1` (`evidence/phase3-live-run.txt`)

The dev server (`LLM_PROVIDER=scripted npm run dev`, API + embedded worker on :3000) was driven through a
client simulator: 31 DM turns → spec → approval → change → v2 → approval → lock → 409 → change request.

```
state: CLIENT_REVIEW   turns: 31   completeness: 100%   mandatory confirmed: 24/24
summary artifact …/requirements/v1.md  sha256=7edfd91894e37eaa…
spec v1 IN_REVIEW · approval step: AWAIT_SUMMARY_ACK        ← step 1 sent, question NOT yet
--- client replies ---
step 2: the approval question (step now: AWAIT_DECISION)    ← only after the client's reply
--- client asks for a change ---
versions: v1:SUPERSEDED, v2:IN_REVIEW
current: v2 LOCKED   state: CLIENT_APPROVED   traceability: 31/31   AC: 31
approval: REQUEST_CHANGES via KEYWORD (90%)   approval: APPROVE via KEYWORD (95%)
PATCH /api/v1/projects/:id/spec → 409 SPEC_IS_LOCKED
POST /api/v1/projects/:id/change-requests → 201
```

This run is also the fix verification for the dev-persona routing note in §2: the SPECIFICATION agent
previously returned requirements-shaped output in the dev demo and escalated to `NEEDS_REVIEW`; after
the fix the same flow reaches `LOCKED` with 31/31 traceability.

### 3.4 Reproduce in ~15 minutes

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run db:reset && npm run simulate:phase3        # in-memory acceptance demo (no server)
npm run db:reset
LLM_PROVIDER=scripted LOG_LEVEL=info CHANNEL_SIMULATOR_ENABLED=true npm run dev   # API :3000 + worker
DEMO_PHASE3=1 DEMO_PLAIN=1 DEMO_SENDER_ID=demo1 DEMO_MAX_TURNS=40 npm run demo:live   # ≈5–9 min
# dev console: http://127.0.0.1:3000/ — chat, requirements, the specification panel (step, versions, history)
# stop the dev server, then:
npm run verify                                     # tsc + 138 tests + docs check
```

---

## 4. Incomplete / risky (honest list)

1. **No real Instagram thread has ever run through this.** The webhook, the 24 h window and the send
   path are exercised against the simulator and signed fixture payloads; Meta's real delivery is Phase-8
   work and requires the app review the user still has to start (`docs/17`).
2. **No paid provider was ever called — by design.** The free tier is the only tier the routing can
   reach (D-029). Free tiers have rate limits (Groq 30 RPM / 1 000 RPD; Gemini Flash-Lite ≈15 RPM;
   OpenRouter `:free` 50 RPD) — a long live conversation against a real free provider has not been run
   yet because **no key exists in this workspace**. Cost is recorded per run; the §26 budget cap is
   still recorded-not-enforced (unchanged from Phase 1–2).
3. **The approval classifier is a keyword fast path + agent fallback.** An ambiguous reply becomes
   `UNCLEAR` → one clarifying question (max 2) → human task; it cannot loop. Quality of the fallback in
   a non-Uzbek/Russian language is untested (the labels are config, §50).
4. **The change-request human decision (PATCH `APPROVED`/`IMPLEMENTING`) is an internal-token route.**
   The Team Panel that will own that decision is Phase 7; until then a human drives it with curl.
5. **The dev console is a viewer over production endpoints, not the Phase-7 panel (D-027)** and it dies
   with `CHANNEL_SIMULATOR_ENABLED=false`. Browser-level tests do not exist (no Chromium in the sandbox).
6. **Cosmetic:** the live driver asks one extra question if the state flips mid-poll (visible as `Q31`
   in the evidence file) — driver pacing only, no pipeline effect.

---

## 5. Open questions (need a human answer)

1. **Will you provide the free-tier keys now** (Groq and/or Gemini), or should Phase 4 stay
   `LLM_PROVIDER=scripted` and defer any real-provider run? Phase 4 needs the Spec Auditor on a
   **different provider** than the Main agent (your earlier choice, `docs/17`), so at least two free
   routes must exist — Groq + Gemini free would satisfy it; two keys on one host would not.
2. **Approval wording:** the two labels are config (`spec.approve_label`,
   `spec.request_changes_label`). Keep “Ha, tasdiqlayman / O‘zgartirish kerak”, or should the client
   also be able to approve by tapping a quick reply (currently typed text only)?
3. **Reminder policy:** default is one reminder after 48 h, then `CLIENT_SILENT` + human task. OK, or
   should the project park indefinitely and rely on the inactivity sweep only?
4. **Change requests after approval:** should a client-requested change **always** require an internal
   human decision before a new version is generated (today: yes, `APPROVED`/`IMPLEMENTING`), or may
   small wording changes auto-implement once the Team Panel exists?

---

## 6. Proposed next step

**Phase 4 — Specification Auditor (§20+)** — a second agent on a *different* free provider that audits
the LOCKED specification before coding starts, with its own structured contract and its own audit trail.
Nothing of Phase 4 (no auditor, no coding) exists in the code today; this is the first phase where an
agent gets real power to send work back.

**I stop here and wait for your explicit approval** per `docs/phases/00_COMMON_RULES.md` §1. If you
approve, Phase 4 starts with the auditor contract + prompt package (data, §50) and the free-provider
pairing answered from question 1 above.

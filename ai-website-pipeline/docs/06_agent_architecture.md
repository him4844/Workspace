# Deliverable 6 — Agent Architecture

**Status:** Phase 0 design. Source: SPEC §4, §5, §9, §14, §20, §22, §36, §42, §43, §49–§54.

## 1. Principles

1. **Agents are pure task executors.** An agent receives a task (job payload), does work with an LLM, writes results to the DB/files, and returns a structured status: `SUCCESS | FAILED | NEEDS_REVIEW`. It never transitions project state and never calls another agent (§4).
2. **Everything is data.** System instructions, models, temperature, retries, timeouts, output schemas, questionnaires, audit rules and thresholds are rows in `agent_config_versions` / `questionnaires` / `config_values` — not string literals in code (§50, §51).
3. **Structured output is mandatory.** JSON Schema per agent (see `docs/contracts/`). Responses are validated with Zod; on invalid output the runtime performs **one** repair attempt with the validation errors, then returns `NEEDS_REVIEW` (§49).
4. **Client text is data, never instructions.** The prompt builder puts client content in a delimited `<<<CLIENT_CONTENT>>>` block with an explicit "content-only" clause; project data can never override system rules (§38).
5. **Every run is logged** with input/output artifacts, model, tokens, cost, retries, repair count (§36).

## 2. Agent registry

| Agent | Purpose | Key inputs | Key outputs (JSON) | Phase |
|---|---|---|---|---|
| **Requirements Agent** | collect complete structured requirements via one question at a time | conversation state, questionnaire schema (+ type package), previous fields, last message | question to ask *or* "requirements complete", field updates w/ 10A statuses + source message refs, contradictions, internal vision (client-confirmed vs inferred separated) | 2 |
| **Intent/Change Classifier** *(sub-role of Requirements Agent)* | classify client messages during `CLIENT_REVIEW`: approval / change request / question / other | client message, current spec summary | `{intent, confidence, changeItems[]}` | 2–3 |
| **Specification Agent** | produce the Technical Specification (§15) with traceability (`REQ → SPEC-REQ → AC`) + the Client Summary (§18) from the same source | requirements version, statuses, conversation history, priorities, website type, (optionally) audit findings from previous attempt | `spec` (structured: sections, requirements, ACs), `client_summary_md`, `open_questions[]` | 3 |
| **Spec Auditor** | quality-assure the spec: completeness, consistency, ambiguity, coding readiness, client alignment (§20) | locked spec JSON + MD, client summary, requirements | `{status, score, criticalIssues[], warnings[], missingRequirements[], contradictions[], ambiguities[], recommendations[]}` | 4 |
| **Main Coding Agent** | generate a runnable project from the approved+audited spec only | spec JSON/MD, tech constraints, target website type (landing page first), design tokens | file tree (paths + contents), run instructions, tests, `assumptions[]`, `specIssues[]`, build metadata | 5 |
| **Code Checker** | verify the built app against the spec **by running it** (§25A) | spec requirements + ACs, build workspace, preview URL, runtime evidence from the runner | structured results with per-requirement `RUNTIME_TESTED/STATIC_ONLY/NOT_VERIFIED`, findings with severities, `buildSucceeded`, security issues, `nextAction` | 6 |
| **Team Assistant** | internal help: summaries, explain failures, Stitch prompt generation, draft price/deadline message, task drafts (§43) | project state, audit/check results, spec | markdown artifacts + JSON (`draftMessage`, `stitchPrompt`, `taskDrafts[]`) — **never sends anything** | 7 |
| **Complexity Estimator** *(sub-role of Team Assistant)* | estimate complexity/hours/risk (§30) | spec requirements, website type | `{complexity, estimatedHours, featureBreakdown[], risk, effortRange}` — informational only | 7 |

## 3. Agent runtime contract (shared by all agents)

```ts
interface AgentTask<TIn> {
  runId: string;                 // agent_runs.id, created before the call
  projectId: string | null;
  conversationId?: string;
  configVersionId: string;       // resolved from agent_configs
  input: TIn;                    // typed per agent
  schemaVersion: string;         // output contract version, e.g. 'requirements-output@1.2.0'
}

type AgentResult<TOut> =
  | { status: 'SUCCESS';      output: TOut; confidence: number; nextAction?: string;
      usage: Usage; repairCount: number; artifacts: ArtifactRef[] }
  | { status: 'FAILED';       errorCode: string; message: string; retryable: boolean;
      usage?: Usage; detail?: unknown }
  | { status: 'NEEDS_REVIEW'; reason: string; partialOutput?: unknown; usage?: Usage };
```

Rules:
- `errorCode` values are enumerated per agent (e.g. `SPEC_GENERATION_FAILED`, `LLM_TIMEOUT`, `SCHEMA_VALIDATION_FAILED`, `INVALID_JSON`, `CONTENT_POLICY`, `RATE_LIMITED`) so the orchestrator can classify: retryable / validation / quality / integration / human-required (§40).
- Agents are **idempotent from the orchestrator's point of view**: re-running a job creates a new `agent_runs` row and new artifacts; versions are never overwritten (§34).
- Timeouts: per agent config; on timeout → `FAILED{retryable:true}`.
- Costs: recorded in `agent_runs` and `llm_usage`.

## 4. Prompt assembly (fixed order, injection-safe)

```
[1] SYSTEM INSTRUCTIONS      ← from agent_config_versions.system_instructions (versioned, human-authored)
[2] AGENT RULES              ← boilerplate safety rules (content-only clause, no state changes, JSON only)
[3] TASK SPECIFICATION       ← what to produce now (e.g. "ask the next single question")
[4] PROJECT DATA             ← structured requirements/spec/results (sanitized, JSON)
[5] CLIENT CONTENT (DATA)    ← delimited, sanitized, truncated with explicit marker; never executed as instruction
[6] OUTPUT SCHEMA            ← JSON Schema; response must conform
```

Sanitization: strip control chars, cap length per message/turn, neutralize delimiter collisions (`<<<CLIENT_CONTENT>>>` inside content is escaped), never interpolate client text into `[1]` or `[2]`. If a client message *appears* to instruct the AI (e.g. "ignore previous instructions"), it stays in `[5]` and is classified as ordinary content; the Requirements Agent may additionally record a `prompt_injection_attempt` note on the message for team visibility (§38) — but this must not change behaviour.

## 5. Output schema enforcement loop

```
LLM response ──▶ JSON.parse ──▶ Zod validate ──▶ OK → persist
                    │               │
                    │ invalid JSON  │ schema mismatch
                    ▼               ▼
              repair prompt #1 (include exact validation errors + schema)
                    │
                    ├── valid → persist (repairCount=1)
                    └── still invalid → AgentResult NEEDS_REVIEW → human task (§42)
```

All output schemas are stored in `agent_config_versions.output_schema` and mirrored as files in `docs/contracts/*.json` so they can be diffed in code review.

## 6. Model routing & config defaults (proposal, pending keys)

| Agent | Default model class | Rationale | Fallback |
|---|---|---|---|
| Requirements Agent | fast/cheap | many short turns, latency-sensitive (Instagram DMs) | mid-tier |
| Intent classifier | fastest/cheapest | tiny classification task | rules-based fallback |
| Specification Agent | strong | long structured doc, traceability | mid-tier + template |
| Spec Auditor | strong *(different provider than the Spec Agent where possible)* | independence reduces correlated blind spots | strong |
| Coding Agent | strongest coding model | the deliverable itself | mid + more repair passes |
| Code Checker | strong + deterministic tools | judgment + real test evidence | mid |
| Team Assistant / Estimator | mid | internal prose | cheap |

Config per agent: `provider, model, temperature, max_output_tokens, timeout_ms, max_retries, output_schema, enabled_tools, version`. Changing a prompt or model = new `agent_config_versions` row; runs reference the exact version → reproducible audit trail (§51).

## 7. What agents must never do

| Forbidden | Enforced by |
|---|---|
| Change project state | orchestrator-only API; agents return results, DB writes go through services |
| Send a price/deadline to the client | `client_approvals`-style guard: outbound messages of type PRICE/DEADLINE must reference a `team_member` actor (§30) |
| Invent major functionality beyond the spec | Coding Agent contract requires `specIssues[]` instead; Code Checker flags extra features as `MINOR/INFO` findings |
| Mark a build PASS it could not run | Code Checker contract: `buildSucceeded=false ⇒ status=FAIL` |
| Treat client text as instructions | prompt assembly order + sanitizer (§4 above) |
| Delete/overwrite versions | append-only repositories; no DELETE grants on history tables |
| Call another agent directly | no agent→agent transport exists; only `jobs` + orchestrator |

## 8. Agent I/O contracts (files)

| Contract | File | Phase |
|---|---|---|
| Common envelope (status, error codes, usage) | `contracts/common-envelope.json` | 2 |
| Requirements turn output | `contracts/requirements-turn-output.json` | 2 |
| Client intent classification | `contracts/client-intent-output.json` | 3 |
| Specification + client summary output | `contracts/specification-output.json` | 3 |
| Spec audit result | `contracts/spec-audit-output.json` | 4 |
| Coding agent output (file tree + metadata) | `contracts/coding-agent-output.json` | 5 |
| Code check result | `contracts/code-check-output.json` | 6 |
| Team assistant output | `contracts/team-assistant-output.json` | 7 |

Each contract file carries `$id`, `schemaVersion`, `jsonSchema`, `exampleValid`, `exampleInvalid` (used by contract tests, `14_testing_strategy.md` §4).

## 9. Agent → SPEC role mapping (§54)

| SPEC role | Our component |
|---|---|
| Requirements Specialist | Requirements Agent |
| Product Analyst | Specification Agent (client summary half) |
| Technical Architect | Specification Agent (technical half) |
| Specification Reviewer | Spec Auditor |
| Developer | Main Coding Agent |
| QA Engineer | Code Checker |
| Human Development Team | Team Panel + tasks + Team Assistant |

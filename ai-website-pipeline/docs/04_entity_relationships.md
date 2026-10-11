# Deliverable 4 — Entity Relationships

**Status:** Phase 0 design. DDL lives in `03_database_schema.md`; this document explains *why* the relationships are shaped this way (the "§34 never destroy history" principle drives most of them).

## 1. Relationship map (with cardinalities)

```
organizations 1─N team_members, clients, channel_connections, agent_configs, tasks, events

clients 1─N client_identities        (one person/company per channel handle; UNIQUE(channel, external_id))
clients 1─N projects
clients 1─N conversations

channel_connections 1─N conversations
conversations 1─N messages
conversations 1─1 conversation_state       (per-thread working memory, §32)
conversations 1─N projects                 (a new need → a new project; same thread possible, see Q7)

projects 1─N project_state_transitions     (append-only; the audit of "how we got here")
projects 1─N loop_counters
projects 1─N requirement_versions          (v1, v2, … never overwritten, §12/§34)
requirement_versions 1─N requirement_fields
requirement_fields 1─N field_status_history
requirement_versions 1─N contradictions

projects 1─N spec_versions                 (each version pinned to the requirements version it came from)
spec_versions 1─N spec_requirements        (REQ → SPEC-REQ → AC chain, §16)
spec_versions 1─1 client_summaries (per version)
client_summaries 1─N client_approvals      (immutable decisions with message refs, §19)
spec_versions 1─N spec_audits              (attempt 1..3 of the audit loop, §21)
spec_audits 1─N audit_findings

projects 1─N builds                        (build vN pinned to a spec version)
builds 1─N build_logs
builds 1─N code_checks                     (attempt 1..3, §26)
code_checks 1─N verification_results       (per requirement: how it was verified, §25A)
code_checks 1─N check_findings

projects 1─N tasks, comments, change_requests
projects 1─N jobs                          (queue)
jobs 1─N job_attempts
projects 1─N agent_runs
agent_runs N─1 agent_config_versions       (exact prompt/model used — reproducibility)
projects 1─N artifacts, events
team_members 1─N sessions, team_actions, comments, tasks(assignee)
```

## 2. The five relationships that carry the spec's guarantees

| Relationship | Guarantee | Spec |
|---|---|---|
| `clients 1─N client_identities` UNIQUE(channel, external_id) | two clients can never be mixed; identity resolution is deterministic | §32 |
| `requirement_fields.source_message_id` (FK to messages) + CHECK | `CLIENT_CONFIRMED`/`CLIENT_APPROVED_DEFAULT` **must** point at a real client message — AI inference can never masquerade as client truth | §10A, §53 |
| `spec_versions → client_approvals → LOCKED` | the approved version is frozen; later changes require `change_requests` | §19, §35 |
| `builds.spec_version_id NOT NULL` + `code_checks.build_id NOT NULL` | you can always answer "checked against which spec?" and "built from which spec?" | §16, §25 |
| `agent_runs.config_version_id` | any output can be traced back to the exact prompt/model version that produced it | §36, §51 |

## 3. Version chains (what "never destroy history" produces concretely)

```
requirements: v1 ──▶ v2 ──▶ v3                     (each row immutable once superseded)
specs:        v1 (rejected) ──▶ v2 (approved, LOCKED) ──▶ [change request] ──▶ v3
summaries:    summary-v1 (superseded) ──▶ summary-v2 (approved)
approvals:    v2 APPROVED(message #123) ──▶ v3 CHANGES_REQUESTED(message #201) …
builds:       v1 (check FAIL) ──▶ v2 (check FAIL) ──▶ v3 (PASS)
checks:       check-v1, check-v2, check-v3  each with its own evidence artifacts
audits:       audit-v1 (FAIL) ──▶ audit-v2 (PASS)
```
Nothing is updated in place; supersession is a `status` change plus a new row. The Team Panel renders these chains as the project's story (§34 last line).

## 4. Deliberate denormalisations (and why)

| Denormalisation | Reason | Guard |
|---|---|---|
| `projects.current_*_version` counters | dashboard speed; avoid max() scans | updated only inside the version-creating transaction |
| `conversations.window_expires_at` | hot path check before every send | recomputed on each inbound message; watchdog re-derives |
| `code_checks.verification_counts` JSON | fast "how much was really tested" badge | derived from `verification_results`, asserted equal by a test |
| `projects.locked_spec_version_id` | guards T16/T33 cheaply | FK + invariant test |

## 5. What is intentionally **not** a relationship

- No FK from `messages` to `requirements` (messages are the *source*, requirements are the *interpretation*; the link is `requirement_fields.source_message_id`, one field at a time).
- No FK from `change_requests` to `builds` (a CR may affect several builds; impact is recorded in `impact_analysis` and via new versions).
- No `client_accounts`/`tenants` join tables yet — `org_id` columns are the only tenancy shape until the SaaS step (§2).

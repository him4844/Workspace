-- Phase 3 — Specification & Client Approval (SPEC §14–§19, §34, §35)
--
-- Versioning rule (§34): nothing is destroyed. A client change creates spec v(n+1); the previous
-- row stays, its status becomes SUPERSEDED, and every approval stays attached to the version it
-- approved. An approved version becomes LOCKED and is immutable afterwards — later changes are
-- change_requests (§35), never in-place edits.

CREATE TYPE spec_status AS ENUM ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','LOCKED','SUPERSEDED');
CREATE TYPE approval_decision AS ENUM ('APPROVE','REQUEST_CHANGES');
CREATE TYPE change_request_status AS ENUM ('REQUESTED','ANALYZING','APPROVED','REJECTED','IMPLEMENTING','COMPLETED');

CREATE TABLE spec_versions (
  id                              text PRIMARY KEY,
  org_id                          text NOT NULL REFERENCES organizations(id),
  project_id                      text NOT NULL REFERENCES projects(id),
  version                         integer NOT NULL,
  status                          spec_status NOT NULL DEFAULT 'DRAFT',
  requirement_version_id          text REFERENCES requirement_versions(id),
  -- the specification itself (§15) as generated + validated; sections are also normalized below
  spec                            jsonb NOT NULL,
  spec_artifact_id                text REFERENCES artifacts(id),
  -- the client-facing summary (§18) generated FROM the specification
  client_summary_md               text,
  client_summary_artifact_id      text REFERENCES artifacts(id),
  summary_sent_at                 timestamptz,
  summary_message_id              text,
  approval_requested_at           timestamptz,
  approval_message_id             text,
  change_request_text             text,               -- what the client asked to change (v>1)
  created_by_run_id               text REFERENCES agent_runs(id),
  locked_at                       timestamptz,
  locked_by_member_id             text REFERENCES team_members(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX spec_versions_project_version_uq ON spec_versions (project_id, version);
CREATE INDEX spec_versions_project_ix ON spec_versions (project_id, created_at DESC);
CREATE INDEX spec_versions_status_ix ON spec_versions (status);

-- Traceability §16: every important specification requirement is a row that points back at the
-- client-confirmed field (and the exact client message) it came from.
CREATE TABLE spec_requirements (
  id                   text PRIMARY KEY,
  spec_version_id      text NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
  code                 text NOT NULL,
  origin_req_field     text,                          -- requirement_fields.field_path
  origin_message_ids   jsonb NOT NULL DEFAULT '[]',
  section              text NOT NULL,
  title                text NOT NULL,
  description          text NOT NULL,
  priority             priority_level NOT NULL,
  verification_expectation text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX spec_requirements_version_code_uq ON spec_requirements (spec_version_id, code);
CREATE INDEX spec_requirements_origin_ix ON spec_requirements (origin_req_field);

CREATE TABLE acceptance_criteria (
  id                text PRIMARY KEY,
  spec_version_id   text NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
  spec_req_code     text NOT NULL,
  code              text NOT NULL,
  text              text NOT NULL,
  testable          boolean NOT NULL DEFAULT true,
  verification_hint text CHECK (verification_hint IN ('E2E','API','VISUAL','MANUAL','STATIC')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX acceptance_criteria_version_code_uq ON acceptance_criteria (spec_version_id, code);
CREATE INDEX acceptance_criteria_req_ix ON acceptance_criteria (spec_version_id, spec_req_code);

-- The single formal client decision (§19). Always carries the exact client message it came from.
CREATE TABLE client_approvals (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(id),
  project_id        text NOT NULL REFERENCES projects(id),
  spec_version_id   text NOT NULL REFERENCES spec_versions(id),
  decision          approval_decision NOT NULL,
  source_message_id text NOT NULL REFERENCES messages(id),
  confidence        numeric(4,3) NOT NULL DEFAULT 1.000,
  classification    text NOT NULL DEFAULT 'KEYWORD' CHECK (classification IN ('KEYWORD','AGENT','HUMAN')),
  change_items      jsonb NOT NULL DEFAULT '[]',
  raw_text          text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX client_approvals_message_uq ON client_approvals (source_message_id);
CREATE INDEX client_approvals_project_ix ON client_approvals (project_id, created_at DESC);

-- §35: after approval the only way to change the specification.
CREATE TABLE change_requests (
  id                      text PRIMARY KEY,
  org_id                  text NOT NULL REFERENCES organizations(id),
  project_id              text NOT NULL REFERENCES projects(id),
  spec_version_id         text REFERENCES spec_versions(id),  -- the version in force when requested
  requested_change        text NOT NULL,
  source                  text NOT NULL,                      -- client message / team member / audit
  reason                  text,
  affected_requirements   jsonb NOT NULL DEFAULT '[]',
  affected_spec_sections  jsonb NOT NULL DEFAULT '[]',
  potential_impact        text,
  status                  change_request_status NOT NULL DEFAULT 'REQUESTED',
  resulting_spec_version_id text REFERENCES spec_versions(id),
  created_by_member_id    text REFERENCES team_members(id),
  decided_by_member_id    text REFERENCES team_members(id),
  decided_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX change_requests_project_ix ON change_requests (project_id, created_at DESC);
CREATE INDEX change_requests_status_ix ON change_requests (status);

-- Event vocabulary: SPEC_GENERATED / SPEC_LOCKED / APPROVAL_RECORDED / CHANGE_REQUEST already exist
-- in the Phase-1 enum. Only the traceability failure of §16 is new.
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'SPEC_TRACEABILITY_FAILED';
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'SPEC_SUMMARY_INCONSISTENT';

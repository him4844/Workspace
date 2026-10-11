-- Phase 2 — Requirements Agent (docs/03 §5, §8; SPEC §5–§13, §10A, §49–§51)
-- Adds: structured requirements (versioned), per-field status history, contradictions,
-- questionnaires as data, agent configuration versions, LLM usage accounting.

-- §7 — new event type for website-type detection (enum ADD VALUE is idempotent-safe here
-- because migrations run exactly once per database; see docs/11 §2.3).
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'PROJECT_TYPE_DETECTED';

-- ---------------------------------------------------------------- questionnaires (§7, §50)
CREATE TABLE questionnaires (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                              -- 'GENERAL', 'RESTAURANT', 'ECOMMERCE', …
  version INT NOT NULL DEFAULT 1,
  type TEXT NOT NULL,                              -- 'GENERAL' | 'PACKAGE'
  applies_to_project_type TEXT,                    -- NULL for GENERAL
  definition JSONB NOT NULL,                       -- fields, order, quick replies, weights
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

-- ---------------------------------------------------------------- agent config (§51)
CREATE TABLE agent_configs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  agent_type agent_type NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  current_version INT NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_type, name)
);

CREATE TABLE agent_config_versions (
  id TEXT PRIMARY KEY,
  agent_config_id TEXT NOT NULL REFERENCES agent_configs(id),
  version INT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature NUMERIC(3,2),
  max_output_tokens INT,
  timeout_ms INT NOT NULL DEFAULT 60000,
  max_retries INT NOT NULL DEFAULT 2,
  system_instructions TEXT NOT NULL,
  output_schema JSONB NOT NULL,
  enabled_tools JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by_member_id TEXT REFERENCES team_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_config_id, version)
);

-- ---------------------------------------------------------------- requirements (§12, §10A)
CREATE TABLE requirement_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INT NOT NULL,
  questionnaire_schema_version TEXT NOT NULL DEFAULT '1.0.0',
  completeness NUMERIC(4,3) NOT NULL DEFAULT 0,
  summary_artifact_id TEXT REFERENCES artifacts(id),   -- internal summary for the Spec Agent (§10)
  vision JSONB NOT NULL DEFAULT '{}',                  -- §9 client-confirmed / inferred / not-specified
  pending_field_path TEXT,                              -- the question we are waiting for an answer to
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_by_run_id TEXT REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE requirement_fields (
  id TEXT PRIMARY KEY,
  requirement_version_id TEXT NOT NULL REFERENCES requirement_versions(id),
  field_path TEXT NOT NULL,                        -- 'payments.methods', 'design.style'
  category TEXT NOT NULL,                          -- one of the 18 mandatory categories (§6)
  value JSONB,
  status requirement_status NOT NULL DEFAULT 'EMPTY',
  priority priority_level NOT NULL DEFAULT 'MUST',
  mandatory BOOLEAN NOT NULL DEFAULT false,
  confidence NUMERIC(4,3),
  source_message_id TEXT REFERENCES messages(id),  -- REQUIRED for client-truth statuses (§10A)
  source_run_id TEXT REFERENCES agent_runs(id),
  note TEXT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requirement_version_id, field_path),
  -- §10A enforcement at the database level: client truth needs a client message reference.
  CONSTRAINT client_truth_needs_source CHECK (
    status NOT IN ('CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT') OR source_message_id IS NOT NULL
  )
);
CREATE INDEX requirement_fields_open_ix ON requirement_fields (requirement_version_id, status, mandatory);

CREATE TABLE field_status_history (               -- every status change, versioned (§10A)
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES requirement_fields(id),
  from_status requirement_status,
  to_status requirement_status NOT NULL,
  reason TEXT,
  message_id TEXT REFERENCES messages(id),
  agent_run_id TEXT REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_status_history_field_ix ON field_status_history (field_id, created_at);

CREATE TABLE contradictions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  requirement_version_id TEXT NOT NULL REFERENCES requirement_versions(id),
  field_a TEXT NOT NULL,
  field_b TEXT NOT NULL,
  description TEXT NOT NULL,
  severity severity NOT NULL DEFAULT 'MAJOR',
  status TEXT NOT NULL DEFAULT 'OPEN',             -- OPEN | CLARIFYING | RESOLVED | ACCEPTED_BY_CLIENT
  resolution_note TEXT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contradictions_project_ix ON contradictions (project_id, status);

-- ---------------------------------------------------------------- LLM usage (§36 cost accounting)
CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  agent_run_id TEXT REFERENCES agent_runs(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,4),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_day_ix ON llm_usage (created_at);

-- ---------------------------------------------------------------- run links added in Phase 2
ALTER TABLE agent_runs ADD COLUMN config_version_id TEXT REFERENCES agent_config_versions(id);
ALTER TABLE agent_runs ADD COLUMN turn_index INT;
ALTER TABLE agent_runs ADD COLUMN stop_reason TEXT;

-- 0001_init.sql — Phase 1 core schema (docs/03_database_schema.md, subset needed for Phase 1)
-- Postgres 16 compatible (runs on PGlite and real Postgres).

CREATE TYPE project_state AS ENUM (
  'NEW','INTAKE','REQUIREMENTS_IN_PROGRESS','REQUIREMENTS_COMPLETE',
  'SPEC_GENERATING','CLIENT_REVIEW','CLIENT_CHANGES_REQUESTED','CLIENT_APPROVED',
  'SPEC_AUDIT','SPEC_REVISION_REQUIRED','READY_FOR_BUILD','BUILDING','CODE_AUDIT',
  'CODE_REVISION_REQUIRED','TEAM_REVIEW','TEAM_REVISION','PRICE_PENDING',
  'DEADLINE_PENDING','IN_DEVELOPMENT','READY_FOR_DELIVERY','COMPLETED','BLOCKED','FAILED');

-- SPEC §10A : the ONLY requirement status vocabulary in the system
CREATE TYPE requirement_status AS ENUM (
  'EMPTY','UNCLEAR','AI_INFERRED','DEFAULT_PROPOSED','CLIENT_CONFIRMED',
  'CLIENT_APPROVED_DEFAULT','NOT_APPLICABLE');

CREATE TYPE priority_level AS ENUM ('MUST','NICE_TO_HAVE','LATER');
CREATE TYPE agent_type AS ENUM ('REQUIREMENTS','SPECIFICATION','SPEC_AUDITOR','CODING','CODE_CHECKER','TEAM_ASSISTANT');
CREATE TYPE run_status AS ENUM ('QUEUED','RUNNING','SUCCESS','FAILED','NEEDS_REVIEW','CANCELLED');
CREATE TYPE job_status AS ENUM ('PENDING','RUNNING','DONE','FAILED','PARKED','DEAD_LETTER');
CREATE TYPE channel_type AS ENUM ('INSTAGRAM','SIMULATOR','TELEGRAM','WEBCHAT');
CREATE TYPE message_direction AS ENUM ('INBOUND','OUTBOUND');
CREATE TYPE message_status AS ENUM ('RECEIVED','QUEUED','SENT','DELIVERED','READ','FAILED','SEND_BLOCKED');
CREATE TYPE actor_type AS ENUM ('SYSTEM','AI_AGENT','HUMAN','CLIENT');
CREATE TYPE severity AS ENUM ('CRITICAL','MAJOR','MINOR','INFO');
CREATE TYPE task_type AS ENUM ('HUMAN_REVIEW','PRICE_DECISION','DEADLINE_DECISION','CLIENT_SILENT','SCOPE_CHANGE','MANUAL_SEND','DELIVERY_PREP','OTHER');
CREATE TYPE task_status AS ENUM ('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED');
CREATE TYPE event_type AS ENUM (
  'PROJECT_CREATED','STATE_CHANGED','MESSAGE_INBOUND','MESSAGE_OUTBOUND','MESSAGE_SEND_BLOCKED',
  'REQUIREMENTS_COMPLETE','SPEC_GENERATED','SPEC_LOCKED','SPEC_AUDIT_RESULT','BUILD_STARTED','BUILD_FINISHED',
  'CODE_CHECK_RESULT','TASK_CREATED','TASK_STATUS_CHANGED','APPROVAL_RECORDED','CHANGE_REQUEST','AGENT_RUN_FINISHED',
  'HUMAN_ACTION','SECURITY_ALERT','SYSTEM_ERROR','WEBHOOK_RECEIVED','WEBHOOK_DUPLICATE');

-- ---------------------------------------------------------------- identity
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('ADMIN','LEAD','MEMBER','VIEWER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES team_members(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_actions (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES team_members(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- clients & channels
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  display_name TEXT,
  notes TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_identities (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  channel channel_type NOT NULL,
  external_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

CREATE TABLE channel_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  channel channel_type NOT NULL,
  external_account_id TEXT,
  display_name TEXT,
  access_token_enc TEXT,
  token_expires_at timestamptz,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','NEEDS_REAUTH','DISABLED')),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  channel channel_type NOT NULL,
  external_event_id TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error TEXT,
  UNIQUE (channel, external_event_id)
);

-- ---------------------------------------------------------------- conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  connection_id TEXT NOT NULL REFERENCES channel_connections(id),
  channel channel_type NOT NULL,
  external_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ARCHIVED','BLOCKED')),
  last_client_message_at timestamptz,
  last_business_message_at timestamptz,
  window_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_thread_id)
);
CREATE INDEX conversations_window_ix ON conversations (window_expires_at);

CREATE TABLE conversation_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  current_question_field TEXT,
  unanswered_fields TEXT[] NOT NULL DEFAULT '{}',
  pending_default_field TEXT,
  ai_context jsonb NOT NULL DEFAULT '{}',
  requirements_version INT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WAITING_CLIENT','HANDED_OFF','CLOSED')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  conversation_id TEXT REFERENCES conversations(id),
  name TEXT,
  project_type TEXT DEFAULT 'UNKNOWN',
  state project_state NOT NULL DEFAULT 'NEW',
  blocked_from project_state,
  assigned_member_id TEXT REFERENCES team_members(id),
  locked_spec_version_id TEXT,
  current_requirements_version INT NOT NULL DEFAULT 0,
  current_spec_version INT NOT NULL DEFAULT 0,
  current_build_version INT NOT NULL DEFAULT 0,
  complexity_estimate jsonb,
  final_price jsonb,
  final_deadline date,
  delivery_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_state_ix ON projects (state);
CREATE INDEX projects_client_ix ON projects (client_id);

CREATE TABLE project_state_transitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  transition_id TEXT NOT NULL,
  from_state project_state,
  to_state project_state NOT NULL,
  actor_type actor_type NOT NULL,
  actor_id TEXT,
  trigger TEXT NOT NULL,
  reason TEXT,
  context_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pst_project_ix ON project_state_transitions (project_id, created_at);

CREATE TABLE loop_counters (
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT 'attempts',
  value INT NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, scope, key)
);

-- ---------------------------------------------------------------- messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  project_id TEXT REFERENCES projects(id),
  direction message_direction NOT NULL,
  status message_status NOT NULL,
  channel_message_id TEXT,
  client_identity_id TEXT REFERENCES client_identities(id),
  text TEXT,
  attachments jsonb NOT NULL DEFAULT '[]',
  quick_reply_payload TEXT,
  agent_run_id TEXT,
  draft BOOLEAN NOT NULL DEFAULT false,
  human_authored BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  error_detail TEXT,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, channel_message_id)
);
CREATE INDEX messages_conversation_ix ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------- queue & orchestration
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  type TEXT NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  status job_status NOT NULL DEFAULT 'PENDING',
  priority INT NOT NULL DEFAULT 100,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  locked_by TEXT,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error TEXT,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Plain (non-partial) unique index: Postgres treats NULLs as distinct, so jobs without an
-- idempotency key never collide, and `ON CONFLICT (idempotency_key)` can infer this index.
CREATE UNIQUE INDEX jobs_idem_uq ON jobs (idempotency_key);
CREATE INDEX jobs_claim_ix ON jobs (status, run_at, priority);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INT NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status run_status NOT NULL,
  error_code TEXT,
  error_detail TEXT,
  duration_ms INT
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- observability
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  type event_type NOT NULL,
  actor_type actor_type NOT NULL,
  actor_id TEXT,
  payload jsonb NOT NULL DEFAULT '{}',
  severity severity NOT NULL DEFAULT 'INFO',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_project_ix ON events (project_id, created_at DESC);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  conversation_id TEXT REFERENCES conversations(id),
  agent_type agent_type NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  status run_status NOT NULL DEFAULT 'QUEUED',
  input_artifact_id TEXT,
  output_artifact_id TEXT,
  input_summary jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms INT,
  retry_count INT NOT NULL DEFAULT 0,
  repair_count INT NOT NULL DEFAULT 0,
  error_code TEXT,
  error_detail TEXT,
  model TEXT,
  provider TEXT,
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd numeric(10,4),
  next_action TEXT,
  confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_project_ix ON agent_runs (project_id, created_at DESC);

-- ---------------------------------------------------------------- tasks, artifacts, config
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  type task_type NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority severity NOT NULL DEFAULT 'MAJOR',
  reason TEXT NOT NULL,
  ai_report jsonb NOT NULL DEFAULT '{}',
  suggested_action TEXT,
  assignee_member_id TEXT REFERENCES team_members(id),
  status task_status NOT NULL DEFAULT 'OPEN',
  due_at timestamptz,
  closed_by_member_id TEXT,
  closed_at timestamptz,
  created_by_agent_run_id TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_status_ix ON tasks (status, priority);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime TEXT,
  version INT,
  created_by_run_id TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_values (
  key TEXT PRIMARY KEY,
  value jsonb NOT NULL,
  description TEXT,
  updated_by_member_id TEXT REFERENCES team_members(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

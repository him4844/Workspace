-- Phase 4 — Spec Auditor (SPEC §20, §21, §42)
--
-- Every audit leaves a row: which locked/ revised version was audited, which attempt of the §21
-- loop it was, the frozen-contract verdict (status/score/issue buckets/checks) and the
-- deterministic findings that were merged into it. Nothing about a FAIL is lost — the human task
-- after the third failure quotes exactly these rows (§42), and each revision is generated from
-- them, so the loop is auditable after the fact.
--
-- `cycle_key` = the id of the client-approved (LOCKED) version that started the audit cycle. The
-- §21 counter (`loop.spec_audit.max`, default 3) counts attempts inside one cycle: a later client
-- change request starts a NEW cycle, so the revision budget can never accumulate forever.

CREATE TYPE audit_status AS ENUM ('PASS','FAIL');

CREATE TABLE spec_audits (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organizations(id),
  project_id            text NOT NULL REFERENCES projects(id),
  -- the version under audit: the locked approved version (attempt 1) or a revision (attempt n)
  spec_version_id       text NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
  cycle_key             text NOT NULL,               -- spec_version_id of the approved cycle base
  attempt               integer NOT NULL,            -- 1..loop.spec_audit.max
  max_attempts          integer NOT NULL,            -- the ceiling in force when this ran
  status                audit_status NOT NULL,
  score                 integer NOT NULL,
  -- the merged verdict, exactly as `docs/contracts/spec-audit-output.json` shapes it
  verdict               jsonb NOT NULL DEFAULT '{}',
  -- deterministic findings from packages/core (auditSpecStructure) — kept apart from the model's
  structural_findings  jsonb NOT NULL DEFAULT '[]',
  structural_forced_fail boolean NOT NULL DEFAULT false,
  model_failed          boolean NOT NULL DEFAULT false,
  provider              text,
  model                 text,
  agent_run_id          text REFERENCES agent_runs(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX spec_audits_project_ix ON spec_audits (project_id, created_at DESC);
CREATE INDEX spec_audits_cycle_ix ON spec_audits (project_id, cycle_key, attempt);
CREATE INDEX spec_audits_version_ix ON spec_audits (spec_version_id);

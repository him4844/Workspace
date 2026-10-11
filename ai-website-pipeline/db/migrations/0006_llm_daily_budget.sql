-- Phase 0 Q4 / SPEC §26 — hard daily LLM spend cap for any explicitly enabled paid route.
-- Every paid request reserves its worst-case prompt+completion estimate in a per-org/UTC-day row
-- before the provider call. The row update is atomic, so parallel workers cannot both spend the
-- same remaining budget. Settled actual cost replaces the reservation; unknown-price models are
-- refused by the application guard. Free-only routes make no reservations.

CREATE TABLE llm_daily_budgets (
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  utc_day      date NOT NULL,
  reserved_usd numeric(14,6) NOT NULL DEFAULT 0,
  actual_usd   numeric(14,6) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_daily_budgets_org_day_pk PRIMARY KEY (org_id, utc_day)
);

CREATE TABLE llm_budget_reservations (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  utc_day      date NOT NULL,
  provider     text NOT NULL,
  model        text NOT NULL,
  reserved_usd numeric(14,6) NOT NULL,
  actual_usd   numeric(14,6),
  status       text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','SETTLED','RELEASED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz
);
CREATE INDEX llm_budget_reservations_day_status_ix ON llm_budget_reservations (org_id, utc_day, status);

-- Carry forward historical usage into the daily cap ledger before the new guard takes over.
INSERT INTO llm_daily_budgets (org_id, utc_day, actual_usd)
SELECT org_id, (created_at AT TIME ZONE 'UTC')::date, COALESCE(SUM(cost_usd), 0)
FROM llm_usage
WHERE cost_usd IS NOT NULL
GROUP BY org_id, (created_at AT TIME ZONE 'UTC')::date;

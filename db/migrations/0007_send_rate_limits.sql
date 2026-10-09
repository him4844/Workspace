-- Phase 1 — enforce SEND_RATE_PER_MINUTE per Instagram connection, not just in configuration.
CREATE TABLE send_rate_limits (
  connection_id text PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

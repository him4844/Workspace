-- Phase 4 — reasoning effort per agent config (SPEC §50 "thresholds/settings are data")
--
-- Measured on the free tier (2026-10-08): Gemini 3.x spends a hidden reasoning budget from the SAME
-- completion cap, so a 4 KB JSON answer came back truncated (finish_reason=length, 146 visible
-- chars) until the cap was raised. Reasoning-heavy agents therefore declare their effort explicitly;
-- the value is only ever sent to providers that accept `reasoning_effort`.

ALTER TABLE agent_config_versions ADD COLUMN reasoning_effort text;

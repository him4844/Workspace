# config/

Configuration **data** (SPEC §50) — seeded into the database, versioned here for review:

- `questionnaires/` — GENERAL questionnaire + website-type packages (RESTAURANT, ECOMMERCE, EDUCATION, LANDING_PAGE, CORPORATE). Added in Phase 2; new packages must be addable without touching agent code (§7).
- `agent-configs/` — seed definitions for `agent_config_versions` (system instructions, model, schema refs). Added in Phase 2.
- `defaults.json` — default `config_values` (loop limits, window thresholds, caps).

Populated phase by phase; nothing here is hard-coded in application logic.

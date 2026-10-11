# apps/worker — orchestrator + agents

Claims jobs (`FOR UPDATE SKIP LOCKED`), enforces state-machine guards, runs agent handlers, applies loop caps, retries, timers (inactivity, token refresh, watchdog).
Agents never transition state; the orchestrator does. Implemented from Phase 1, agents from Phase 2.

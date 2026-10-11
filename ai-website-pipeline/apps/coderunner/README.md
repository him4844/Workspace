# apps/coderunner — builds + runtime verification

Materializes coding-agent output into a capped workspace, runs install/build/test, starts the app, then Playwright checks (E2E, responsive, links/console, a11y, security) with evidence capture (SPEC §25A).
Runs with no secrets mounted. Implemented in Phases 5–6.

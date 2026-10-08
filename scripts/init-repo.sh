#!/bin/sh
# Initialize a fresh clone of this repository for the team.
set -e
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init
git config user.name "$(git config user.name || echo 'WPP Team')"
git config user.email "$(git config user.email || echo 'team@example.com')"
echo "hooks: none installed yet"
[ -f .env ] || cp .env.example .env
echo "OK. Next: read PHASE_REPORTS/phase0.md, then docs/13_mvp_plan.md."

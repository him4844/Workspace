#!/usr/bin/env node
// Phase 0 docs integrity check: required files exist, contracts are valid JSON.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const required = [
  'SPEC.md','README.md','DECISIONS.md',
  'PHASE_REPORTS/phase0.md',
  'docs/01_system_architecture.md','docs/02_component_architecture.md','docs/03_database_schema.md',
  'docs/04_entity_relationships.md','docs/05_state_machine.md','docs/06_agent_architecture.md',
  'docs/07_api_structure.md','docs/08_instagram_integration.md','docs/09_team_panel_architecture.md',
  'docs/10_security_architecture.md','docs/11_folder_structure.md','docs/12_environment_variables.md',
  'docs/13_mvp_plan.md','docs/14_testing_strategy.md','docs/15_deployment_strategy.md',
  'docs/16_known_risks.md','docs/17_open_questions.md','docs/18_stack_proposal.md',
  'docs/19_meta_platform_findings.md'
];
let fail = 0;
for (const f of required) {
  if (!existsSync(f)) { console.error('MISSING:', f); fail++; }
}
const dir = 'docs/contracts';
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  try { JSON.parse(readFileSync(join(dir, f), 'utf8')); }
  catch (e) { console.error('INVALID JSON:', f, e.message); fail++; }
}
console.log(fail === 0 ? `OK: ${required.length} docs present, contracts valid JSON` : `${fail} problem(s)`);
process.exit(fail === 0 ? 0 : 1);

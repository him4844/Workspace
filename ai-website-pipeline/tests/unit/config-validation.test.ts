/**
 * Config-as-data validation (SPEC §7, §50–§51).
 *
 * `config/` is the reviewable source of truth for questionnaires, agent configs and tunables.
 * A typo in these files must fail the test suite, not the conversation, so every structural
 * rule the runtime relies on is checked here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  MANDATORY_CATEGORIES, mergeQuestionnaires, validateQuestionnaire,
  type QuestionnaireDefinition,
} from '@wpp/core';
import { seedConfigFromFiles } from '@wpp/db';
import { orgRepo } from '@wpp/db';
import { createTestContext, type TestContext } from '../helpers/context.js';

const CONFIG_DIR = 'config';
const QUESTIONNAIRE_DIR = join(CONFIG_DIR, 'questionnaires');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

let ctx: TestContext;
let general: QuestionnaireDefinition;
let packages: QuestionnaireDefinition[];

beforeAll(async () => {
  general = readJson<QuestionnaireDefinition>(join(QUESTIONNAIRE_DIR, 'GENERAL.json'));
  packages = readdirSync(QUESTIONNAIRE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'GENERAL.json')
    .map((f) => readJson<QuestionnaireDefinition>(join(QUESTIONNAIRE_DIR, f)));
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe('questionnaire files (§6, §7)', () => {
  it('every questionnaire passes structural validation', () => {
    expect(validateQuestionnaire(general)).toEqual([]);
    for (const pkg of packages) {
      expect(validateQuestionnaire(pkg), pkg.code).toEqual([]);
    }
    expect(packages.length).toBeGreaterThanOrEqual(5);
  });

  it('GENERAL covers all 18 mandatory §6 categories with mandatory fields', () => {
    const mandatoryCategories = new Set(general.fields.filter((f) => f.mandatory).map((f) => f.category));
    const missing = MANDATORY_CATEGORIES.filter((c) => !mandatoryCategories.has(c));
    expect(missing).toEqual([]);
  });

  it('question text stays DM-sized and quick replies respect the contract limits', () => {
    for (const def of [general, ...packages]) {
      for (const field of def.fields) {
        expect(field.question.length, `${def.code}:${field.path}`).toBeLessThanOrEqual(300);
        expect(field.quickReplies?.length ?? 0, `${def.code}:${field.path}`).toBeLessThanOrEqual(13);
        for (const reply of field.quickReplies ?? []) {
          expect(reply.length, `${def.code}:${field.path}`).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it('every dependsOn points at a real field of the merged questionnaire (no dead gates)', () => {
    for (const pkg of packages) {
      const merged = mergeQuestionnaires(general, [pkg]);
      const known = new Set(merged.fields.map((f) => f.path));
      for (const field of merged.fields) {
        for (const depPath of Object.keys(field.dependsOn ?? {})) {
          expect(known.has(depPath), `${pkg.code}: ${field.path} depends on unknown ${depPath}`).toBe(true);
        }
      }
    }
  });

  it('a package never shadows GENERAL (merge precedence §7)', () => {
    for (const pkg of packages) {
      const merged = mergeQuestionnaires(general, [pkg]);
      const generalByPath = new Map(general.fields.map((f) => [f.path, f]));
      for (const field of pkg.fields) {
        const winner = merged.fields.find((f) => f.path === field.path);
        const template = generalByPath.get(field.path);
        if (template) expect(winner).toEqual(template);
      }
    }
  });
});

describe('agent configs and tunables (§50, §51)', () => {
  it('the REQUIREMENTS agent config is complete and safe', () => {
    const agents = readJson<{ agents: Array<Record<string, unknown>> }>(join(CONFIG_DIR, 'agent-configs', 'agents.json'));
    const requirements = agents.agents.find((a) => a.agentType === 'REQUIREMENTS');
    expect(requirements, 'REQUIREMENTS agent config missing').toBeTruthy();
    for (const key of ['systemInstructions', 'defaultModel', 'modelEnv', 'maxOutputTokens', 'timeoutMs', 'temperature']) {
      expect(requirements![key], key).toBeTruthy();
    }
    const instructions = String(requirements!.systemInstructions);
    expect(instructions).toContain('JSON');
    expect(instructions.length).toBeGreaterThan(200);
    expect(Number(requirements!.maxOutputTokens)).toBeLessThanOrEqual(4000);
    expect(Number(requirements!.timeoutMs)).toBeLessThanOrEqual(120_000);
  });

  it('every tunable the runtime reads is present in defaults.json', () => {
    const defaults = readJson<{ values: Array<{ key: string; value: unknown }> }>(join(CONFIG_DIR, 'defaults.json'));
    const keys = new Set(defaults.values.map((v) => v.key));
    for (const required of [
      'loop.requirements.max_questions',
      'loop.requirements.max_clarifications_per_field',
      'requirements.min_question_interval_seconds',
      'requirements.complete_message',
      'requirements.inactivity_reminder_hours',
      'requirements.inactivity_max_reminders',
    ]) {
      expect(keys.has(required), required).toBe(true);
    }
    const maxQuestions = defaults.values.find((v) => v.key === 'loop.requirements.max_questions')!.value;
    expect(Number(maxQuestions)).toBeGreaterThan(0);
    expect(Number(maxQuestions)).toBeLessThanOrEqual(200);
  });
});

describe('seeding round-trip (§11 §2.4)', () => {
  it('seeds every questionnaire and agent config from the files without problems', async () => {
    const orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const report = await seedConfigFromFiles(ctx.handle.db, orgId, { configDir: CONFIG_DIR, env: {} });
    expect(report.questionnaireProblems).toEqual([]);
    const seededCodes = report.questionnaires.map((q) => q.split(' ')[0]);
    expect(seededCodes).toContain('GENERAL');
    for (const pkg of packages) expect(seededCodes, pkg.code).toContain(pkg.code);
    expect(report.agentConfigs.join(' ')).toContain('REQUIREMENTS');
    expect(report.configValues).toBeGreaterThanOrEqual(6);
  });

  it('re-seeding is idempotent (no duplicate questionnaires or runaway config versions)', async () => {
    const orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const first = await seedConfigFromFiles(ctx.handle.db, orgId, { configDir: CONFIG_DIR, env: {} });
    const second = await seedConfigFromFiles(ctx.handle.db, orgId, { configDir: CONFIG_DIR, env: {} });
    expect([...second.questionnaires].sort()).toEqual([...first.questionnaires].sort());

    const { listQuestionnaireDefinitions, agentConfigRepo } = await import('@wpp/db');
    const defs = await listQuestionnaireDefinitions(ctx.handle.db);
    for (const code of first.questionnaires.map((q) => q.split(' ')[0])) {
      expect(defs.filter((d) => d.code === code), code).toHaveLength(1);
    }
    const active = await agentConfigRepo.getActiveAgentConfig(ctx.handle.db, orgId, 'REQUIREMENTS');
    expect(active, 'REQUIREMENTS agent config must be active after seeding').toBeTruthy();
  });
});

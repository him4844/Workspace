import { describe, expect, it } from 'vitest';
import {
  canCompleteRequirements, computeCompleteness, dependencySatisfied, detectVagueAnswer,
  mergeQuestionnaires, MANDATORY_CATEGORIES, planFieldUpdates, planNextQuestion,
  validateQuestionnaire,
  type QuestionnaireDefinition, type RequirementFieldState,
} from '@wpp/core';

const general: QuestionnaireDefinition = {
  schemaVersion: '1.0.0',
  code: 'GENERAL',
  version: 1,
  type: 'GENERAL',
  title: 'General',
  vagueLexicon: ['zamonaviy', 'modern'],
  fields: [
    { path: 'business_purpose.purpose', category: 'business_purpose', question: 'Maqsad nima?', mandatory: true, order: 10 },
    { path: 'pages.list', category: 'pages', question: 'Qanday sahifalar?', mandatory: true, order: 20 },
    { path: 'authentication.needed', category: 'authentication', question: 'Login kerakmi?', mandatory: true, order: 30, valueType: 'choice', options: ['yes', 'no'] },
    { path: 'authentication.methods', category: 'authentication', question: 'Qanday usul?', mandatory: false, order: 31, dependsOn: { 'authentication.needed': ['yes'] } },
  ],
  ...Object.fromEntries(MANDATORY_CATEGORIES.map((c) => [c, true])),
};

// the mandatory-category coverage check only looks at categories, so fill the rest explicitly
const generalFull: QuestionnaireDefinition = {
  ...general,
  fields: [
    ...general.fields,
    ...MANDATORY_CATEGORIES
      .filter((c) => !['business_purpose', 'pages', 'authentication'].includes(c))
      .map((c, i) => ({ path: `${c}.main`, category: c, question: `${c} bo‘yicha savol?`, mandatory: true, order: 100 + i })),
  ],
};

const restaurantPackage: QuestionnaireDefinition = {
  schemaVersion: '1.0.0',
  code: 'RESTAURANT',
  version: 1,
  type: 'PACKAGE',
  appliesToProjectType: 'RESTAURANT',
  title: 'Restoran',
  fields: [
    { path: 'reservations.enabled', category: 'features', question: 'Bron kerakmi?', mandatory: true, order: 40 },
    { path: 'pages.list', category: 'pages', question: 'Package override (must lose)', mandatory: false, order: 5 },
  ],
};

function field(path: string, status: RequirementFieldState['status'], mandatory = true, value: unknown = null): RequirementFieldState {
  return { fieldPath: path, category: path.split('.')[0]!, value, status, priority: 'MUST', mandatory };
}

describe('questionnaires as data (§7, §50)', () => {
  it('accepts a GENERAL questionnaire that covers the 18 mandatory categories', () => {
    expect(validateQuestionnaire(generalFull)).toEqual([]);
  });

  it('reports every missing mandatory category', () => {
    const problems = validateQuestionnaire({ ...generalFull, fields: generalFull.fields.filter((f) => f.category !== 'payments') });
    expect(problems).toContain('mandatory category missing: payments');
  });

  it('GENERAL wins over a package on the same path and keeps template order', () => {
    const merged = mergeQuestionnaires(generalFull, [restaurantPackage]);
    const pages = merged.fields.filter((f) => f.path === 'pages.list');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.question).toBe('Qanday sahifalar?');
    expect(merged.fields.some((f) => f.path === 'reservations.enabled')).toBe(true);
    expect(merged.vagueLexicon).toContain('zamonaviy');
  });
});

describe('completeness engine (§10, §10A)', () => {
  const fields: RequirementFieldState[] = [
    field('a.one', 'CLIENT_CONFIRMED'),
    field('a.two', 'EMPTY'),
    field('a.three', 'AI_INFERRED'),
    field('a.four', 'NOT_APPLICABLE'),
    field('b.optional', 'EMPTY', false),
  ];

  it('counts only CLIENT_CONFIRMED / CLIENT_APPROVED_DEFAULT / NOT_APPLICABLE', () => {
    const report = computeCompleteness({ fields, contradictions: [] });
    expect(report.totalMandatory).toBe(4);
    expect(report.completeMandatory).toBe(2);
    expect(report.score).toBe(0.5);
    expect(report.blockingFields).toEqual(['a.two', 'a.three']);
    expect(report.readyForSummary).toBe(false);
  });

  it('an open contradiction blocks completion even with all fields complete', () => {
    const report = computeCompleteness({
      fields: [field('a.one', 'CLIENT_CONFIRMED'), field('a.two', 'CLIENT_APPROVED_DEFAULT')],
      contradictions: [{ fieldA: 'design.style', fieldB: 'features.core', severity: 'MAJOR', status: 'OPEN' }],
    });
    expect(report.openContradictions).toBe(1);
    expect(report.readyForSummary).toBe(false);
    expect(canCompleteRequirements(report)).toBe(false);
  });

  it('UNCLEAR mandatory fields are critical ambiguities', () => {
    const report = computeCompleteness({ fields: [field('design.style', 'UNCLEAR')], contradictions: [] });
    expect(report.criticalAmbiguities).toEqual(['design.style']);
  });

  it('completes only with the internal summary present (§10 condition 4)', () => {
    const ready = computeCompleteness({ fields: [field('a.one', 'CLIENT_CONFIRMED')], contradictions: [] });
    expect(ready.readyForSummary).toBe(true);
    expect(ready.complete).toBe(false);
    const done = computeCompleteness({ fields: [field('a.one', 'CLIENT_CONFIRMED')], contradictions: [], hasInternalSummary: true });
    expect(done.complete).toBe(true);
  });
});

describe('question planner (§5.1, §6, §8)', () => {
  const limits = { maxQuestions: 40, maxClarificationsPerField: 2 };
  const baseCounters = { questionsAsked: 0, clarificationsByField: {} };

  it('asks the first mandatory field in template order', () => {
    const plan = planNextQuestion({
      questionnaire: generalFull,
      fields: [],
      contradictions: [],
      counters: baseCounters,
      limits,
    });
    expect(plan).toMatchObject({ kind: 'ASK', fieldPath: 'business_purpose.purpose', reason: 'NEXT_MANDATORY' });
  });

  it('a contradiction outranks everything else (§8B)', () => {
    const plan = planNextQuestion({
      questionnaire: generalFull,
      fields: [field('design.style', 'CLIENT_CONFIRMED')],
      contradictions: [{ fieldA: 'design.style', fieldB: 'features.core', severity: 'MAJOR', status: 'OPEN' }],
      counters: baseCounters,
      limits,
    });
    expect(plan).toMatchObject({ kind: 'ASK', fieldPath: 'features.core', reason: 'CONTRADICTION' });
  });

  it('a vague answer is clarified while budget remains, then left alone (§8A)', () => {
    const fields = [field('business_purpose.purpose', 'CLIENT_CONFIRMED'), field('design.style', 'UNCLEAR')];
    const first = planNextQuestion({ questionnaire: generalFull, fields, contradictions: [], counters: baseCounters, limits });
    expect(first).toMatchObject({ kind: 'ASK', fieldPath: 'design.style', reason: 'CLARIFY_VAGUE' });

    const exhausted = planNextQuestion({
      questionnaire: generalFull,
      fields,
      contradictions: [],
      counters: { questionsAsked: 3, clarificationsByField: { 'design.style': 2 } },
      limits,
    });
    expect(exhausted.kind === 'ASK' ? exhausted.fieldPath : null).not.toBe('design.style');
  });

  it('DEFAULT_PROPOSED is followed up so §11 never leaves a default hanging', () => {
    const plan = planNextQuestion({
      questionnaire: generalFull,
      fields: [field('payments.needed', 'DEFAULT_PROPOSED')],
      contradictions: [],
      counters: baseCounters,
      limits,
    });
    expect(plan).toMatchObject({ kind: 'ASK', fieldPath: 'payments.needed', reason: 'CONFIRM_DEFAULT' });
  });

  it('AI_INFERRED must be confirmed by the client before it can count (§53)', () => {
    const plan = planNextQuestion({
      questionnaire: generalFull,
      fields: [field('pages.list', 'AI_INFERRED')],
      contradictions: [],
      counters: baseCounters,
      limits,
    });
    expect(plan).toMatchObject({ kind: 'ASK', fieldPath: 'pages.list', reason: 'CONFIRM_INFERRED' });
  });

  it('stops at the question cap (§10 limit, no infinite loop)', () => {
    const plan = planNextQuestion({
      questionnaire: generalFull,
      fields: [field('pages.list', 'EMPTY')],
      contradictions: [],
      counters: { questionsAsked: 40, clarificationsByField: {} },
      limits,
    });
    expect(plan).toEqual({ kind: 'STOP', reason: 'MAX_QUESTIONS' });
  });

  it('reports COMPLETE when nothing is left', () => {
    const fields = generalFull.fields.map((f) => field(f.path, 'NOT_APPLICABLE', f.mandatory));
    const plan = planNextQuestion({ questionnaire: generalFull, fields, contradictions: [], counters: baseCounters, limits });
    expect(plan).toEqual({ kind: 'STOP', reason: 'COMPLETE' });
  });

  it('honours dependsOn for dependency follow-ups (§8D)', () => {
    const before = dependencySatisfied(
      { path: 'authentication.methods', category: 'authentication', question: 'q', mandatory: false, dependsOn: { 'authentication.needed': ['yes'] } },
      new Map([['authentication.needed', field('authentication.needed', 'CLIENT_CONFIRMED', true, 'no')]]),
    );
    expect(before).toBe(false);
    const after = dependencySatisfied(
      { path: 'authentication.methods', category: 'authentication', question: 'q', mandatory: false, dependsOn: { 'authentication.needed': ['yes'] } },
      new Map([['authentication.needed', field('authentication.needed', 'CLIENT_CONFIRMED', true, 'yes')]]),
    );
    expect(after).toBe(true);
  });
});

describe('vague answer detection (§8A)', () => {
  it('flags single vague words and short non-answers', () => {
    expect(detectVagueAnswer('zamonaviy', ['zamonaviy'])).toBe(true);
    expect(detectVagueAnswer('shunchaki zamonaviy va chiroyli', ['zamonaviy', 'chiroyli'])).toBe(true);
    expect(detectVagueAnswer('yaxshi', ['zamonaviy'])).toBe(true);
  });

  it('does not flag concrete answers', () => {
    expect(detectVagueAnswer('Yorug‘ fon, oq va to‘q sariq, minimal uslub, menyu rasmlari katta', ['zamonaviy'])).toBe(false);
    expect(detectVagueAnswer('5 sahifa: bosh, menyu, filiallar, aloqa', [])).toBe(false);
  });
});

describe('field update rules (§10A, §53)', () => {
  const current = new Map([
    ['design.style', field('design.style', 'CLIENT_CONFIRMED', true, 'minimal')],
  ]);
  const validIds = new Set(['msg-1']);

  it('accepts a client-truth update that references a real inbound message', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'pages.list', value: ['home'], status: 'CLIENT_CONFIRMED', sourceMessageId: 'msg-1' }],
      { current, knownPaths: new Set(['pages.list']), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected).toHaveLength(0);
  });

  it('rejects CLIENT_CONFIRMED with an unknown message id (§10A)', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'pages.list', status: 'CLIENT_CONFIRMED', sourceMessageId: 'not-a-message' }],
      { current, knownPaths: new Set(), validSourceMessageIds: validIds, currentInboundMessageId: null },
    );
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected[0]!.code).toBe('CLIENT_TRUTH_NEEDS_SOURCE');
  });

  it('falls back to the turn message when the model forgets the reference', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'pages.list', status: 'CLIENT_CONFIRMED' }],
      { current, knownPaths: new Set(), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.accepted[0]!.sourceMessageId).toBe('msg-1');
  });

  it('never lets an AI inference silently overwrite client truth (§53)', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'design.style', value: 'neon', status: 'AI_INFERRED' }],
      { current, knownPaths: new Set(), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected[0]!.code).toBe('DOWNGRADE_NEEDS_NOTE');
  });

  it('allows a documented downgrade', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'design.style', value: 'neon', status: 'UNCLEAR', note: 'client contradicted themselves' }],
      { current, knownPaths: new Set(), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]!.downgrade).toBe(true);
  });

  it('records unknown paths instead of silently dropping them', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'loyalty.program', value: true, status: 'CLIENT_CONFIRMED', sourceMessageId: 'msg-1' }],
      { current, knownPaths: new Set(['pages.list']), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.newPaths).toEqual(['loyalty.program']);
  });

  it('rejects invalid statuses outright', () => {
    const plan = planFieldUpdates(
      [{ fieldPath: 'pages.list', status: 'CONFIRMED' as never }],
      { current, knownPaths: new Set(), validSourceMessageIds: validIds, currentInboundMessageId: 'msg-1' },
    );
    expect(plan.rejected[0]!.code).toBe('INVALID_STATUS');
  });
});

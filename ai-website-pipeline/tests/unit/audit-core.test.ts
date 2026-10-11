/**
 * Spec-audit core (SPEC §20/§21): the deterministic half of the auditor.
 *
 * These tests pin the rules that must hold no matter which model audits a specification: a missing
 * confirmed requirement, a vague criterion, a summary that names an unknown page or a blocking open
 * question force a FAIL — the model cannot vote them away — and the §21 loop budget is monotonic, so
 * the revision loop can never run forever.
 */
import { describe, expect, it } from 'vitest';
import {
  auditSpecStructure, explainAuditBlock, findVagueTerms, isUnmeasurable, mergeAuditVerdict,
  nextAttemptAllowed, shouldBlockAfterFailure,
  type RequirementFieldInput, type SpecAuditOutput, type SpecDocument,
} from '@wpp/core';

const field = (
  fieldPath: string,
  value: unknown,
  status: RequirementFieldInput['status'] = 'CLIENT_CONFIRMED',
): RequirementFieldInput => ({
  fieldPath, value, status, priority: 'MUST', mandatory: true, category: null, sourceMessageId: 'm1',
});

const specWith = (overrides: Partial<SpecDocument> = {}): SpecDocument => ({
  meta: { projectType: 'RESTAURANT', generatedFromRequirementsVersion: 1, sectionsIncluded: [], sectionsOmitted: [] },
  overview: 'Restaurant site',
  businessGoals: [],
  targetUsers: [],
  sitemap: ['Bosh sahifa', 'Menyu'],
  pages: [{ name: 'Bosh sahifa', purpose: 'Show the restaurant' }],
  requirements: [
    {
      code: 'SPEC-REQ-001', originReqField: 'business_purpose.purpose', section: 'Overview',
      title: 'Purpose', description: 'The site presents the restaurant purpose to visitors.',
      priority: 'MUST',
      acceptanceCriteria: [{ code: 'AC-001', text: 'Bosh sahifa shows the restaurant name and working hours', testable: true, verificationHint: 'E2E' }],
    },
  ],
  nonFunctional: null,
  integrations: [],
  databaseNotes: null,
  deploymentRequirements: null,
  definitionOfDone: [],
  knownAssumptions: [],
  openQuestions: [],
  futureScope: [],
  ...overrides,
});

const summary = (markdown: string) => ({ markdown, assumptionsShown: [] });

/** A client summary that structurally agrees with `specWith()`. */
const goodSummary = summary('## Maqsad\nRestoran sayti\n\n## Sahifalar\n- Bosh sahifa\n\n## Funksiyalar\n- Purpose\n\n## Dizayn\nYorug‘');

const llmPass = (score = 92): SpecAuditOutput => ({
  status: 'PASS', score,
  criticalIssues: [], warnings: [], missingRequirements: [], contradictions: [], ambiguities: [],
  recommendations: [],
  checks: { completeness: 'PASS', consistency: 'PASS', ambiguity: 'PASS', codingReadiness: 'PASS', clientAlignment: 'PASS' },
});

const cleanStructure = () => auditSpecStructure({ spec: specWith(), summary: goodSummary, fields: [field('business_purpose.purpose', 'show the restaurant')] });

describe('ambiguity detection (§20)', () => {
  it('finds the vague words §20 names, in the languages clients actually use', () => {
    expect(findVagueTerms('The design must be beautiful and modern')).toEqual(['beautiful', 'modern']);
    expect(findVagueTerms('Sayt tez va qulay bo‘lishi kerak')).toEqual(['fast', 'user-friendly']);
    expect(findVagueTerms('Сайт должен быть современным')).toEqual(['modern']);
  });

  it('accepts a vague word once it carries something measurable', () => {
    expect(isUnmeasurable('The site must be fast')).toBe(true);
    expect(isUnmeasurable('The site must be fast: every page under 200 ms on 3G')).toBe(false);
    expect(isUnmeasurable('Design uses the colours #c1440e and #fff')).toBe(false);
  });
});

describe('structural audit (§20 completeness / consistency / readiness / alignment)', () => {
  it('a complete, traceable, measurable specification has no findings', () => {
    const audit = cleanStructure();
    expect(audit.findings).toEqual([]);
    expect(audit.worst).toBeNull();
    expect(audit.scoreCap).toBe(100);
  });

  it('a confirmed client field with no specification entry is a CRITICAL completeness gap', () => {
    const audit = auditSpecStructure({
      spec: specWith(), summary: goodSummary,
      fields: [field('business_purpose.purpose', 'show the restaurant'), field('payments.needed', 'yes')],
    });
    const gap = audit.findings.find((f) => f.code === 'MISSING_SPEC_REQ');
    expect(gap?.category).toBe('COMPLETENESS');
    expect(gap?.severity).toBe('CRITICAL');
    expect(gap?.suggestedFix).toContain('payments.needed');
    expect(audit.worst).toBe('CRITICAL');
    expect(audit.scoreCap).toBe(30);
  });

  it("flags §20's vague-word example as a MAJOR ambiguity finding, naming the requirement", () => {
    const vague = specWith({
      requirements: [{
        code: 'SPEC-REQ-001', originReqField: 'business_purpose.purpose', section: 'UI/UX Requirements', title: 'Hero design',
        description: 'The design must be beautiful', priority: 'MUST',
        acceptanceCriteria: [{ code: 'AC-001', text: 'The design looks beautiful', testable: true, verificationHint: 'VISUAL' }],
      }],
    });
    const audit = auditSpecStructure({
      spec: vague,
      summary: summary('## Maqsad\nRestoran sayti\n\n## Sahifalar\n- Bosh sahifa\n\n## Funksiyalar\n- Hero design\n\n## Dizayn\nChiroyli'),
      fields: [field('business_purpose.purpose', 'show the restaurant')],
    });
    const ambiguity = audit.findings.find((f) => f.code === 'AMBIGUOUS_REQUIREMENT');
    expect(ambiguity?.severity).toBe('MAJOR');
    expect(ambiguity?.category).toBe('AMBIGUITY');
    expect(ambiguity?.specRequirementCode).toBe('SPEC-REQ-001');
    expect(ambiguity?.description).toContain('"beautiful"');
    expect(audit.scoreCap).toBe(60);
  });

  it('an empty specification is CRITICAL, not "score 0 but PASS"', () => {
    const audit = auditSpecStructure({
      spec: specWith({ requirements: [], pages: [] }),
      summary: summary('## Maqsad\nRestoran\n\n## Sahifalar\n-\n\n## Funksiyalar\n-\n\n## Dizayn\n-'),
      fields: [],
    });
    expect(audit.findings.some((f) => f.code === 'SPEC_HAS_NO_REQUIREMENTS' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('a blocking open question blocks coding readiness (§20)', () => {
    const audit = auditSpecStructure({
      spec: specWith({ openQuestions: [{ question: 'Which payment provider?', blocking: true }] }),
      summary: goodSummary,
      fields: [field('business_purpose.purpose', 'show the restaurant')],
    });
    const finding = audit.findings.find((f) => f.code === 'BLOCKING_OPEN_QUESTION');
    expect(finding?.severity).toBe('MAJOR');
    expect(finding?.category).toBe('CODING_READINESS');
    expect(finding?.description).toContain('Which payment provider?');
  });

  it('a summary naming a page the spec does not contain is a client-alignment CRITICAL (§19/§20)', () => {
    const audit = auditSpecStructure({
      spec: specWith(),
      summary: summary('## Maqsad\nRestoran sayti\n\n## Sahifalar\n- Bosh sahifa\n\n## Funksiyalar\n- Purpose\n\n## Dizayn\nYorug‘\nXarita sahifasi ham bor'),
      fields: [field('business_purpose.purpose', 'show the restaurant')],
    });
    const finding = audit.findings.find((f) => f.category === 'CLIENT_ALIGNMENT');
    expect(finding?.severity).toBe('CRITICAL');
    expect(finding?.code).toBe('SUMMARY_MENTIONS_UNKNOWN_PAGE');
  });
});

describe('verdict merging (§20/§21)', () => {
  it('a model PASS cannot override a structural CRITICAL — the score is capped and the check flips', () => {
    const structural = auditSpecStructure({
      spec: specWith(), summary: goodSummary,
      fields: [field('business_purpose.purpose', 'x'), field('payments.needed', 'yes')],
    });
    const merged = mergeAuditVerdict(structural, llmPass(95));
    expect(merged.status).toBe('FAIL');
    expect(merged.structuralForcedFail).toBe(true);
    expect(merged.modelFailed).toBe(false);
    expect(merged.score).toBe(30);
    expect(merged.checks.completeness).toBe('FAIL');
    // the structural gap is quoted in the bucket a revision prompt and a human task read
    expect(merged.missingRequirements.map((i) => i.code)).toContain('MISSING_SPEC_REQ');
    expect(merged.allIssues.length).toBeGreaterThan(0);
  });

  it('a model FAIL stands even when the structure looks clean', () => {
    const merged = mergeAuditVerdict(cleanStructure(), {
      ...llmPass(40), status: 'FAIL',
      criticalIssues: [{ code: 'MISSING_PAYMENT_PROVIDER', severity: 'CRITICAL', description: 'payment step required but no provider selected', suggestedFix: 'pick Payme/Click/Stripe or scope payments out' }],
      checks: { completeness: 'FAIL', consistency: 'PASS', ambiguity: 'PASS', codingReadiness: 'FAIL', clientAlignment: 'PASS' },
    });
    expect(merged.status).toBe('FAIL');
    expect(merged.structuralForcedFail).toBe(false);
    expect(merged.modelFailed).toBe(true);
    expect(merged.criticalIssues[0]?.code).toBe('MISSING_PAYMENT_PROVIDER');
    expect(merged.checks.codingReadiness).toBe('FAIL');
  });

  it('a clean structure and a model PASS pass, with the score clamped to 0..100 and no duplicate issues', () => {
    const structural = cleanStructure();
    expect(mergeAuditVerdict(structural, llmPass(97)).status).toBe('PASS');
    expect(mergeAuditVerdict(structural, llmPass(140)).score).toBe(100);

    const sameIssue = { code: 'X', severity: 'MAJOR' as const, description: 'same wording' };
    const merged = mergeAuditVerdict(structural, { ...llmPass(80), warnings: [sameIssue, { ...sameIssue }] });
    expect(merged.warnings).toHaveLength(1);
  });
});

describe('loop budget (§21 — no infinite loops)', () => {
  it('revision is allowed while attempts stay under the ceiling', () => {
    expect(nextAttemptAllowed({ attempt: 1, maxAttempts: 3 })).toBe(true);
    expect(nextAttemptAllowed({ attempt: 2, maxAttempts: 3 })).toBe(true);
    expect(nextAttemptAllowed({ attempt: 3, maxAttempts: 3 })).toBe(false);
  });

  it('the ceiling blocks the project instead of revising again', () => {
    expect(shouldBlockAfterFailure({ attempt: 2, maxAttempts: 3 })).toBe(false);
    expect(shouldBlockAfterFailure({ attempt: 3, maxAttempts: 3 })).toBe(true);
    expect(shouldBlockAfterFailure({ attempt: 4, maxAttempts: 3 })).toBe(true);
  });

  it('the block explanation tells a human WHY and quotes the exact unresolved issues (§21/§42)', () => {
    const text = explainAuditBlock(
      [{ code: 'AMBIGUOUS_REQUIREMENT', severity: 'MAJOR', description: 'SPEC-REQ-004 uses "fast" with nothing measurable', suggestedFix: 'add a page-load budget' }],
      { attempt: 3, maxAttempts: 3 },
    );
    expect(text).toContain('limit 3');
    expect(text).toContain('AMBIGUOUS_REQUIREMENT');
    expect(text).toContain('add a page-load budget');
    expect(text).toContain('A human must decide');
  });
});

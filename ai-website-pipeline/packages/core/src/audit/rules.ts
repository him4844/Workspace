/**
 * Spec-audit rules (SPEC §20, §21) — the deterministic half of the Spec Auditor.
 *
 * §20 asks the auditor for five things: completeness, consistency, ambiguity, coding readiness and
 * client alignment. Anything a rule can decide is decided HERE, reproducibly and for free; the LLM
 * auditor adds judgement on top (and receives these findings as facts, so it does not waste
 * reasoning re-discovering them). A single CRITICAL or MAJOR structural finding makes the audit FAIL
 * no matter what the model says — the same "model writes, core audits" split as Phase 3 (D-031).
 *
 * The output shape is the FROZEN contract `docs/contracts/spec-audit-output.json` (Phase-0
 * deliverable): `status`, `score`, the five issue buckets, `recommendations` and the per-dimension
 * `checks` — issue objects are `{code, severity, description, specSection?, specRequirementCode?,
 * suggestedFix?}`, so a revision prompt and a human task can both quote them verbatim.
 */
import type { ClientSummary, RequirementFieldInput, SpecDocument, SpecRequirement } from '../spec/traceability.js';
import { auditTraceability } from '../spec/traceability.js';
import { auditSummaryConsistency } from '../spec/rules.js';

export type AuditSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export type AuditCategory = 'COMPLETENESS' | 'CONSISTENCY' | 'AMBIGUITY' | 'CODING_READINESS' | 'CLIENT_ALIGNMENT';
export type AuditCheckState = 'PASS' | 'FAIL';

/** One issue, exactly as the frozen contract defines `$defs/issue`. */
export interface AuditIssue {
  code: string;
  severity: AuditSeverity;
  description: string;
  specSection?: string | null;
  specRequirementCode?: string | null;
  suggestedFix?: string | null;
}

/** Explicit per-dimension results — "the auditor is NOT a grammar checker" (§20). */
export interface AuditChecks {
  completeness: AuditCheckState;
  consistency: AuditCheckState;
  ambiguity: AuditCheckState;
  codingReadiness: AuditCheckState;
  clientAlignment: AuditCheckState;
}

/** The structured result §20 fixes (`docs/contracts/spec-audit-output.json`). */
export interface SpecAuditOutput {
  status: 'PASS' | 'FAIL';
  score: number;
  criticalIssues: AuditIssue[];
  warnings: AuditIssue[];
  missingRequirements: AuditIssue[];
  contradictions: AuditIssue[];
  ambiguities: AuditIssue[];
  recommendations: string[];
  checks?: AuditChecks | null;
}

/** A deterministic finding: a contract issue plus the dimension it belongs to (internal only). */
export interface AuditFinding extends AuditIssue {
  category: AuditCategory;
}

export interface StructuralAudit {
  findings: AuditFinding[];
  /** highest severity present, for logs and for the report */
  worst: AuditSeverity | null;
  /** the score ceiling these findings impose on the model's score */
  scoreCap: number;
}

export interface MergedAuditVerdict {
  status: 'PASS' | 'FAIL';
  score: number;
  /** true when a deterministic CRITICAL/MAJOR finding — not the model — forced this FAIL */
  structuralForcedFail: boolean;
  /** the model's verdict was FAIL (kept whether or not the structure also failed) */
  modelFailed: boolean;
  checks: AuditChecks;
  criticalIssues: AuditIssue[];
  warnings: AuditIssue[];
  missingRequirements: AuditIssue[];
  contradictions: AuditIssue[];
  ambiguities: AuditIssue[];
  recommendations: string[];
  /** every issue, single flat list — what a revision prompt and a human task quote (§21/§42) */
  allIssues: AuditIssue[];
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/** Score ceiling per worst finding: a specification with a critical gap is not a 90-point spec. */
const SCORE_CAP: Record<AuditSeverity, number> = { CRITICAL: 30, MAJOR: 60, MINOR: 80 };

/**
 * §20 ambiguity: "beautiful", "fast", "modern", "user-friendly" — unless they have been converted
 * into actionable requirements. A term counts as converted when the same criterion carries a
 * measurable signal (a number with a unit, a named colour, a countable list).
 */
const VAGUE_TERMS: Array<{ term: string; pattern: RegExp }> = [
  { term: 'beautiful', pattern: /(beautiful|pretty|chiroyli|красив\p{L}*)/iu },
  { term: 'modern', pattern: /(modern|zamonaviy|современн\p{L}*)/iu },
  { term: 'fast', pattern: /(fast|quick|tez\b|быстр\p{L}*|скорост\p{L}*)/iu },
  { term: 'user-friendly', pattern: /(user[- ]friendly|qulay|удобн\p{L}*)/iu },
  { term: 'simple', pattern: /(simple|oddiy|прост\p{L}*)/iu },
  { term: 'nice-looking', pattern: /(nice|attractive|good[- ]looking)/iu },
];

/** A measurable signal inside the same piece of text: 1 s, 200 ms, 3 ta, #fff, "24/7", "≥ 95 %" … */
const MEASURABLE = /(\d+\s*(px|pt|em|rem|s\b|ms|sek|kbit|mb|kb|%|ta\b|dona|x\b)|\d{2,}|#[0-9a-f]{3,8}\b|https?:\/\/)/i;

export function findVagueTerms(text: string): string[] {
  return VAGUE_TERMS.filter((v) => v.pattern.test(text)).map((v) => v.term);
}

/** True when the text states a term that §20 calls vague and gives no way to verify it. */
export function isUnmeasurable(text: string): boolean {
  const terms = findVagueTerms(text);
  if (terms.length === 0) return false;
  return !MEASURABLE.test(text);
}

/**
 * The pieces of text a vague word can hide in. Judged one by one: pooling them would let an
 * unrelated number ("opened in 2015") "measure" a criterion that says nothing at all.
 */
function requirementUnits(req: SpecRequirement): Array<{ label: string; text: string }> {
  const units: Array<{ label: string; text: string }> = [];
  if (req.title) units.push({ label: 'title', text: req.title });
  if (req.description) units.push({ label: 'description', text: req.description });
  for (const ac of req.acceptanceCriteria ?? []) units.push({ label: `criterion ${ac.code}`, text: ac.text });
  return units;
}

function worstOf(findings: AuditFinding[]): AuditSeverity | null {
  if (findings.length === 0) return null;
  return findings.map((f) => f.severity).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0]!;
}

/**
 * The deterministic audit. Input: the specification under audit, its client summary and the
 * requirement snapshot it was generated from (traceability, §16, is audit *input* here).
 */
export function auditSpecStructure(params: {
  spec: SpecDocument;
  summary: ClientSummary;
  fields: RequirementFieldInput[];
}): StructuralAudit {
  const { spec, summary, fields } = params;
  const findings: AuditFinding[] = [];

  // ---- completeness (§20: pages, flows, features, admin, payment, design, database, integrations,
  //      security, acceptance criteria) — measured as "every confirmed client field has a
  //      specification entry, and every entry carries testable criteria".
  if (!spec.requirements || spec.requirements.length === 0) {
    findings.push({
      code: 'SPEC_HAS_NO_REQUIREMENTS', severity: 'CRITICAL', category: 'COMPLETENESS',
      description: 'the specification contains no requirements at all',
      suggestedFix: 'Generate the specification from the confirmed requirements before auditing it.',
    });
  }

  const traceability = auditTraceability(spec, fields);
  for (const gap of traceability.gaps) {
    if (gap.kind === 'MISSING_SPEC_REQ') {
      findings.push({
        code: 'MISSING_SPEC_REQ', severity: 'CRITICAL', category: 'COMPLETENESS',
        description: gap.detail, specRequirementCode: gap.specReqCode ?? null,
        suggestedFix: `Add a SPEC-REQ entry that implements the confirmed field ${gap.fieldPath ?? ''}`.trim(),
      });
    } else if (gap.kind === 'UNTRACEABLE' || gap.kind === 'UNKNOWN_FIELD') {
      findings.push({
        code: gap.kind, severity: 'CRITICAL', category: 'COMPLETENESS',
        description: gap.detail, specRequirementCode: gap.specReqCode ?? null,
        suggestedFix: 'Point the requirement at a field path that exists in the confirmed requirements.',
      });
    } else if (gap.kind === 'NO_TESTABLE_AC' || gap.kind === 'ORPHAN_AC') {
      findings.push({
        code: gap.kind, severity: 'MAJOR', category: 'CODING_READINESS',
        description: gap.detail, specRequirementCode: gap.specReqCode ?? null,
        suggestedFix: 'Write acceptance criteria a test can observe (testable: true + verificationHint).',
      });
    }
  }

  for (const req of spec.requirements ?? []) {
    if ((req.priority === 'MUST' || req.priority === 'NICE_TO_HAVE') && (req.acceptanceCriteria ?? []).length === 0) {
      findings.push({
        code: 'REQ_WITHOUT_AC', severity: 'MAJOR', category: 'CODING_READINESS',
        description: `${req.code} (${req.priority}) has no acceptance criteria`,
        specRequirementCode: req.code, specSection: req.section,
        suggestedFix: 'Add 1..6 testable acceptance criteria for this requirement.',
      });
    }
    if ((req.description ?? '').trim().length < 20) {
      findings.push({
        code: 'REQ_DESCRIPTION_TOO_THIN', severity: 'MINOR', category: 'CODING_READINESS',
        description: `${req.code} has a description too thin to code from`,
        specRequirementCode: req.code, specSection: req.section,
        suggestedFix: 'Describe the behaviour, the inputs and the outcome in one or two sentences.',
      });
    }
  }

  // ---- ambiguity (§20)
  for (const req of spec.requirements ?? []) {
    const offending = requirementUnits(req).filter((unit) => isUnmeasurable(unit.text));
    if (offending.length === 0) continue;
    const vague = [...new Set(offending.flatMap((unit) => findVagueTerms(unit.text)))];
    findings.push({
      code: 'AMBIGUOUS_REQUIREMENT', severity: 'MAJOR', category: 'AMBIGUITY',
      description: `${req.code} uses ${vague.map((v) => `"${v}"`).join(', ')} in its ${offending.map((u) => u.label).join(', ')} with nothing measurable to verify it against`,
      specRequirementCode: req.code, specSection: req.section,
      suggestedFix: 'Convert the vague word into an observable criterion (numbers, colours, named sections, references).',
    });
  }
  for (const question of spec.openQuestions ?? []) {
    if (question.blocking) {
      findings.push({
        code: 'BLOCKING_OPEN_QUESTION', severity: 'MAJOR', category: 'CODING_READINESS',
        description: `unresolved blocking question: ${question.question}`,
        suggestedFix: 'Resolve the question with the client, or record an explicit assumption in knownAssumptions.',
      });
    }
  }

  // ---- consistency + client alignment (§19/§20): the summary the client approved must not name
  //      anything the specification does not contain.
  for (const issue of auditSummaryConsistency(spec, summary)) {
    findings.push({
      code: issue.kind, severity: 'CRITICAL', category: 'CLIENT_ALIGNMENT',
      description: issue.detail, specSection: 'Client Summary',
      suggestedFix: 'Make the specification and the approved client summary agree before the build starts.',
    });
  }

  // ---- completeness of the site itself: a page nobody specified
  for (const page of spec.pages ?? []) {
    const named = page.name.toLowerCase();
    const covered = (spec.requirements ?? []).some(
      (req) =>
        `${req.title} ${req.description}`.toLowerCase().includes(named) ||
        (req.acceptanceCriteria ?? []).some((ac) => ac.text.toLowerCase().includes(named)),
    );
    if (!covered) {
      findings.push({
        code: 'PAGE_WITHOUT_REQUIREMENT', severity: 'MINOR', category: 'COMPLETENESS',
        description: `page "${page.name}" has no requirement that mentions it`,
        specSection: 'Page Specifications',
        suggestedFix: `Add a requirement for the "${page.name}" page or remove the page from the sitemap.`,
      });
    }
  }

  const worst = worstOf(findings);
  return { findings, worst, scoreCap: worst ? SCORE_CAP[worst] : 100 };
}

const CATEGORY_CHECK: Record<AuditCategory, keyof AuditChecks> = {
  COMPLETENESS: 'completeness',
  CONSISTENCY: 'consistency',
  AMBIGUITY: 'ambiguity',
  CODING_READINESS: 'codingReadiness',
  CLIENT_ALIGNMENT: 'clientAlignment',
};

const ALL_CHECKS_PASS: AuditChecks = {
  completeness: 'PASS', consistency: 'PASS', ambiguity: 'PASS', codingReadiness: 'PASS', clientAlignment: 'PASS',
};

function keyOf(issue: AuditIssue): string {
  return `${issue.code}|${issue.description}`;
}

function dedupe(issues: AuditIssue[]): AuditIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = keyOf(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The verdict: a FAIL from the model stands, and so does a structural CRITICAL/MAJOR finding — the
 * model may not overrule an unmeasurable criterion or a missing confirmed requirement. The score
 * can never exceed what the findings allow (a model that answers "PASS, 95" about a spec with
 * missing fields is recorded, not trusted), and a dimension whose structural findings failed cannot
 * be reported as PASS.
 */
export function mergeAuditVerdict(structural: StructuralAudit, llm: SpecAuditOutput): MergedAuditVerdict {
  const forcedCategories = new Set(
    structural.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'MAJOR').map((f) => f.category),
  );
  const structuralForcedFail = forcedCategories.size > 0;
  const status: 'PASS' | 'FAIL' = structuralForcedFail || llm.status === 'FAIL' ? 'FAIL' : 'PASS';
  const score = Math.min(Math.max(0, Math.round(llm.score)), structural.scoreCap);

  const checks: AuditChecks = { ...ALL_CHECKS_PASS, ...(llm.checks ?? {}) };
  for (const category of forcedCategories) checks[CATEGORY_CHECK[category]] = 'FAIL';

  const criticalIssues = dedupe([
    ...llm.criticalIssues,
    ...structural.findings.filter((f) => f.severity === 'CRITICAL'),
  ]);
  const warnings = dedupe([
    ...llm.warnings,
    ...structural.findings.filter((f) => f.severity !== 'CRITICAL' && (f.category === 'CODING_READINESS' || f.category === 'COMPLETENESS')),
  ]);
  const missingRequirements = dedupe([
    ...llm.missingRequirements,
    ...structural.findings.filter((f) => f.category === 'COMPLETENESS'),
  ]);
  const contradictions = dedupe([
    ...llm.contradictions,
    ...structural.findings.filter((f) => f.category === 'CONSISTENCY' || f.category === 'CLIENT_ALIGNMENT'),
  ]);
  const ambiguities = dedupe([
    ...llm.ambiguities,
    ...structural.findings.filter((f) => f.category === 'AMBIGUITY'),
  ]);

  const allIssues = dedupe([
    ...criticalIssues, ...missingRequirements, ...contradictions, ...ambiguities, ...warnings,
  ]);

  return {
    status, score, structuralForcedFail, modelFailed: llm.status === 'FAIL', checks,
    criticalIssues, warnings, missingRequirements, contradictions, ambiguities,
    recommendations: llm.recommendations ?? [],
    allIssues,
  };
}

export interface LoopBudget {
  /** how many audits have already run in this audit cycle (including this one) */
  attempt: number;
  /** the §21 ceiling — 3 by default, read from config (`loop.spec_audit.max`), never hard-coded */
  maxAttempts: number;
}

/** §21: after the ceiling the loop stops, the project is BLOCKED and a human sees the exact issues. */
export function shouldBlockAfterFailure(budget: LoopBudget): boolean {
  return budget.attempt >= budget.maxAttempts;
}

/** No loop may continue forever (§21): the next attempt must be strictly inside the ceiling. */
export function nextAttemptAllowed(budget: LoopBudget): boolean {
  return budget.attempt < budget.maxAttempts;
}

/** Why a human is needed (§42) and what they must look at — one line per issue, code first. */
export function explainAuditBlock(issues: AuditIssue[], budget: LoopBudget): string {
  const lines = issues.map(
    (issue) => `[${issue.severity}] ${issue.code}: ${issue.description}${issue.suggestedFix ? ` → ${issue.suggestedFix}` : ''}`,
  );
  return [
    `The Spec Auditor rejected the approved specification ${budget.attempt} time(s) (limit ${budget.maxAttempts});`,
    'automatic revision has stopped so the specification cannot drift further away from what the client approved (§21).',
    'A human must decide: fix the specification/requirements, talk to the client, or approve a scoped exception.',
    ...(lines.length > 0 ? ['Unresolved issues:', ...lines] : []),
  ].join('\n');
}

/**
 * Spec Auditor agent (§20, §21) — requirements quality assurance, NOT a grammar checker.
 *
 * The model gets everything it needs to judge a *locked, client-approved* specification:
 *   - the Technical Specification (the document under audit),
 *   - the Client Summary the client actually approved (the alignment reference, §19/§20),
 *   - the confirmed requirement fields (so "completeness" is checkable, not vibes),
 *   - the deterministic findings from `auditSpecStructure` as FACTS, so it reasons about the parts a
 *     rule cannot decide instead of re-discovering the obvious ones,
 *   - on a re-audit: the issues of the previous attempt, so it can confirm what was fixed.
 *
 * It returns the frozen contract shape (`docs/contracts/spec-audit-output.json`). The verdict is
 * merged with the structural findings by `mergeAuditVerdict` in `@wpp/core` — the model never gets
 * the last word about a missing requirement or a criterion nobody can measure (D-031 discipline).
 */
import type { AuditChecks, AuditIssue, ClientSummary, ContradictionInput, RequirementFieldInput, SpecDocument } from '@wpp/core';
import {
  SpecAuditOutputSchema, zodErrorsToMessages, type SpecAuditOutput,
} from '../contracts.js';
import type { RunAgentInput, ValidateResult } from '../runtime.js';
import type { ReasoningEffort } from '../llm/types.js';

export const SPEC_AUDIT_OUTPUT_SCHEMA_REF = 'docs/contracts/spec-audit-output.json';

export interface AuditRunParams {
  projectType: string;
  auditAttempt: number;
  maxAttempts: number;
  specVersion: number;
  spec: SpecDocument;
  clientSummary: ClientSummary;
  requirementsVersion: number;
  fields: RequirementFieldInput[];
  contradictions: ContradictionInput[];
  /** deterministic findings, already phrased as contract issues — facts, not opinions */
  structuralIssues: AuditIssue[];
  structuralChecks: AuditChecks;
  /** on attempt ≥ 2: what the previous audit complained about */
  previousIssues?: AuditIssue[] | null;
  language: string;
}

/** [3] TASK SPECIFICATION. */
export function buildAuditTaskBlock(params: AuditRunParams): string {
  const lines: string[] = [
    `Audit specification v${params.specVersion} of a ${params.projectType} website project.`,
    `This is audit attempt ${params.auditAttempt} of at most ${params.maxAttempts}.`,
    '',
    'You are the SPEC AUDITOR. You are NOT a grammar checker: you decide whether this approved',
    'specification is good enough to hand to a coding agent that must not have to guess.',
    '',
    'Judge exactly these five dimensions (§20) and set `checks` for each of them:',
    '1. completeness — pages, flows, features, admin functionality, payment, design, database,',
    '   integrations, security, acceptance criteria. Every confirmed client requirement must be',
    '   implemented by at least one SPEC-REQ. Missing something the client confirmed is CRITICAL.',
    '2. consistency — contradictions between requirements, or between the specification and the',
    '   confirmed requirements list.',
    '3. ambiguity — vague statements such as "beautiful", "fast", "modern", "user-friendly" unless',
    '   they have been converted into something observable (numbers, colours, named sections,',
    '   references). An unmeasurable MUST criterion is a MAJOR ambiguity.',
    '4. codingReadiness — could a coding agent implement this without guessing critical',
    '   requirements? Check acceptance criteria exist and are testable, blocking open questions are',
    '   resolved, data/integration/deployment needs are stated where the project needs them.',
    '5. clientAlignment — does the specification match the Client Summary the client approved?',
    '   Inventing a page or feature the client never saw is a CLIENT_ALIGNMENT failure. A revision',
    '   that changes the approved meaning is the same kind of failure.',
    '',
    'The DETERMINISTIC FINDINGS in PROJECT DATA were derived by rules, not opinion: treat them as',
    'established facts. Never contradict them, and never repeat them as if you found them —',
    'concentrate on the judgement calls a rule cannot make (unclear flows, half-decided features,',
    'requirements that quietly assume something nobody approved).',
    '',
    'Judge the CONTENT of the specification, not its formatting, wording or language. Do not fail a',
    'specification for style. Do not invent requirements the client did not ask for; you may call an',
    'absence "missing" only when the client confirmed or approved it, or when the project type makes',
    'it unavoidable (for a restaurant site: a menu, opening hours or contact route).',
    '',
    'SEVERITY: CRITICAL = the build cannot start correctly. MAJOR = a coding agent would guess.',
    'MINOR = worth fixing, does not block. Score 0..100 = how ready this specification is to build',
    'from. PASS requires score >= 70 and no unresolved CRITICAL/MAJOR issue; otherwise FAIL.',
    'A FAIL must name its reasons (issues in the matching bucket) — an empty FAIL is useless.',
    '',
    'Every issue: { code (SHORT_UPPER_SNAKE), severity, description (what is wrong, concretely,',
    'quoting the requirement code when you can), specSection, specRequirementCode, suggestedFix',
    '(what to change so the next attempt passes)}. Put each issue in the bucket it belongs to:',
    'criticalIssues, missingRequirements, contradictions, ambiguities, warnings.',
    'recommendations[] holds improvements that are NOT blocking.',
    params.language ? `Client-facing wording inside the documents is: ${params.language}.` : '',
    'Return ONE JSON object matching the output schema. No markdown fences, no prose outside it.',
  ];

  if (params.previousIssues && params.previousIssues.length > 0) {
    lines.push(
      '',
      'ISSUES FROM THE PREVIOUS AUDIT (fixing them is why this revision exists):',
      ...params.previousIssues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.description}`),
      'Verify each one is genuinely resolved. If a previous issue is only superficially addressed,',
      'fail it again with a sharper description — but do not raise new concerns that were equally',
      'true of the version the client already approved unless they are genuinely critical.',
    );
  }
  return lines.filter((line) => line !== '').join('\n');
}

/** [4] PROJECT DATA — structured, never prose (§50). */
export function buildAuditProjectData(params: AuditRunParams): unknown {
  return {
    projectType: params.projectType,
    auditAttempt: params.auditAttempt,
    maxAttempts: params.maxAttempts,
    requirementsVersion: params.requirementsVersion,
    specificationVersion: params.specVersion,
    specification: params.spec,
    clientApprovedSummary: params.clientSummary,
    confirmedRequirementFields: params.fields.map((f) => ({
      fieldPath: f.fieldPath,
      status: f.status,
      priority: f.priority,
      value: f.value ?? null,
    })),
    recordedContradictions: params.contradictions,
    deterministicFindings: params.structuralIssues,
    deterministicChecks: params.structuralChecks,
    previousAuditIssues: params.previousIssues ?? null,
    rules: [
      'A client-confirmed or client-approved-default field without a SPEC-REQ implementation is a completeness failure.',
      'A MUST criterion using an unmeasurable adjective is an ambiguity failure.',
      'The specification must not contain a page or feature the clientApprovedSummary does not describe, and must not drop one it does.',
    ],
  };
}

export function validateSpecAudit(raw: unknown): ValidateResult<SpecAuditOutput> {
  const parsed = SpecAuditOutputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data as SpecAuditOutput };
  return { ok: false, errors: zodErrorsToMessages(parsed.error) };
}

export function buildAuditRunInput(opts: {
  task: string;
  projectData: unknown;
  clientMessages: Array<{ id?: string; at?: string; text: string }>;
  outputSchema: unknown;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** reasoning models (Gemini 3.x) can spend the whole completion cap thinking */
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  onRaw?: RunAgentInput<SpecAuditOutput>['onRaw'];
}): RunAgentInput<SpecAuditOutput> {
  return {
    task: opts.task,
    projectData: opts.projectData,
    clientMessages: opts.clientMessages,
    outputSchema: opts.outputSchema,
    validate: validateSpecAudit,
    model: opts.model,
    // An auditor must be reproducible: the same specification has to get the same verdict.
    temperature: opts.temperature ?? 0,
    maxOutputTokens: opts.maxOutputTokens,
    reasoningEffort: opts.reasoningEffort,
    timeoutMs: opts.timeoutMs,
    onRaw: opts.onRaw,
  };
}

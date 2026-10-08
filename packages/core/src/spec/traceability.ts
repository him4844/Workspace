/**
 * Specification domain (SPEC §14–§19, §34, §35) — pure types and rules.
 *
 * The Specification Agent produces the Technical Specification and, *from it*, the Client Summary
 * (§19: never two independently invented documents). This module owns:
 *   - the canonical shapes stored in the database and rendered to artifacts;
 *   - traceability auditing REQ → SPEC-REQ → AC (§16) and acceptance-criteria testability (§17);
 *   - the summary ↔ specification consistency check (§19);
 *   - version/lock rules (§34/§35) — an approved version is immutable, later changes are
 *     Change Requests.
 */
import type { RequirementStatus } from '../types.js';

export type SpecStatus = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'LOCKED' | 'SUPERSEDED';
export type SpecPriority = 'MUST' | 'NICE_TO_HAVE' | 'LATER';
export type VerificationHint = 'E2E' | 'API' | 'VISUAL' | 'MANUAL' | 'STATIC';

export interface AcceptanceCriterion {
  code: string;              // AC-001
  text: string;              // testable statement (§17)
  testable: boolean;
  verificationHint?: VerificationHint;
}

export interface SpecRequirement {
  code: string;              // SPEC-REQ-001
  originReqField?: string | null;  // requirement_fields.field_path (§16)
  originMessageIds?: string[];
  section: string;
  title: string;
  description: string;
  priority: SpecPriority;
  acceptanceCriteria: AcceptanceCriterion[];
  verificationExpectation?: string | null;
}

export interface SpecDocument {
  meta: {
    projectType: string;
    generatedFromRequirementsVersion: number;
    sectionsIncluded?: string[];
    sectionsOmitted?: string[];
  };
  overview?: string | null;
  businessGoals?: string[];
  targetUsers?: string[];
  sitemap?: string[];
  pages?: Array<{ name: string; purpose: string; sections?: string[] }>;
  requirements: SpecRequirement[];
  nonFunctional?: Record<string, unknown> | null;
  integrations?: string[];
  databaseNotes?: string | null;
  deploymentRequirements?: string | null;
  definitionOfDone?: string[];
  knownAssumptions?: string[];
  openQuestions: Array<{ question: string; blocking: boolean; relatedField?: string | null }>;
  futureScope?: string[];
}

export interface ClientSummary {
  markdown: string;
  assumptionsShown: string[];
  approveLabel?: string;
  requestChangesLabel?: string;
}

export interface SpecificationOutput {
  spec: SpecDocument;
  clientSummary: ClientSummary;
}

/** Requirement fields as the spec generator sees them (subset of the DB row). */
export interface RequirementFieldInput {
  fieldPath: string;
  value: unknown;
  status: RequirementStatus;
  priority: SpecPriority;
  mandatory: boolean;
  category?: string | null;
  sourceMessageId?: string | null;
}

export interface ContradictionInput {
  fieldA: string;
  fieldB: string;
  description: string;
  severity: 'MAJOR' | 'MINOR';
  status: 'OPEN' | 'CLARIFYING' | 'RESOLVED' | 'ACCEPTED_BY_CLIENT';
}

// ---------------------------------------------------------------- traceability (§16, §17)

export interface TraceabilityRow {
  specReqCode: string;
  originReqField: string | null;
  section: string;
  title: string;
  priority: SpecPriority;
  acceptanceCriteria: string[];
  allTestable: boolean;
}

export interface TraceabilityGap {
  kind: 'MISSING_SPEC_REQ' | 'UNTRACEABLE' | 'NO_TESTABLE_AC' | 'UNKNOWN_FIELD' | 'ORPHAN_AC';
  fieldPath?: string;
  specReqCode?: string;
  detail: string;
}

export interface TraceabilityReport {
  rows: TraceabilityRow[];
  gaps: TraceabilityGap[];
  /** share of requirements that need a spec entry and have one (0..1) */
  coverage: number;
  ok: boolean;
}

/** A requirement field must reach the specification when the client confirmed it or approved a default (§16). */
export function requiresSpecEntry(field: RequirementFieldInput): boolean {
  return field.status === 'CLIENT_CONFIRMED' || field.status === 'CLIENT_APPROVED_DEFAULT';
}

export function auditTraceability(spec: SpecDocument, fields: RequirementFieldInput[]): TraceabilityReport {
  const knownFields = new Set(fields.map((f) => f.fieldPath));
  const required = fields.filter(requiresSpecEntry);
  const gaps: TraceabilityGap[] = [];
  const byField = new Map<string, SpecRequirement[]>();

  for (const req of spec.requirements) {
    const origin = req.originReqField ?? null;
    if (origin) {
      if (!knownFields.has(origin)) {
        gaps.push({ kind: 'UNKNOWN_FIELD', specReqCode: req.code, fieldPath: origin, detail: `${req.code} references unknown requirement field ${origin}` });
      } else {
        const list = byField.get(origin) ?? [];
        list.push(req);
        byField.set(origin, list);
      }
    } else if (req.priority === 'MUST') {
      gaps.push({ kind: 'UNTRACEABLE', specReqCode: req.code, detail: `${req.code} is MUST without originReqField (a MUST requirement must trace back to a client-confirmed field, §16)` });
    }
    if (req.acceptanceCriteria.length === 0) {
      gaps.push({ kind: 'ORPHAN_AC', specReqCode: req.code, detail: `${req.code} has no acceptance criteria` });
    }
  }

  for (const field of required) {
    const entries = byField.get(field.fieldPath) ?? [];
    if (entries.length === 0) {
      gaps.push({ kind: 'MISSING_SPEC_REQ', fieldPath: field.fieldPath, detail: `client-confirmed "${field.fieldPath}" is not implemented by any SPEC-REQ` });
      continue;
    }
    if (entries.every((e) => e.acceptanceCriteria.every((ac) => !ac.testable))) {
      gaps.push({ kind: 'NO_TESTABLE_AC', fieldPath: field.fieldPath, specReqCode: entries[0]!.code, detail: `"${field.fieldPath}" has no testable acceptance criterion (§17)` });
    }
  }

  const rows: TraceabilityRow[] = spec.requirements.map((req) => ({
    specReqCode: req.code,
    originReqField: req.originReqField ?? null,
    section: req.section,
    title: req.title,
    priority: req.priority,
    acceptanceCriteria: req.acceptanceCriteria.map((ac) => ac.code),
    allTestable: req.acceptanceCriteria.length > 0 && req.acceptanceCriteria.every((ac) => ac.testable),
  }));

  const coverage = required.length === 0
    ? 1
    : required.filter((f) => (byField.get(f.fieldPath) ?? []).length > 0).length / required.length;

  return { rows, gaps, coverage: Number(coverage.toFixed(3)), ok: gaps.length === 0 };
}

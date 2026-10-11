/**
 * The completeness engine (SPEC §10, §10A) — the only authority on whether requirements
 * are complete. It reads *statuses*, never prose: a field counts only when its status is
 * CLIENT_CONFIRMED, CLIENT_APPROVED_DEFAULT or NOT_APPLICABLE.
 *
 * The AI can therefore never declare the conversation "complete" by feeling; it can only
 * feed status updates, and those must obey §10A (client truth needs a client message).
 */
import { isMandatoryFieldComplete, type RequirementStatus } from '../types.js';
import { dependencySatisfied, type QuestionnaireDefinition, type RequirementFieldState } from './questionnaires.js';

export interface OpenContradiction {
  fieldA: string;
  fieldB: string;
  severity: 'MAJOR' | 'MINOR';
  status: 'OPEN' | 'CLARIFYING' | 'RESOLVED' | 'ACCEPTED_BY_CLIENT';
}

export interface CompletenessInput {
  fields: RequirementFieldState[];
  contradictions: OpenContradiction[];
  /**
   * The merged questionnaire, when available: a mandatory field whose `dependsOn` gate is
   * not satisfied (e.g. `payments.providers` while the client says "no online payment")
   * is not part of the requirement set and must not block completion (§8D).
   */
  questionnaire?: QuestionnaireDefinition;
  /** §10 condition 4 — the internal summary artifact exists */
  hasInternalSummary?: boolean;
}

export interface CompletenessReport {
  /** 0..1 — share of mandatory fields that are complete (weighted equally) */
  score: number;
  /** mandatory fields that keep the project from moving on */
  blockingFields: string[];
  /** mandatory fields whose status is UNCLEAR and got no clarification left */
  criticalAmbiguities: string[];
  openContradictions: number;
  totalMandatory: number;
  completeMandatory: number;
  /** §10 conditions 1–3 (condition 4 is the summary artifact, checked by the caller) */
  readyForSummary: boolean;
  /** readyForSummary AND the internal summary exists */
  complete: boolean;
}

export function computeCompleteness(input: CompletenessInput): CompletenessReport {
  const byPath = new Map(input.fields.map((f) => [f.fieldPath, f]));
  const inapplicable = new Set<string>();
  if (input.questionnaire) {
    for (const definition of input.questionnaire.fields) {
      if (!dependencySatisfied(definition, byPath)) inapplicable.add(definition.path);
    }
  }
  const mandatory = input.fields.filter((f) => f.mandatory && !inapplicable.has(f.fieldPath));
  const completeMandatory = mandatory.filter((f) => isMandatoryFieldComplete(f.status));
  const blockingFields = mandatory
    .filter((f) => !isMandatoryFieldComplete(f.status))
    .map((f) => f.fieldPath);

  // A field only becomes a *critical ambiguity* when it is explicitly unresolved (§10.3).
  const criticalAmbiguities = mandatory
    .filter((f) => f.status === 'UNCLEAR')
    .map((f) => f.fieldPath);

  const openContradictions = input.contradictions.filter(
    (c) => c.status === 'OPEN' || c.status === 'CLARIFYING',
  ).length;

  const score = mandatory.length === 0 ? 0 : completeMandatory.length / mandatory.length;
  const readyForSummary = blockingFields.length === 0 && openContradictions === 0;

  return {
    score: Number(score.toFixed(3)),
    blockingFields,
    criticalAmbiguities,
    openContradictions,
    totalMandatory: mandatory.length,
    completeMandatory: completeMandatory.length,
    readyForSummary,
    complete: readyForSummary && input.hasInternalSummary === true,
  };
}

/** Guard context helper for T05 — the pure state machine only sees booleans. */
export function canCompleteRequirements(report: CompletenessReport): boolean {
  return report.readyForSummary;
}

export function statusIsComplete(status: RequirementStatus): boolean {
  return isMandatoryFieldComplete(status);
}

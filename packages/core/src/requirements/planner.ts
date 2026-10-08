/**
 * Question planner (SPEC §5.1, §6, §8) — decides the *next single question* deterministically.
 *
 * The LLM phrases questions and extracts values; it does not decide what to ask or when
 * to stop. That keeps the interview reproducible, capped (§10 limits) and testable.
 */
import { dependencySatisfied, type QuestionnaireDefinition, type QuestionnaireField, type RequirementFieldState } from './questionnaires.js';
import type { OpenContradiction } from './completeness.js';

export interface PlannerLimits {
  /** config `loop.requirements.max_questions` */
  maxQuestions: number;
  /** config `loop.requirements.max_clarifications_per_field` */
  maxClarificationsPerField: number;
}

export interface PlannerCounters {
  questionsAsked: number;
  clarificationsByField: Record<string, number>;
}

export type QuestionReason =
  | 'CONTRADICTION'      // §8B
  | 'CLARIFY_VAGUE'      // §8A
  | 'CONFIRM_DEFAULT'    // §11 — waiting on a DEFAULT_PROPOSED answer
  | 'CONFIRM_INFERRED'   // §9/§53 — an AI_INFERRED value must not silently become a requirement
  | 'NEXT_MANDATORY'     // §6 template order
  | 'DYNAMIC_MISSING';   // §8C/§8D — package-specific or dependency follow-up

export type QuestionPlan =
  | {
      kind: 'ASK';
      fieldPath: string;
      reason: QuestionReason;
      /** text the agent should use (the LLM may localise, never change meaning) */
      prompt?: string;
      quickReplies?: string[];
      field?: QuestionnaireField;
    }
  | { kind: 'STOP'; reason: 'COMPLETE' | 'MAX_QUESTIONS' | 'NOTHING_LEFT' };

/** §8A — "modern", "simple", "fast", "professional" … are not measurable requirements. */
export function detectVagueAnswer(
  answer: string,
  lexicon: string[],
  fieldHints: string[] = [],
): boolean {
  const text = answer.trim().toLowerCase();
  if (text.length === 0) return true;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length <= 2 && text.length < 24) return true; // "nası", "hammasi", "yaxshi"
  const hints = [...lexicon, ...fieldHints].map((w) => w.toLowerCase());
  let hits = 0;
  for (const hint of hints) {
    if (!hint) continue;
    if (text === hint) return true;
    if (text.includes(hint)) hits += 1;
  }
  // One vague word in a sentence with substance is fine; a sentence made mostly of
  // vague words is not (e.g. "shunchaki zamonaviy va chiroyli").
  return hits >= 2 || (hits === 1 && words.length <= 4);
}

export interface PlanInput {
  questionnaire: QuestionnaireDefinition;
  fields: RequirementFieldState[];
  contradictions: OpenContradiction[];
  counters: PlannerCounters;
  limits: PlannerLimits;
  /** fields whose answer is still awaited (DEFAULT_PROPOSED ⇒ §11 pending) */
  pendingFieldPaths?: string[];
}

/**
 * Priority of asking (most specific first):
 *   1. open contradiction  — silence on a contradiction is worse than a missing nicety
 *   2. vague answer        — if clarification budget remains
 *   3. DEFAULT_PROPOSED    — close the §11 loop
 *   4. AI_INFERRED         — convert assumption into client truth (or NOT_APPLICABLE)
 *   5. next EMPTY mandatory field, honouring `dependsOn`
 */
export function planNextQuestion(input: PlanInput): QuestionPlan {
  const { questionnaire, fields, contradictions, counters, limits } = input;
  const byPath = new Map(fields.map((f) => [f.fieldPath, f]));
  const questionOf = new Map(questionnaire.fields.map((f) => [f.path, f]));

  const budgetLeft = (path: string): boolean =>
    (counters.clarificationsByField[path] ?? 0) < limits.maxClarificationsPerField;

  if (counters.questionsAsked >= limits.maxQuestions) {
    return { kind: 'STOP', reason: 'MAX_QUESTIONS' };
  }

  // 1. contradiction (§8B) — ask about the weaker/conflicting side
  const open = contradictions.find((c) => c.status === 'OPEN' || c.status === 'CLARIFYING');
  if (open && budgetLeft(open.fieldB)) {
    const field = questionOf.get(open.fieldB) ?? questionOf.get(open.fieldA);
    return {
      kind: 'ASK',
      fieldPath: field?.path ?? open.fieldB,
      reason: 'CONTRADICTION',
      prompt: field?.clarifyPrompt ?? undefined,
      quickReplies: field?.quickReplies,
      field,
    };
  }

  // 2. vague answer (§8A) — the value is in the DB as UNCLEAR
  const vague = fields.find((f) => (f.status === 'UNCLEAR' || (f.mandatory && f.status === 'EMPTY' && f.note === 'VAGUE')) && budgetLeft(f.fieldPath));
  if (vague) {
    const field = questionOf.get(vague.fieldPath);
    return {
      kind: 'ASK',
      fieldPath: vague.fieldPath,
      reason: 'CLARIFY_VAGUE',
      prompt: field?.clarifyPrompt ?? field?.question,
      quickReplies: field?.quickReplies,
      field,
    };
  }

  // 3. §11 — the client has an unanswered default on the table
  const proposed = fields.find((f) => f.status === 'DEFAULT_PROPOSED');
  if (proposed) {
    const field = questionOf.get(proposed.fieldPath);
    return {
      kind: 'ASK',
      fieldPath: proposed.fieldPath,
      reason: 'CONFIRM_DEFAULT',
      prompt: field?.defaultSuggestion
        ? `Shu variantni tanlaymizmi: ${field.defaultSuggestion}? (Ha / Yo‘q / Boshqacha)`
        : field?.question,
      quickReplies: ['Ha', 'Yo‘q', 'Boshqacha'],
      field,
    };
  }

  // 4. §53 — an AI inference may never become a hard requirement on its own
  const inferred = fields.find((f) => f.status === 'AI_INFERRED');
  if (inferred) {
    const field = questionOf.get(inferred.fieldPath);
    return {
      kind: 'ASK',
      fieldPath: inferred.fieldPath,
      reason: 'CONFIRM_INFERRED',
      prompt: field?.question,
      quickReplies: field?.quickReplies,
      field,
    };
  }

  // 5. template order — the next question that the interview actually owes the client:
  //    mandatory template/package fields, MUST-priority fields, and conditional follow-ups
  //    (`dependsOn`) whose gate is satisfied. Purely optional enrichment fields
  //    (NICE_TO_HAVE without a gate) are never asked by the planner — the agent may
  //    still fill them from what the client volunteers (§8C).
  const ordered = [...questionnaire.fields].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const field of ordered) {
    const state = byPath.get(field.path);
    const status = state?.status ?? 'EMPTY';
    if (status !== 'EMPTY') continue;
    const gateSatisfied = dependencySatisfied(field, byPath);
    const isGate = field.dependsOn !== undefined;
    if (!gateSatisfied) {
      if (isGate || field.mandatory) continue; // gated off by the client's own answer
      if (!field.mandatory && field.priority !== 'MUST') continue;
      continue;
    }
    if (!field.mandatory && field.priority !== 'MUST' && !isGate) continue;
    if ((counters.clarificationsByField[field.path] ?? 0) > limits.maxClarificationsPerField) continue;
    return {
      kind: 'ASK',
      fieldPath: field.path,
      reason: field.mandatory ? 'NEXT_MANDATORY' : 'DYNAMIC_MISSING',
      prompt: field.question,
      quickReplies: field.quickReplies,
      field,
    };
  }

  // Nothing to ask any more. §10: the interview ends when every *applicable* mandatory
  // field is complete; if something mandatory is still incomplete (it exhausted its
  // clarification budget) the caller escalates to a human instead of looping.
  const stillOpen = fields.filter(
    (f) => f.mandatory && !byPathInapplicable(f.fieldPath, questionnaire, byPath) && !isCompleteStatus(f.status),
  );
  return stillOpen.length > 0 ? { kind: 'STOP', reason: 'NOTHING_LEFT' } : { kind: 'STOP', reason: 'COMPLETE' };
}

function isCompleteStatus(status: RequirementFieldState['status']): boolean {
  return status === 'CLIENT_CONFIRMED' || status === 'CLIENT_APPROVED_DEFAULT' || status === 'NOT_APPLICABLE';
}

/** Mandatory fields whose `dependsOn` gate is unsatisfied are inert (§8D). */
function byPathInapplicable(
  fieldPath: string,
  questionnaire: QuestionnaireDefinition,
  byPath: Map<string, RequirementFieldState>,
): boolean {
  const definition = questionnaire.fields.find((f) => f.path === fieldPath);
  if (!definition) return false;
  return !dependencySatisfied(definition, byPath);
}

/** §8D — re-exported from `./questionnaires.js` (single implementation, shared with completeness). */
export { dependencySatisfied } from './questionnaires.js';

/** §8C — package fields that "a business like this" must have should be asked before closing. */
export function missingMandatoryPaths(input: PlanInput): string[] {
  return input.fields
    .filter((f) => f.mandatory && f.status !== 'CLIENT_CONFIRMED' && f.status !== 'CLIENT_APPROVED_DEFAULT' && f.status !== 'NOT_APPLICABLE')
    .map((f) => f.fieldPath);
}

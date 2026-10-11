/**
 * Questionnaire definitions are DATA (SPEC §7, §50): stored in `config/questionnaires/*.json`,
 * seeded into the `questionnaires` table, and interpreted by the generic code below.
 * Adding a website-type package must never require touching agent code.
 */
import type { RequirementStatus } from '../types.js';

export const QUESTIONNAIRE_SCHEMA_VERSION = '1.0.0';

export type Priority = 'MUST' | 'NICE_TO_HAVE' | 'LATER';

/** One question slot of the predefined template (§6) or a type package (§7). */
export interface QuestionnaireField {
  /** dot path, e.g. `payments.methods` */
  path: string;
  category: string;
  /** the canonical phrasing; the agent may rewrite it for the conversation, never the meaning */
  question: string;
  /** example answers offered as Instagram quick replies */
  quickReplies?: string[];
  mandatory: boolean;
  priority?: Priority;
  /** accepted answer kinds — used for validation and follow-up logic */
  valueType?: 'text' | 'number' | 'boolean' | 'list' | 'choice' | 'url';
  /** for `choice` fields */
  options?: string[];
  /** ordering hint; lower comes first */
  order?: number;
  /** ask this only when another field has one of these values, e.g. `{"payments.has": ["yes"]}` */
  dependsOn?: Record<string, unknown[]>;
  /** hint shown when the client answers "I don't know" (§11) */
  defaultSuggestion?: string;
  /** extra clarification prompts used when an answer is vague (§8A) */
  clarifyPrompt?: string;
  /** fragments that mark an answer to THIS field as vague (merged with the general lexicon) */
  vagueHints?: string[];
}

export interface QuestionnaireDefinition {
  schemaVersion: string;
  code: string;
  version: number;
  type: 'GENERAL' | 'PACKAGE';
  appliesToProjectType?: string | null;
  title: string;
  description?: string;
  /** merged with every package lexicon */
  vagueLexicon?: string[];
  fields: QuestionnaireField[];
}

export interface RequirementFieldState {
  fieldPath: string;
  category: string;
  value: unknown;
  status: RequirementStatus;
  priority: Priority;
  mandatory: boolean;
  note?: string | null;
}

/** Mandatory categories of SPEC §6 — every questionnaire must cover them. */
export const MANDATORY_CATEGORIES = [
  'business_purpose', 'target_audience', 'website_type', 'pages', 'features',
  'authentication', 'payments', 'products_services', 'admin_panel', 'design',
  'content', 'seo', 'integrations', 'security', 'hosting', 'domain', 'budget', 'deadline',
] as const;

export function validateQuestionnaire(def: QuestionnaireDefinition): string[] {
  const problems: string[] = [];
  if (!def.code) problems.push('code is required');
  if (!def.fields || def.fields.length === 0) problems.push('fields must not be empty');
  const seen = new Set<string>();
  for (const f of def.fields) {
    if (seen.has(f.path)) problems.push(`duplicate field path: ${f.path}`);
    seen.add(f.path);
    if (!f.category) problems.push(`field ${f.path} has no category`);
    if (!f.question || f.question.trim().length < 5) problems.push(`field ${f.path} needs a question`);
    if (f.valueType === 'choice' && (!f.options || f.options.length < 2)) {
      problems.push(`choice field ${f.path} needs at least two options`);
    }
  }
  if (def.type === 'GENERAL') {
    const categories = new Set(def.fields.map((f) => f.category));
    for (const mandatory of MANDATORY_CATEGORIES) {
      if (!categories.has(mandatory)) problems.push(`mandatory category missing: ${mandatory}`);
    }
  }
  return problems;
}

/**
 * Merge the GENERAL questionnaire with the package for the detected project type (§7).
 * GENERAL wins on path conflicts so a package can never silently override the template.
 */
export function mergeQuestionnaires(
  general: QuestionnaireDefinition,
  packages: QuestionnaireDefinition[],
): QuestionnaireDefinition {
  const byPath = new Map<string, QuestionnaireField>();
  for (const pkg of packages) {
    for (const field of pkg.fields) {
      if (!byPath.has(field.path)) byPath.set(field.path, field);
    }
  }
  for (const field of general.fields) byPath.set(field.path, field); // template overrides packages

  const fields = [...byPath.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return {
    ...general,
    vagueLexicon: [...(general.vagueLexicon ?? []), ...packages.flatMap((p) => p.vagueLexicon ?? [])],
    fields,
  };
}

/**
 * §8D — a field gated by `dependsOn` is only relevant when the parent field has one of the
 * listed values ("payments.providers" only when the client wants online payments).
 * Used by the planner (what to ask) and by the completeness engine (what must be answered).
 */
export function dependencySatisfied(field: QuestionnaireField, fields: Map<string, RequirementFieldState>): boolean {
  if (!field.dependsOn) return true;
  for (const [depPath, allowed] of Object.entries(field.dependsOn)) {
    const value = fields.get(depPath)?.value;
    const normalised = JSON.stringify(value ?? null);
    const ok = allowed.some((candidate) => JSON.stringify(candidate) === normalised
      || (typeof candidate === 'string' && typeof value === 'string' && candidate.toLowerCase() === value.toLowerCase())
      || (typeof candidate === 'boolean' && value === candidate));
    if (!ok) return false;
  }
  return true;
}

/** Field lookup used by every consumer (planner, apply, summary builder). */
export function indexQuestionnaire(def: QuestionnaireDefinition): Map<string, QuestionnaireField> {
  return new Map(def.fields.map((f) => [f.path, f]));
}

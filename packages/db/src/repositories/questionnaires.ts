/**
 * Questionnaires as data (SPEC §7, §50; docs/11 §2.4): the files in `config/questionnaires/`
 * are the reviewable source of truth, seeded into this table; the runtime always reads the DB.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { QuestionnaireDefinition } from '@wpp/core';
import type { Executor } from '../client.js';
import { questionnaires } from '../schema.js';
import { uuidv7 } from '@wpp/infra';

export type QuestionnaireRow = typeof questionnaires.$inferSelect;

export async function upsertQuestionnaireDefinition(ex: Executor, definition: QuestionnaireDefinition): Promise<string> {
  const existing = await ex
    .select()
    .from(questionnaires)
    .where(and(eq(questionnaires.code, definition.code), eq(questionnaires.version, definition.version)))
    .limit(1);
  if (existing[0]) {
    await ex
      .update(questionnaires)
      .set({
        definition: definition as unknown as object,
        type: definition.type,
        appliesToProjectType: definition.appliesToProjectType ?? null,
        isActive: true,
      })
      .where(eq(questionnaires.id, existing[0].id));
    return existing[0].id;
  }
  const id = uuidv7();
  await ex.insert(questionnaires).values({
    id,
    code: definition.code,
    version: definition.version,
    type: definition.type,
    appliesToProjectType: definition.appliesToProjectType ?? null,
    definition: definition as unknown as object,
    isActive: true,
  });
  return id;
}

export async function getQuestionnaireDefinition(ex: Executor, code: string): Promise<QuestionnaireDefinition | null> {
  const rows = await ex
    .select()
    .from(questionnaires)
    .where(and(eq(questionnaires.code, code), eq(questionnaires.isActive, true)))
    .orderBy(desc(questionnaires.version))
    .limit(1);
  const row = rows[0];
  return row ? (row.definition as unknown as QuestionnaireDefinition) : null;
}

export async function listQuestionnaireDefinitions(ex: Executor): Promise<QuestionnaireRow[]> {
  return ex.select().from(questionnaires).orderBy(desc(questionnaires.createdAt));
}

/**
 * GENERAL plus the package matching the detected project type. The caller merges them with
 * `mergeQuestionnaires` (packages/core) — merging stays a pure-domain concern.
 */
export async function loadQuestionnaireSources(
  ex: Executor,
  projectType: string | null,
): Promise<{ general: QuestionnaireDefinition; packages: QuestionnaireDefinition[] } | null> {
  const general = await getQuestionnaireDefinition(ex, 'GENERAL');
  if (!general) return null;
  if (!projectType || projectType === 'UNKNOWN') return { general, packages: [] };
  const rows = await ex
    .select()
    .from(questionnaires)
    .where(and(eq(questionnaires.type, 'PACKAGE'), eq(questionnaires.isActive, true)));
  const packages = rows
    .map((r) => r.definition as unknown as QuestionnaireDefinition)
    .filter((d) => d.appliesToProjectType === projectType);
  return { general, packages };
}

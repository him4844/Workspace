/**
 * Requirements persistence (docs/03 §5; SPEC §10A, §12).
 *
 * Every write that changes a field status also appends a `field_status_history` row —
 * that is what makes §10A ("every status change is versioned and logged") true rather
 * than aspirational.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@wpp/infra';
import type { RequirementStatus } from '@wpp/core';
import type { Executor } from '../client.js';
import {
  contradictions, fieldStatusHistory, projects, requirementFields, requirementVersions,
} from '../schema.js';
import type { QuestionnaireDefinition } from '@wpp/core';

export type RequirementVersionRow = typeof requirementVersions.$inferSelect;
export type RequirementFieldRow = typeof requirementFields.$inferSelect;
export type ContradictionRow = typeof contradictions.$inferSelect;

// ---------------------------------------------------------------- versions

export async function getCurrentRequirementVersion(ex: Executor, projectId: string): Promise<RequirementVersionRow | null> {
  const rows = await ex
    .select()
    .from(requirementVersions)
    .where(and(eq(requirementVersions.projectId, projectId), eq(requirementVersions.isCurrent, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create the next requirements version (v1 on first use) and mark it current.
 * Previous versions are never overwritten (§34) — history stays queryable.
 */
export async function createRequirementVersion(
  ex: Executor,
  params: { projectId: string; questionnaireSchemaVersion: string; createdByRunId?: string | null },
): Promise<RequirementVersionRow> {
  const existing = await ex
    .select({ version: requirementVersions.version })
    .from(requirementVersions)
    .where(eq(requirementVersions.projectId, params.projectId))
    .orderBy(desc(requirementVersions.version))
    .limit(1);
  const nextVersion = (existing[0]?.version ?? 0) + 1;

  await ex
    .update(requirementVersions)
    .set({ isCurrent: false })
    .where(and(eq(requirementVersions.projectId, params.projectId), eq(requirementVersions.isCurrent, true)));

  const row: RequirementVersionRow = {
    id: uuidv7(),
    projectId: params.projectId,
    version: nextVersion,
    questionnaireSchemaVersion: params.questionnaireSchemaVersion,
    completeness: '0',
    summaryArtifactId: null,
    vision: {},
    pendingFieldPath: null,
    isCurrent: true,
    createdByRunId: params.createdByRunId ?? null,
    createdAt: new Date(),
  };
  await ex.insert(requirementVersions).values(row);
  await ex
    .update(projects)
    .set({ currentRequirementsVersion: nextVersion, updatedAt: new Date() })
    .where(eq(projects.id, params.projectId));
  return row;
}

/** Copy the field set of a previous version into a new one (questionnaires evolve). */
export async function cloneFieldsFromVersion(ex: Executor, fromVersionId: string, toVersionId: string): Promise<number> {
  const source = await ex.select().from(requirementFields).where(eq(requirementFields.requirementVersionId, fromVersionId));
  if (source.length === 0) return 0;
  const rows = source.map((f) => ({
    id: uuidv7(),
    requirementVersionId: toVersionId,
    fieldPath: f.fieldPath,
    category: f.category,
    value: f.value,
    status: f.status,
    priority: f.priority,
    mandatory: f.mandatory,
    confidence: f.confidence,
    sourceMessageId: f.sourceMessageId,
    sourceRunId: f.sourceRunId,
    note: f.note,
    updatedAt: new Date(),
  }));
  await ex.insert(requirementFields).values(rows);
  return rows.length;
}

/** Remember which question the client must answer next (drives the prompt + double-ask guard). */
export async function setPendingFieldPath(ex: Executor, versionId: string, fieldPath: string | null): Promise<void> {
  await ex.update(requirementVersions).set({ pendingFieldPath: fieldPath }).where(eq(requirementVersions.id, versionId));
}

export async function setRequirementCompleteness(
  ex: Executor,
  versionId: string,
  params: { completeness: number; vision?: unknown; summaryArtifactId?: string | null },
): Promise<void> {
  await ex
    .update(requirementVersions)
    .set({
      completeness: String(params.completeness),
      ...(params.vision !== undefined ? { vision: params.vision as object } : {}),
      ...(params.summaryArtifactId !== undefined ? { summaryArtifactId: params.summaryArtifactId } : {}),
    })
    .where(eq(requirementVersions.id, versionId));
}

// ---------------------------------------------------------------- fields

export async function listRequirementFields(ex: Executor, versionId: string): Promise<RequirementFieldRow[]> {
  return ex
    .select()
    .from(requirementFields)
    .where(eq(requirementFields.requirementVersionId, versionId))
    .orderBy(asc(requirementFields.category), asc(requirementFields.fieldPath));
}

/**
 * Seed the field skeleton of a questionnaire into a version. Existing paths are left
 * untouched so a package added mid-conversation only adds the new fields (§7).
 */
export async function seedFieldsFromQuestionnaire(
  ex: Executor,
  versionId: string,
  definition: QuestionnaireDefinition,
): Promise<number> {
  const existing = await ex
    .select({ fieldPath: requirementFields.fieldPath })
    .from(requirementFields)
    .where(eq(requirementFields.requirementVersionId, versionId));
  const known = new Set(existing.map((f) => f.fieldPath));
  const missing = definition.fields.filter((f) => !known.has(f.path));
  if (missing.length === 0) return 0;
  const rows = missing.map((f) => ({
    id: uuidv7(),
    requirementVersionId: versionId,
    fieldPath: f.path,
    category: f.category,
    value: null,
    status: 'EMPTY' as RequirementStatus,
    priority: (f.priority ?? (f.mandatory ? 'MUST' : 'NICE_TO_HAVE')) as 'MUST' | 'NICE_TO_HAVE' | 'LATER',
    mandatory: f.mandatory,
    confidence: null,
    sourceMessageId: null,
    sourceRunId: null,
    note: null,
    updatedAt: new Date(),
  }));
  await ex.insert(requirementFields).values(rows);
  return rows.length;
}

export interface FieldMutation {
  fieldPath: string;
  category?: string;
  value?: unknown;
  status: RequirementStatus;
  priority?: 'MUST' | 'NICE_TO_HAVE' | 'LATER';
  sourceMessageId?: string | null;
  sourceRunId?: string | null;
  note?: string | null;
  confidence?: number | null;
  /** why the status changed — stored in field_status_history */
  reason?: string | null;
}

/** Upsert one field and append its status history row. */
export async function upsertRequirementField(
  ex: Executor,
  versionId: string,
  mutation: FieldMutation,
): Promise<{ field: RequirementFieldRow; statusChanged: boolean }> {
  const existingRows = await ex
    .select()
    .from(requirementFields)
    .where(and(eq(requirementFields.requirementVersionId, versionId), eq(requirementFields.fieldPath, mutation.fieldPath)))
    .limit(1);
  const existing = existingRows[0];

  if (!existing) {
    const row: RequirementFieldRow = {
      id: uuidv7(),
      requirementVersionId: versionId,
      fieldPath: mutation.fieldPath,
      category: mutation.category ?? 'dynamic',
      value: mutation.value ?? null,
      status: mutation.status,
      priority: mutation.priority ?? 'NICE_TO_HAVE',
      mandatory: false,
      confidence: mutation.confidence !== undefined && mutation.confidence !== null ? String(mutation.confidence) : null,
      sourceMessageId: mutation.sourceMessageId ?? null,
      sourceRunId: mutation.sourceRunId ?? null,
      note: mutation.note ?? null,
      updatedAt: new Date(),
    };
    await ex.insert(requirementFields).values(row);
    await recordFieldStatusChange(ex, {
      fieldId: row.id,
      fromStatus: null,
      toStatus: mutation.status,
      reason: mutation.reason ?? 'field created',
      messageId: mutation.sourceMessageId ?? null,
      agentRunId: mutation.sourceRunId ?? null,
    });
    return { field: row, statusChanged: true };
  }

  const statusChanged = existing.status !== mutation.status;
  const updated: RequirementFieldRow = {
    ...existing,
    value: mutation.value !== undefined ? mutation.value : existing.value,
    status: mutation.status,
    priority: mutation.priority ?? existing.priority,
    note: mutation.note !== undefined ? mutation.note : existing.note,
    confidence:
      mutation.confidence !== undefined
        ? (mutation.confidence === null ? null : String(mutation.confidence))
        : existing.confidence,
    // §10A: a client-truth status keeps the message that justifies it.
    sourceMessageId: mutation.sourceMessageId !== undefined ? mutation.sourceMessageId : existing.sourceMessageId,
    sourceRunId: mutation.sourceRunId ?? existing.sourceRunId,
    updatedAt: new Date(),
  };
  await ex.update(requirementFields).set(updated).where(eq(requirementFields.id, existing.id));
  if (statusChanged) {
    await recordFieldStatusChange(ex, {
      fieldId: existing.id,
      fromStatus: existing.status,
      toStatus: mutation.status,
      reason: mutation.reason ?? null,
      messageId: mutation.sourceMessageId ?? null,
      agentRunId: mutation.sourceRunId ?? null,
    });
  }
  return { field: updated, statusChanged };
}

export async function recordFieldStatusChange(
  ex: Executor,
  params: {
    fieldId: string;
    fromStatus: RequirementStatus | null;
    toStatus: RequirementStatus;
    reason?: string | null;
    messageId?: string | null;
    agentRunId?: string | null;
  },
): Promise<void> {
  await ex.insert(fieldStatusHistory).values({
    id: uuidv7(),
    fieldId: params.fieldId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    reason: params.reason ?? null,
    messageId: params.messageId ?? null,
    agentRunId: params.agentRunId ?? null,
  });
}

export async function listFieldHistory(ex: Executor, fieldIds: string[]) {
  if (fieldIds.length === 0) return [];
  return ex
    .select()
    .from(fieldStatusHistory)
    .where(inArray(fieldStatusHistory.fieldId, fieldIds))
    .orderBy(asc(fieldStatusHistory.createdAt));
}

// ---------------------------------------------------------------- contradictions

export async function upsertContradiction(
  ex: Executor,
  params: {
    projectId: string;
    requirementVersionId: string;
    fieldA: string;
    fieldB: string;
    description: string;
    severity: 'MAJOR' | 'MINOR' | 'CRITICAL' | 'INFO';
    status?: 'OPEN' | 'CLARIFYING' | 'RESOLVED' | 'ACCEPTED_BY_CLIENT';
    resolutionNote?: string | null;
  },
): Promise<ContradictionRow> {
  const existing = await ex
    .select()
    .from(contradictions)
    .where(and(
      eq(contradictions.requirementVersionId, params.requirementVersionId),
      eq(contradictions.fieldA, params.fieldA),
      eq(contradictions.fieldB, params.fieldB),
    ))
    .limit(1);

  const status = params.status ?? 'OPEN';
  if (existing[0]) {
    const updated: ContradictionRow = {
      ...existing[0],
      description: params.description,
      severity: params.severity as ContradictionRow['severity'],
      status,
      resolutionNote: params.resolutionNote ?? existing[0].resolutionNote,
      resolvedAt: status === 'RESOLVED' ? new Date() : existing[0].resolvedAt,
    };
    await ex.update(contradictions).set(updated).where(eq(contradictions.id, existing[0].id));
    return updated;
  }

  const row: ContradictionRow = {
    id: uuidv7(),
    projectId: params.projectId,
    requirementVersionId: params.requirementVersionId,
    fieldA: params.fieldA,
    fieldB: params.fieldB,
    description: params.description,
    severity: params.severity as ContradictionRow['severity'],
    status,
    resolutionNote: params.resolutionNote ?? null,
    resolvedAt: status === 'RESOLVED' ? new Date() : null,
    createdAt: new Date(),
  };
  await ex.insert(contradictions).values(row);
  return row;
}

export async function listContradictions(ex: Executor, projectId: string): Promise<ContradictionRow[]> {
  return ex
    .select()
    .from(contradictions)
    .where(eq(contradictions.projectId, projectId))
    .orderBy(desc(contradictions.createdAt));
}

/** One call for the inspector API/CLI: current version + its fields (or an empty snapshot). */
export async function listCurrentRequirementSnapshot(ex: Executor, projectId: string): Promise<{
  version: RequirementVersionRow | null;
  fields: RequirementFieldRow[];
}> {
  const version = await getCurrentRequirementVersion(ex, projectId);
  if (!version) return { version: null, fields: [] };
  return { version, fields: await listRequirementFields(ex, version.id) };
}

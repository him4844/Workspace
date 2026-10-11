/**
 * Specification persistence (§14–§19, §34, §35).
 *
 * Everything here is append-only in spirit: versions are created, never edited in place once a
 * client has decided about them; approvals and change requests are their own rows so the full
 * history survives (§34 "never destroy historical project information").
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  acceptanceCriteria, agentRuns, artifacts, changeRequests, clientApprovals,
  specRequirements, specVersions,
} from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import type { ClientSummary, SpecDocument, SpecStatus } from '@wpp/core';

export type SpecVersionRow = typeof specVersions.$inferSelect;
export type SpecRequirementRow = typeof specRequirements.$inferSelect;
export type AcceptanceCriterionRow = typeof acceptanceCriteria.$inferSelect;
export type ClientApprovalRow = typeof clientApprovals.$inferSelect;
export type ChangeRequestRow = typeof changeRequests.$inferSelect;

// ---------------------------------------------------------------- versions

export async function createSpecVersion(
  ex: Executor,
  params: {
    orgId: string;
    projectId: string;
    version: number;
    requirementVersionId?: string | null;
    spec: SpecDocument;
    clientSummaryMd?: string | null;
    changeRequestText?: string | null;
    createdByRunId?: string | null;
    status?: SpecStatus;
  },
): Promise<SpecVersionRow> {
  const rows = await ex
    .insert(specVersions)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      projectId: params.projectId,
      version: params.version,
      status: params.status ?? 'DRAFT',
      requirementVersionId: params.requirementVersionId ?? null,
      spec: params.spec as unknown as object,
      clientSummaryMd: params.clientSummaryMd ?? null,
      changeRequestText: params.changeRequestText ?? null,
      createdByRunId: params.createdByRunId ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function getSpecVersion(ex: Executor, id: string): Promise<SpecVersionRow | null> {
  const rows = await ex.select().from(specVersions).where(eq(specVersions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listSpecVersions(ex: Executor, projectId: string): Promise<SpecVersionRow[]> {
  return ex.select().from(specVersions).where(eq(specVersions.projectId, projectId)).orderBy(asc(specVersions.version));
}

/** The version the project currently works with: newest, excluding superseded ones. */
export async function getCurrentSpecVersion(ex: Executor, projectId: string): Promise<SpecVersionRow | null> {
  const rows = await ex
    .select()
    .from(specVersions)
    .where(and(eq(specVersions.projectId, projectId), ne(specVersions.status, 'SUPERSEDED')))
    .orderBy(desc(specVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

/** The locked/approved version — the one Phase 4 audits and Phase 5 builds from. */
export async function getLockedSpecVersion(ex: Executor, projectId: string): Promise<SpecVersionRow | null> {
  const rows = await ex
    .select()
    .from(specVersions)
    .where(and(eq(specVersions.projectId, projectId), inArray(specVersions.status, ['LOCKED', 'APPROVED'])))
    .orderBy(desc(specVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function setSpecStatus(ex: Executor, id: string, status: SpecStatus, extra: Partial<SpecVersionRow> = {}): Promise<void> {
  await ex
    .update(specVersions)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(specVersions.id, id));
}

export async function markSummarySent(ex: Executor, id: string, messageId: string, at = new Date()): Promise<void> {
  await ex.update(specVersions).set({ summarySentAt: at, summaryMessageId: messageId, updatedAt: at }).where(eq(specVersions.id, id));
}

export async function markApprovalRequested(ex: Executor, id: string, messageId: string, at = new Date()): Promise<void> {
  await ex.update(specVersions).set({ approvalRequestedAt: at, approvalMessageId: messageId, updatedAt: at }).where(eq(specVersions.id, id));
}

export async function setSpecArtifact(ex: Executor, id: string, field: 'specArtifactId' | 'clientSummaryArtifactId', artifactId: string): Promise<void> {
  await ex.update(specVersions).set({ [field]: artifactId, updatedAt: new Date() }).where(eq(specVersions.id, id));
}

/**
 * Lock an approved version (§19). Locking is idempotent and never overwrites a locked row:
 * the guard lives in the SQL predicate, not in the caller.
 */
export async function lockSpecVersion(
  ex: Executor,
  id: string,
  params: { memberId?: string | null; at?: Date } = {},
): Promise<{ locked: boolean; reason?: 'ALREADY_LOCKED' | 'NOT_FOUND' }> {
  const at = params.at ?? new Date();
  const rows = await ex
    .update(specVersions)
    .set({ status: 'LOCKED', lockedAt: at, lockedByMemberId: params.memberId ?? null, updatedAt: at })
    .where(and(eq(specVersions.id, id), ne(specVersions.status, 'LOCKED')))
    .returning();
  if (rows.length > 0) return { locked: true };
  const existing = await getSpecVersion(ex, id);
  return existing ? { locked: false, reason: 'ALREADY_LOCKED' } : { locked: false, reason: 'NOT_FOUND' };
}

export async function supersedeSpecVersion(ex: Executor, id: string): Promise<void> {
  await ex.update(specVersions).set({ status: 'SUPERSEDED', updatedAt: new Date() }).where(eq(specVersions.id, id));
}

// ---------------------------------------------------------------- traceability tables (§16)

export async function insertSpecRequirements(
  ex: Executor,
  specVersionId: string,
  requirements: SpecDocument['requirements'],
): Promise<void> {
  if (requirements.length === 0) return;
  await ex.insert(specRequirements).values(
    requirements.map((req) => ({
      id: uuidv7(),
      specVersionId,
      code: req.code,
      originReqField: req.originReqField ?? null,
      originMessageIds: (req.originMessageIds ?? []) as unknown as object,
      section: req.section,
      title: req.title,
      description: req.description,
      priority: req.priority,
      verificationExpectation: req.verificationExpectation ?? null,
    })),
  );
}

export async function insertAcceptanceCriteria(ex: Executor, specVersionId: string, spec: SpecDocument): Promise<void> {
  const rows = spec.requirements.flatMap((req) =>
    req.acceptanceCriteria.map((ac) => ({
      id: uuidv7(),
      specVersionId,
      specReqCode: req.code,
      code: ac.code,
      text: ac.text,
      testable: ac.testable,
      verificationHint: ac.verificationHint ?? null,
    })),
  );
  if (rows.length === 0) return;
  await ex.insert(acceptanceCriteria).values(rows);
}

export async function listSpecRequirements(ex: Executor, specVersionId: string): Promise<SpecRequirementRow[]> {
  return ex.select().from(specRequirements).where(eq(specRequirements.specVersionId, specVersionId)).orderBy(asc(specRequirements.code));
}

export async function listAcceptanceCriteria(ex: Executor, specVersionId: string): Promise<AcceptanceCriterionRow[]> {
  return ex.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.specVersionId, specVersionId)).orderBy(asc(acceptanceCriteria.code));
}

// ---------------------------------------------------------------- approvals (§19)

export async function recordClientApproval(
  ex: Executor,
  params: {
    orgId: string;
    projectId: string;
    specVersionId: string;
    decision: 'APPROVE' | 'REQUEST_CHANGES';
    sourceMessageId: string;
    confidence: number;
    classification?: 'KEYWORD' | 'AGENT' | 'HUMAN';
    changeItems?: unknown[];
    rawText?: string | null;
  },
): Promise<ClientApprovalRow> {
  const rows = await ex
    .insert(clientApprovals)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      projectId: params.projectId,
      specVersionId: params.specVersionId,
      decision: params.decision,
      sourceMessageId: params.sourceMessageId,
      confidence: String(params.confidence.toFixed(3)),
      classification: params.classification ?? 'KEYWORD',
      changeItems: (params.changeItems ?? []) as unknown as object,
      rawText: params.rawText ?? null,
    })
    .onConflictDoNothing({ target: clientApprovals.sourceMessageId })
    .returning();
  if (rows.length > 0) return rows[0]!;
  const existing = await ex.select().from(clientApprovals).where(eq(clientApprovals.sourceMessageId, params.sourceMessageId)).limit(1);
  return existing[0]!;
}

export async function getApprovalForMessage(ex: Executor, messageId: string): Promise<ClientApprovalRow | null> {
  const rows = await ex.select().from(clientApprovals).where(eq(clientApprovals.sourceMessageId, messageId)).limit(1);
  return rows[0] ?? null;
}

export async function listClientApprovals(ex: Executor, projectId: string): Promise<ClientApprovalRow[]> {
  return ex.select().from(clientApprovals).where(eq(clientApprovals.projectId, projectId)).orderBy(asc(clientApprovals.createdAt));
}

// ---------------------------------------------------------------- change requests (§35)

export async function createChangeRequest(
  ex: Executor,
  params: {
    orgId: string;
    projectId: string;
    specVersionId?: string | null;
    requestedChange: string;
    source: string;
    reason?: string | null;
    affectedRequirements?: string[];
    affectedSpecSections?: string[];
    potentialImpact?: string | null;
    createdByMemberId?: string | null;
    status?: ChangeRequestRow['status'];
  },
): Promise<ChangeRequestRow> {
  const rows = await ex
    .insert(changeRequests)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      projectId: params.projectId,
      specVersionId: params.specVersionId ?? null,
      requestedChange: params.requestedChange,
      source: params.source,
      reason: params.reason ?? null,
      affectedRequirements: (params.affectedRequirements ?? []) as unknown as object,
      affectedSpecSections: (params.affectedSpecSections ?? []) as unknown as object,
      potentialImpact: params.potentialImpact ?? null,
      status: params.status ?? 'REQUESTED',
      createdByMemberId: params.createdByMemberId ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function listChangeRequests(ex: Executor, projectId: string): Promise<ChangeRequestRow[]> {
  return ex.select().from(changeRequests).where(eq(changeRequests.projectId, projectId)).orderBy(desc(changeRequests.createdAt));
}

export async function updateChangeRequestStatus(
  ex: Executor,
  id: string,
  params: { status: ChangeRequestRow['status']; resultingSpecVersionId?: string | null; decidedByMemberId?: string | null },
): Promise<void> {
  await ex
    .update(changeRequests)
    .set({
      status: params.status,
      resultingSpecVersionId: params.resultingSpecVersionId ?? null,
      decidedByMemberId: params.decidedByMemberId ?? null,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(changeRequests.id, id));
}

// ---------------------------------------------------------------- inspection

export interface SpecSnapshot {
  version: SpecVersionRow;
  requirements: SpecRequirementRow[];
  acceptanceCriteria: AcceptanceCriterionRow[];
  approvals: ClientApprovalRow[];
  changeRequests: ChangeRequestRow[];
  specArtifact: typeof artifacts.$inferSelect | null;
  summaryArtifact: typeof artifacts.$inferSelect | null;
  agentRuns: Array<typeof agentRuns.$inferSelect>;
}

export async function listSpecSnapshot(ex: Executor, specVersionId: string): Promise<SpecSnapshot | null> {
  const version = await getSpecVersion(ex, specVersionId);
  if (!version) return null;
  const [requirements, criteria, approvals, changes, specArtifact, summaryArtifact, runs] = await Promise.all([
    listSpecRequirements(ex, specVersionId),
    listAcceptanceCriteria(ex, specVersionId),
    listClientApprovals(ex, version.projectId),
    listChangeRequests(ex, version.projectId),
    version.specArtifactId ? ex.select().from(artifacts).where(eq(artifacts.id, version.specArtifactId)).limit(1) : Promise.resolve([]),
    version.clientSummaryArtifactId ? ex.select().from(artifacts).where(eq(artifacts.id, version.clientSummaryArtifactId)).limit(1) : Promise.resolve([]),
    ex.select().from(agentRuns).where(eq(agentRuns.projectId, version.projectId)).orderBy(desc(agentRuns.startedAt)).limit(50),
  ]);
  return {
    version,
    requirements,
    acceptanceCriteria: criteria,
    approvals,
    changeRequests: changes,
    specArtifact: specArtifact[0] ?? null,
    summaryArtifact: summaryArtifact[0] ?? null,
    agentRuns: runs.filter((r) => r.agentType === 'SPECIFICATION'),
  };
}

/** Count helper used by the traceability view. */
export async function countSpecVersions(ex: Executor, projectId: string): Promise<number> {
  const rows = await ex.select({ n: sql<number>`count(*)::int` }).from(specVersions).where(eq(specVersions.projectId, projectId));
  return rows[0]?.n ?? 0;
}

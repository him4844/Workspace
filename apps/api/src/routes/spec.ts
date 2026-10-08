/**
 * Specification inspection + the §35 change-request path (Phase 3).
 *
 * Auth: `X-Internal-Token` (the same guard as the rest of `/api/v1/*`; real sessions arrive with
 * the Team Panel in Phase 7). Two rules are enforced HERE, not just in the UI:
 *   1. a locked/approved specification cannot be edited in place — the API answers
 *      `409 SPEC_IS_LOCKED` and the only way forward is a change request (§19/§35);
 *   2. every accepted edit is recorded as an event, so nothing about a specification changes
 *      silently (§34).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  artifactsRepo, getProject, identityRepo, obsRepo, orgRepo, projectsRepo, queueRepo,
  schema, specsRepo,
} from '@wpp/db';
import { assertSpecWritable, deriveApprovalStep, isChangeRequestStatus, type SpecDocument } from '@wpp/core';
import { readArtifact } from '@wpp/infra';
import type { AppDeps } from '../app.js';

const EditSchema = z.object({
  code: z.string().regex(/^SPEC-REQ-\d{3,}$/),
  title: z.string().min(3).max(160).optional(),
  description: z.string().min(10).max(2000).optional(),
  priority: z.enum(['MUST', 'NICE_TO_HAVE', 'LATER']).optional(),
  reason: z.string().min(3).max(500),
});

const ChangeRequestSchema = z.object({
  requestedChange: z.string().min(5).max(2000),
  source: z.string().min(3).max(120).optional(),
  reason: z.string().max(500).optional(),
  affectedRequirements: z.array(z.string()).max(50).optional(),
  affectedSpecSections: z.array(z.string()).max(50).optional(),
  potentialImpact: z.string().max(1000).optional(),
});

const StatusSchema = z.object({
  status: z.enum(['REQUESTED', 'ANALYZING', 'APPROVED', 'REJECTED', 'IMPLEMENTING', 'COMPLETED']),
  resultingSpecVersionId: z.string().optional(),
});

export async function registerSpecRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1')) return;
    const token = request.headers['x-internal-token'];
    if (token !== config.INTERNAL_API_TOKEN) {
      return reply.status(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'X-Internal-Token required' } });
    }
  });

  /** Everything a human needs to review a specification: version, traceability, summary, history. */
  app.get('/api/v1/projects/:id/spec', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { version?: string };
    const project = await getProject(db, id);
    if (!project) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } });

    const versions = await specsRepo.listSpecVersions(db, id);
    const current = query.version
      ? versions.find((v) => v.version === Number(query.version)) ?? null
      : versions.filter((v) => v.status !== 'SUPERSEDED').at(-1) ?? null;
    if (!current) {
      return reply.send({
        ok: true,
        data: { projectId: id, state: project.state, version: null, versions: versions.map(versionSummary), approvalStep: 'SEND_SUMMARY', requirements: [], acceptanceCriteria: [], approvals: [], changeRequests: [] },
      });
    }

    const [snapshot, requirementsArtifact] = await Promise.all([
      specsRepo.listSpecSnapshot(db, current.id),
      current.specArtifactId ? artifactsRepo.getArtifact(db, current.specArtifactId) : Promise.resolve(null),
    ]);
    const approvals = await specsRepo.listClientApprovals(db, id);
    const requirementVersion = await projectsRepo.getProject(db, id);

    return reply.send({
      ok: true,
      data: {
        projectId: id,
        state: project.state,
        version: versionSummary(current),
        versions: versions.map(versionSummary),
        // §18: where the two-step approval stands right now (summary sent -> client replied -> asked).
        approvalStep: deriveApprovalStep({
          summarySentAt: current.summarySentAt,
          approvalRequestedAt: current.approvalRequestedAt,
          decidedAt: current.status === 'LOCKED' || current.status === 'APPROVED' ? current.lockedAt ?? current.createdAt : null,
        }),
        spec: current.spec as SpecDocument,
        summaryMarkdown: current.clientSummaryMd,
        requirements: (snapshot?.requirements ?? []).map((r) => ({
          code: r.code,
          originReqField: r.originReqField,
          originMessageIds: r.originMessageIds,
          section: r.section,
          title: r.title,
          description: r.description,
          priority: r.priority,
          acceptanceCriteria: (snapshot?.acceptanceCriteria ?? [])
            .filter((ac) => ac.specReqCode === r.code)
            .map((ac) => ({ code: ac.code, text: ac.text, testable: ac.testable, verificationHint: ac.verificationHint })),
        })),
        acceptanceCriteria: snapshot?.acceptanceCriteria ?? [],
        approvals: approvals.map((a) => ({
          id: a.id, decision: a.decision, sourceMessageId: a.sourceMessageId, confidence: Number(a.confidence),
          classification: a.classification, changeItems: a.changeItems, createdAt: a.createdAt,
        })),
        changeRequests: (snapshot?.changeRequests ?? []).map((c) => ({
          id: c.id, requestedChange: c.requestedChange, source: c.source, status: c.status,
          affectedRequirements: c.affectedRequirements, affectedSpecSections: c.affectedSpecSections,
          potentialImpact: c.potentialImpact, createdAt: c.createdAt, decidedAt: c.decidedAt,
        })),
        artifacts: {
          spec: current.specArtifactId ? { id: current.specArtifactId, path: requirementsArtifact?.path ?? null } : null,
          clientSummary: current.clientSummaryArtifactId
            ? { id: current.clientSummaryArtifactId, path: (await artifactsRepo.getArtifact(db, current.clientSummaryArtifactId))?.path ?? null }
            : null,
        },
        specArtifactMarkdown: requirementsArtifact ? readArtifact(requirementsArtifact.path) : null,
        projectState: requirementVersion?.state,
        // §34: the client's exact approval evidence is always one query away.
        approvalMessageIds: approvals.map((a) => a.sourceMessageId),
      },
    });
  });

  /** A single specification requirement's row (traceability detail). */
  app.get('/api/v1/projects/:id/spec/requirements/:code', async (request, reply) => {
    const { id, code } = request.params as { id: string; code: string };
    const versions = await specsRepo.listSpecVersions(db, id);
    const current = versions.filter((v) => v.status !== 'SUPERSEDED').at(-1) ?? null;
    if (!current) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'no specification for this project' } });
    const requirements = await specsRepo.listSpecRequirements(db, current.id);
    const row = requirements.find((r) => r.code === code);
    if (!row) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: `${code} not found in v${current.version}` } });
    const criteria = (await specsRepo.listAcceptanceCriteria(db, current.id)).filter((ac) => ac.specReqCode === code);
    return reply.send({ ok: true, data: { version: versionSummary(current), requirement: row, acceptanceCriteria: criteria } });
  });

  /**
   * In-place edit of a specification requirement. Allowed only while the version is not locked;
   * once the client approved, the answer is 409 + "make a change request" (§19/§35).
   */
  app.patch('/api/v1/projects/:id/spec', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = EditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    const project = await getProject(db, id);
    if (!project) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } });

    const current = await specsRepo.getCurrentSpecVersion(db, id);
    if (!current) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'no specification for this project' } });

    const writable = assertSpecWritable(current.status);
    if (!writable.ok) {
      return reply.status(409).send({
        ok: false,
        error: {
          code: writable.code,
          message: writable.message,
          details: { specVersion: current.version, status: current.status, changeRequestEndpoint: `/api/v1/projects/${id}/change-requests` },
        },
      });
    }

    const requirements = await specsRepo.listSpecRequirements(db, current.id);
    const target = requirements.find((r) => r.code === parsed.data.code);
    if (!target) {
      return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: `${parsed.data.code} not found in v${current.version}` } });
    }

    const patch = {
      title: parsed.data.title ?? target.title,
      description: parsed.data.description ?? target.description,
      priority: parsed.data.priority ?? target.priority,
    };
    await db.update(schema.specRequirements).set(patch).where(eq(schema.specRequirements.id, target.id));

    // The version's spec object is the artifact Phase 4/5 will read: keep it in step with the table.
    const spec = current.spec as SpecDocument;
    const nextSpec: SpecDocument = {
      ...spec,
      requirements: spec.requirements.map((r) => (r.code === target.code ? { ...r, ...patch } : r)),
    };
    await specsRepo.setSpecStatus(db, current.id, current.status, { spec: nextSpec as unknown as Record<string, unknown> });

    await obsRepo.recordEvent(db, {
      orgId: project.orgId,
      projectId: id,
      type: 'HUMAN_ACTION',
      actorType: 'HUMAN',
      payload: { action: 'spec-edit', specVersion: current.version, code: target.code, reason: parsed.data.reason, patch },
    });

    return reply.send({ ok: true, data: { specVersion: current.version, code: target.code, updated: patch } });
  });

  /** §35 — the only way to change a locked specification. */
  app.post('/api/v1/projects/:id/change-requests', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    const project = await getProject(db, id);
    if (!project) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } });

    const current = await specsRepo.getCurrentSpecVersion(db, id);
    const changeRequest = await specsRepo.createChangeRequest(db, {
      orgId: project.orgId,
      projectId: id,
      specVersionId: current?.id ?? null,
      requestedChange: parsed.data.requestedChange,
      source: parsed.data.source ?? 'TEAM',
      reason: parsed.data.reason ?? null,
      affectedRequirements: parsed.data.affectedRequirements,
      affectedSpecSections: parsed.data.affectedSpecSections,
      potentialImpact: parsed.data.potentialImpact ?? null,
    });

    await obsRepo.recordEvent(db, {
      orgId: project.orgId,
      projectId: id,
      type: 'CHANGE_REQUEST',
      actorType: 'HUMAN',
      severity: current?.status === 'LOCKED' ? 'INFO' : 'MINOR',
      payload: {
        changeRequestId: changeRequest.id,
        specVersion: current?.version ?? null,
        specLocked: current?.status === 'LOCKED',
        requestedChange: changeRequest.requestedChange.slice(0, 300),
      },
    });

    return reply.status(201).send({
      ok: true,
      data: {
        id: changeRequest.id,
        status: changeRequest.status,
        specVersion: current?.version ?? null,
        specStatus: current?.status ?? null,
        note: 'Approved versions are immutable (§19). Approve this change request to schedule a new specification version.',
      },
    });
  });

  app.get('/api/v1/projects/:id/change-requests', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rows = await specsRepo.listChangeRequests(db, id);
    return reply.send({
      ok: true,
      data: rows.map((c) => ({
        id: c.id, requestedChange: c.requestedChange, source: c.source, reason: c.reason,
        status: c.status, affectedRequirements: c.affectedRequirements, affectedSpecSections: c.affectedSpecSections,
        potentialImpact: c.potentialImpact, resultingSpecVersionId: c.resultingSpecVersionId,
        createdAt: c.createdAt, decidedAt: c.decidedAt,
      })),
    });
  });

  /** Human decision on a change request. APPROVED + a spec version ⇒ the revision job is queued. */
  app.patch('/api/v1/change-requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = StatusSchema.safeParse(request.body);
    if (!parsed.success || !isChangeRequestStatus(parsed.data.status)) {
      return reply.status(400).send({ ok: false, error: { code: 'VALIDATION', message: 'status must be one of REQUESTED|ANALYZING|APPROVED|REJECTED|IMPLEMENTING|COMPLETED' } });
    }
    const row = (await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)).limit(1))[0];
    if (!row) return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'change request not found' } });

    await specsRepo.updateChangeRequestStatus(db, id, {
      status: parsed.data.status,
      resultingSpecVersionId: parsed.data.resultingSpecVersionId ?? null,
    });

    let queuedJobId: string | null = null;
    if (parsed.data.status === 'APPROVED' || parsed.data.status === 'IMPLEMENTING') {
      const conversation = row.projectId ? await openConversationFor(db, row.projectId) : null;
      if (conversation) {
        const { job } = await queueRepo.enqueueJob(db, {
          orgId: row.orgId,
          type: 'SPEC_REVISE',
          projectId: row.projectId,
          payload: { conversationId: conversation, changeText: row.requestedChange, changeItems: [], changeRequestId: id },
          idempotencyKey: `spec-revise-cr:${id}`,
        });
        queuedJobId = job.id;
      }
    }

    await obsRepo.recordEvent(db, {
      orgId: row.orgId, projectId: row.projectId, type: 'CHANGE_REQUEST', actorType: 'HUMAN',
      payload: { changeRequestId: id, status: parsed.data.status, queuedJobId },
    });

    return reply.send({ ok: true, data: { id, status: parsed.data.status, queuedJobId } });
  });

  /** Team-side label config used by the summary messages (§18) — read-only here. */
  app.get('/api/v1/spec-config', async (_request, reply) => {
    const [approve, change, threshold] = await Promise.all([
      orgRepo.getConfigValue<string>(db, 'spec.approve_label'),
      orgRepo.getConfigValue<string>(db, 'spec.request_changes_label'),
      orgRepo.getConfigValue<number>(db, 'spec.approval_confidence_threshold'),
    ]);
    return reply.send({ ok: true, data: { approveLabel: approve, requestChangesLabel: change, approvalConfidenceThreshold: threshold } });
  });
}

function versionSummary(v: {
  id: string; version: number; status: string; createdAt: Date; lockedAt: Date | null;
  summarySentAt: Date | null; approvalRequestedAt: Date | null; changeRequestText: string | null;
}) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    createdAt: v.createdAt,
    summarySentAt: v.summarySentAt,
    approvalRequestedAt: v.approvalRequestedAt,
    lockedAt: v.lockedAt,
    changeRequestText: v.changeRequestText,
  };
}

async function openConversationFor(db: AppDeps['db'], projectId: string): Promise<string | null> {
  const rows = await db
    .select({ conversationId: schema.projects.conversationId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows[0]?.conversationId ?? null;
}

export { identityRepo };

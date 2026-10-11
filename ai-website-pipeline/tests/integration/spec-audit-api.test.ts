import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { auditsRepo, obsRepo, orgRepo, projectsRepo, specsRepo } from '@wpp/db';
import { getConnectionForChannel } from '../../apps/api/src/services/context.js';
import { buildTestApp, createTestContext, type TestContext } from '../helpers/context.js';

/** The §20 inspector endpoint must be usable over the actual Fastify HTTP surface. */
describe('GET /api/v1/projects/:id/spec-audit (HTTP integration)', () => {
  let ctx: TestContext;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let projectId: string;
  let orgId: string;
  let specVersionId: string;

  beforeEach(async () => {
    ctx = await createTestContext({ DEFAULT_LOCALE: 'uz' });
    orgId = await orgRepo.getOrCreateDefaultOrg(ctx.handle.db);
    const connectionId = (await getConnectionForChannel(ctx.handle.db, 'SIMULATOR')).id;
    const payload = buildSimulatorPayload({ accountId: connectionId, senderId: 'igsid_audit_api', text: 'Salom, restoran sayti kerak', mid: `audit-api-${Date.now()}` });
    const [event] = parseInstagramWebhook(payload as never);
    const ingested = await ingestInboundEvent(ctx.handle.db, {
      orgId, connectionId, channel: 'SIMULATOR', event: event!, turnJobType: 'ECHO_REPLY',
    });
    projectId = ingested.projectId!;
    const specVersion = await specsRepo.createSpecVersion(ctx.handle.db, {
      orgId, projectId, version: 1, status: 'LOCKED',
      spec: { meta: { projectType: 'RESTAURANT', generatedFromRequirementsVersion: 1 }, requirements: [], openQuestions: [] },
    });
    specVersionId = specVersion.id;
    await auditsRepo.recordAudit(ctx.handle.db, {
      orgId, projectId, specVersionId, cycleKey: specVersionId, attempt: 1, maxAttempts: 3,
      status: 'FAIL', score: 42,
      verdict: {
        status: 'FAIL', score: 42, criticalIssues: [], warnings: [],
        missingRequirements: [{ code: 'MISSING_SPEC_REQ', severity: 'CRITICAL', description: 'Menu is missing' }],
        contradictions: [], ambiguities: [], recommendations: [],
        checks: { completeness: 'FAIL', consistency: 'PASS', ambiguity: 'PASS', codingReadiness: 'FAIL', clientAlignment: 'PASS' },
        modelStatus: 'PASS', structuralForcedFail: true,
      },
      structuralFindings: [{ code: 'MISSING_SPEC_REQ', severity: 'CRITICAL', description: 'Menu is missing' }],
      structuralForcedFail: true, modelFailed: false,
      provider: 'openrouter', model: 'cohere/north-mini-code:free',
    });
    await obsRepo.createTask(ctx.handle.db, {
      orgId, projectId, type: 'HUMAN_REVIEW', priority: 'CRITICAL',
      title: 'Specification blocked', reason: 'Three audit attempts failed.', suggestedAction: 'Review the spec.',
    });
    app = await buildTestApp(ctx);
  });

  afterEach(async () => {
    await app.close();
    await ctx.close();
  });

  it('requires the internal token and serves the latest verdict, attempts, and human tasks', async () => {
    const denied = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/spec-audit` });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/spec-audit`,
      headers: { 'x-internal-token': ctx.config.INTERNAL_API_TOKEN },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.latest).toMatchObject({
      attempt: 1, maxAttempts: 3, status: 'FAIL', score: 42,
      provider: 'openrouter', model: 'cohere/north-mini-code:free', structuralForcedFail: true,
    });
    expect(body.data.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 'FAIL', score: 42 })]);
    expect(body.data.openTasks).toEqual([expect.objectContaining({ type: 'HUMAN_REVIEW', priority: 'CRITICAL' })]);
  });

  it('returns 404 for a missing project', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/projects/not-a-real-project/spec-audit',
      headers: { 'x-internal-token': ctx.config.INTERNAL_API_TOKEN },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

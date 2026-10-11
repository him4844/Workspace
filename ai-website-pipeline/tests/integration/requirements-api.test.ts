/**
 * Phase 2 acceptance through the HTTP surface the team panel will use (§45, docs/13):
 * the structured requirements of a project are inspectable, and the endpoint is protected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSimulatorPayload, ingestInboundEvent, parseInstagramWebhook } from '@wpp/channels';
import { projectsRepo, schema } from '@wpp/db';
import { tick } from '../../apps/worker/src/orchestrator.js';
import { getConnectionForChannel, getDefaultOrgId } from '../../apps/api/src/services/context.js';
import { buildTestApp, createTestContext, silentLogger, type TestContext } from '../helpers/context.js';
import { createPersonaLlm, seedPhase2 } from '../helpers/phase2.js';

describe('GET /api/v1/projects/:id/requirements', () => {
  let ctx: TestContext;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let orgId: string;
  let connectionId: string;
  let projectId: string;
  let conversationId: string;

  const headers = { 'x-internal-token': 'test-internal-token' };

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await buildTestApp(ctx);
    orgId = await seedPhase2(ctx);
    connectionId = (await getConnectionForChannel(ctx.handle.db, 'SIMULATOR')).id;

    const llm = createPersonaLlm();
    const payload = buildSimulatorPayload({
      accountId: connectionId, senderId: 'igsid_api', text: 'Restoranim uchun sayt kerak', mid: 'api_mid_1',
    });
    const [event] = parseInstagramWebhook(payload as never);
    await ingestInboundEvent(ctx.handle.db, { orgId, connectionId, channel: 'SIMULATOR', event: event!, turnJobType: 'REQUIREMENTS_TURN' });
    await tick({ db: ctx.handle.db, config: ctx.config, logger: silentLogger(), workerId: 'api-test', llm });

    const [conversation] = await ctx.handle.db.select().from(schema.conversations).limit(1);
    conversationId = conversation!.id;
    projectId = (await projectsRepo.findOpenProjectForConversation(ctx.handle.db, conversationId))!.id;
  });

  afterEach(async () => {
    await app.close();
    await ctx.close();
  });

  it('returns the version, every field with its §10A status, and the pending state', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/requirements`, headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      data: {
        projectType: string;
        state: string;
        version: { completeness: number; vision: unknown; summaryArtifactId: string | null };
        fields: Array<{ fieldPath: string; status: string; mandatory: boolean; sourceMessageId: string | null }>;
        contradictions: unknown[];
        summary: unknown;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.projectType).toBe('RESTAURANT');
    expect(body.data.state).toBe('REQUIREMENTS_IN_PROGRESS');
    expect(body.data.version.completeness).toBeLessThan(1);

    const paths = body.data.fields.map((f) => f.fieldPath);
    expect(paths).toContain('business_purpose.purpose');
    // the RESTAURANT package was merged from the first message hint (§7)
    expect(paths).toContain('reservations.enabled');
    const mandatory = body.data.fields.filter((f) => f.mandatory);
    expect(mandatory.length).toBeGreaterThanOrEqual(18);
    // seeded fields start as EMPTY — the panel shows exactly what is still missing
    expect(mandatory.every((f) => ['EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED', 'CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE'].includes(f.status))).toBe(true);
    expect(body.data.contradictions).toEqual([]);
    expect(body.data.summary).toBeNull();
  });

  it('requires the internal token and a real project', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/requirements` });
    expect(unauthorized.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET', url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/requirements', headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});

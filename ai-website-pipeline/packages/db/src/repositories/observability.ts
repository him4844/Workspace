import { desc, eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { agentRuns, events, tasks } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import type { ActorType, Severity } from '@wpp/core';

export type EventTypeLike =
  | 'PROJECT_CREATED' | 'STATE_CHANGED' | 'MESSAGE_INBOUND' | 'MESSAGE_OUTBOUND' | 'MESSAGE_SEND_BLOCKED'
  | 'REQUIREMENTS_COMPLETE' | 'PROJECT_TYPE_DETECTED' | 'SPEC_GENERATED' | 'SPEC_LOCKED' | 'SPEC_AUDIT_RESULT' | 'BUILD_STARTED' | 'BUILD_FINISHED'
  | 'SPEC_TRACEABILITY_FAILED' | 'SPEC_SUMMARY_INCONSISTENT'
  | 'CODE_CHECK_RESULT' | 'TASK_CREATED' | 'TASK_STATUS_CHANGED' | 'APPROVAL_RECORDED' | 'CHANGE_REQUEST'
  | 'AGENT_RUN_FINISHED' | 'HUMAN_ACTION' | 'SECURITY_ALERT' | 'SYSTEM_ERROR' | 'WEBHOOK_RECEIVED' | 'WEBHOOK_DUPLICATE';

export async function recordEvent(
  ex: Executor,
  params: {
    orgId: string;
    projectId?: string | null;
    type: EventTypeLike;
    actorType?: ActorType;
    actorId?: string | null;
    payload?: Record<string, unknown>;
    severity?: Severity;
  },
): Promise<string> {
  const id = uuidv7();
  await ex.insert(events).values({
    id,
    orgId: params.orgId,
    projectId: params.projectId ?? null,
    type: params.type,
    actorType: params.actorType ?? 'SYSTEM',
    actorId: params.actorId ?? null,
    payload: (params.payload ?? {}) as object,
    severity: params.severity ?? 'INFO',
  });
  return id;
}

export async function listEvents(ex: Executor, projectId: string, limit = 200) {
  return ex.select().from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.createdAt)).limit(limit);
}

// ---------------------------------------------------------------- agent runs (SPEC §36)

export async function startAgentRun(
  ex: Executor,
  params: {
    agentType: 'REQUIREMENTS' | 'SPECIFICATION' | 'SPEC_AUDITOR' | 'CODING' | 'CODE_CHECKER' | 'TEAM_ASSISTANT';
    projectId?: string | null;
    conversationId?: string | null;
    jobId?: string | null;
    model?: string | null;
    provider?: string | null;
    configVersionId?: string | null;
    inputSummary?: Record<string, unknown>;
  },
): Promise<string> {
  const id = uuidv7();
  await ex.insert(agentRuns).values({
    id,
    agentType: params.agentType,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId ?? null,
    jobId: params.jobId ?? null,
    model: params.model ?? null,
    provider: params.provider ?? null,
    configVersionId: params.configVersionId ?? null,
    inputSummary: (params.inputSummary ?? {}) as object,
    status: 'RUNNING',
    startedAt: new Date(),
  });
  return id;
}

export async function finishAgentRun(
  ex: Executor,
  runId: string,
  params: {
    status: 'SUCCESS' | 'FAILED' | 'NEEDS_REVIEW';
    nextAction?: string | null;
    confidence?: number | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    provider?: string | null;
    model?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    costUsd?: string | null;
  },
): Promise<void> {
  const started = await ex.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const startedAt = started[0]?.startedAt ?? new Date();
  await ex
    .update(agentRuns)
    .set({
      status: params.status,
      finishedAt: new Date(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      nextAction: params.nextAction ?? null,
      confidence: params.confidence != null ? String(params.confidence) : null,
      errorCode: params.errorCode ?? null,
      errorDetail: params.errorDetail ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
      promptTokens: params.promptTokens ?? null,
      completionTokens: params.completionTokens ?? null,
      costUsd: params.costUsd ?? null,
    })
    .where(eq(agentRuns.id, runId));
}

export async function listAgentRuns(ex: Executor, opts: { projectId?: string; limit?: number } = {}) {
  const q = opts.projectId
    ? ex.select().from(agentRuns).where(eq(agentRuns.projectId, opts.projectId))
    : ex.select().from(agentRuns);
  return q.orderBy(desc(agentRuns.createdAt)).limit(opts.limit ?? 50);
}

// ---------------------------------------------------------------- tasks (SPEC §29, §42)

export async function createTask(
  ex: Executor,
  params: {
    orgId: string;
    projectId?: string | null;
    type: 'HUMAN_REVIEW' | 'PRICE_DECISION' | 'DEADLINE_DECISION' | 'CLIENT_SILENT' | 'SCOPE_CHANGE' | 'MANUAL_SEND' | 'DELIVERY_PREP' | 'OTHER';
    title: string;
    reason: string;
    description?: string;
    priority?: Severity;
    suggestedAction?: string;
    aiReport?: Record<string, unknown>;
  },
): Promise<string> {
  const id = uuidv7();
  await ex.insert(tasks).values({
    id,
    orgId: params.orgId,
    projectId: params.projectId ?? null,
    type: params.type,
    title: params.title,
    reason: params.reason,
    description: params.description ?? null,
    priority: params.priority ?? 'MAJOR',
    suggestedAction: params.suggestedAction ?? null,
    aiReport: (params.aiReport ?? {}) as object,
    status: 'OPEN',
  });
  return id;
}

export async function listOpenTasks(ex: Executor, projectId?: string) {
  const q = projectId
    ? ex.select().from(tasks).where(eq(tasks.projectId, projectId))
    : ex.select().from(tasks);
  return q.orderBy(desc(tasks.createdAt)).limit(100);
}

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { events, loopCounters, projects, projectStateTransitions } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import {
  buildTransitionRecord,
  TRANSITIONS,
  type ActorType, type GuardContext, type ProjectState, type TransitionId,
} from '@wpp/core';

export type ProjectRow = typeof projects.$inferSelect;

export async function getProject(ex: Executor, id: string): Promise<ProjectRow | null> {
  const rows = await ex.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

/** An "open" project = not completed/failed and not blocked-by-a-human. */
export async function findOpenProjectForConversation(ex: Executor, conversationId: string): Promise<ProjectRow | null> {
  const rows = await ex
    .select()
    .from(projects)
    .where(and(eq(projects.conversationId, conversationId), notInArray(projects.state, ['COMPLETED', 'FAILED'])))
    .orderBy(desc(projects.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listProjects(ex: Executor, opts: { states?: ProjectState[]; limit?: number } = {}): Promise<ProjectRow[]> {
  const base = ex.select().from(projects);
  const q = opts.states && opts.states.length > 0
    ? base.where(inArray(projects.state, opts.states))
    : base;
  return q.orderBy(desc(projects.createdAt)).limit(opts.limit ?? 100);
}

export async function createProject(
  ex: Executor,
  params: { orgId: string; clientId: string; conversationId: string; name?: string | null },
): Promise<ProjectRow> {
  const id = uuidv7();
  await ex.insert(projects).values({
    id,
    orgId: params.orgId,
    clientId: params.clientId,
    conversationId: params.conversationId,
    name: params.name ?? null,
    state: 'NEW',
  });
  return (await getProject(ex, id))!;
}

export async function countProjects(ex: Executor): Promise<number> {
  const rows = await ex.select({ n: sql<number>`count(*)` }).from(projects);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------- state machine application

export interface ApplyTransitionInput {
  projectId: string;
  transitionId: TransitionId;
  context?: GuardContext;
  actorType?: ActorType;
  actorId?: string | null;
  reason?: string;
  /** extra facts recorded in the transition row for debugging/audit */
  meta?: Record<string, unknown>;
}

export interface ApplyTransitionResult {
  from: ProjectState;
  to: ProjectState;
  recordId: string;
}

/**
 * Apply a transition: validate with the pure state machine, then persist
 * state change + transition row + STATE_CHANGED event atomically (docs/01 §5).
 * Callers MUST pass a transaction executor when the transition has further effects.
 */
export async function applyTransition(ex: Executor, input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  const project = await getProject(ex, input.projectId);
  if (!project) throw new Error(`project ${input.projectId} not found`);
  const from = project.state as ProjectState;

  const record = buildTransitionRecord(input.transitionId, from, input.context ?? {}, {
    actorType: input.actorType,
    reason: input.reason,
  });

  const def = TRANSITIONS[input.transitionId];
  await ex
    .update(projects)
    .set({
      state: record.to,
      blockedFrom: record.to === 'BLOCKED' ? from : project.blockedFrom,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, input.projectId));

  const recordId = uuidv7();
  await ex.insert(projectStateTransitions).values({
    id: recordId,
    projectId: input.projectId,
    transitionId: record.transitionId,
    fromState: record.from,
    toState: record.to,
    actorType: record.actorType,
    actorId: input.actorId ?? null,
    trigger: def.trigger,
    reason: record.reason ?? null,
    contextJson: (input.meta ?? {}) as object,
  });

  await ex.insert(events).values({
    id: uuidv7(),
    orgId: project.orgId,
    projectId: input.projectId,
    type: 'STATE_CHANGED',
    actorType: record.actorType,
    actorId: input.actorId ?? null,
    payload: { transitionId: record.transitionId, from: record.from, to: record.to } as object,
  });

  return { from: record.from, to: record.to, recordId };
}

export async function listTransitions(ex: Executor, projectId: string) {
  return ex
    .select()
    .from(projectStateTransitions)
    .where(eq(projectStateTransitions.projectId, projectId))
    .orderBy(projectStateTransitions.createdAt);
}

// ---------------------------------------------------------------- loop counters

export async function getLoopCounter(ex: Executor, projectId: string, scope: string, key = 'attempts'): Promise<number> {
  const rows = await ex
    .select()
    .from(loopCounters)
    .where(and(eq(loopCounters.projectId, projectId), eq(loopCounters.scope, scope), eq(loopCounters.key, key)))
    .limit(1);
  return rows[0]?.value ?? 0;
}

/**
 * Increment a persisted loop counter (SPEC §21, §26 — survives restarts, docs/05 §4).
 */
export async function incrementLoopCounter(ex: Executor, projectId: string, scope: string, key = 'attempts'): Promise<number> {
  const rows = await ex
    .insert(loopCounters)
    .values({ projectId, scope, key, value: 1 })
    .onConflictDoUpdate({
      target: [loopCounters.projectId, loopCounters.scope, loopCounters.key],
      set: { value: sql`${loopCounters.value} + 1`, updatedAt: new Date() },
    })
    .returning({ value: loopCounters.value });
  return rows[0]?.value ?? 1;
}

export async function resetLoopCounter(ex: Executor, projectId: string, scope: string, key = 'attempts'): Promise<void> {
  await ex
    .insert(loopCounters)
    .values({ projectId, scope, key, value: 0 })
    .onConflictDoUpdate({
      target: [loopCounters.projectId, loopCounters.scope, loopCounters.key],
      set: { value: 0, updatedAt: new Date() },
    });
}

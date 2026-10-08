/**
 * Spec-audit persistence (§20, §21). Append-only: an audit row is never edited — a new attempt is a
 * new row. The §21 counter is derived from these rows (attempts inside one cycle), so a restart or a
 * crashed worker cannot lose the loop budget and re-open an infinite revision loop.
 */
import { and, asc, desc, eq, max } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { specAudits } from '../schema.js';
import { uuidv7 } from '@wpp/infra';
import type { AuditIssue, AuditChecks } from '@wpp/core';

export type SpecAuditRow = typeof specAudits.$inferSelect;

export interface RecordAuditInput {
  orgId: string;
  projectId: string;
  specVersionId: string;
  /** spec_version_id of the client-approved version that started this audit cycle */
  cycleKey: string;
  attempt: number;
  maxAttempts: number;
  status: 'PASS' | 'FAIL';
  score: number;
  /** the merged verdict, in the frozen contract shape */
  verdict: Record<string, unknown>;
  structuralFindings: AuditIssue[];
  structuralForcedFail: boolean;
  modelFailed: boolean;
  provider?: string | null;
  model?: string | null;
  agentRunId?: string | null;
}

export async function recordAudit(ex: Executor, params: RecordAuditInput): Promise<SpecAuditRow> {
  const id = uuidv7();
  const [row] = await ex
    .insert(specAudits)
    .values({
      id,
      orgId: params.orgId,
      projectId: params.projectId,
      specVersionId: params.specVersionId,
      cycleKey: params.cycleKey,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      status: params.status,
      score: Math.max(0, Math.min(100, Math.round(params.score))),
      verdict: params.verdict as object,
      structuralFindings: params.structuralFindings as unknown as object,
      structuralForcedFail: params.structuralForcedFail,
      modelFailed: params.modelFailed,
      provider: params.provider ?? null,
      model: params.model ?? null,
      agentRunId: params.agentRunId ?? null,
    })
    .returning();
  return row!;
}

/** How many audits this cycle already has — the loop budget (§21) is data, not memory. */
export async function countCycleAttempts(ex: Executor, projectId: string, cycleKey: string): Promise<number> {
  const [row] = await ex
    .select({ value: max(specAudits.attempt) })
    .from(specAudits)
    .where(and(eq(specAudits.projectId, projectId), eq(specAudits.cycleKey, cycleKey)));
  return row?.value ?? 0;
}

export async function listAuditsForCycle(ex: Executor, projectId: string, cycleKey: string): Promise<SpecAuditRow[]> {
  return ex
    .select()
    .from(specAudits)
    .where(and(eq(specAudits.projectId, projectId), eq(specAudits.cycleKey, cycleKey)))
    .orderBy(asc(specAudits.attempt));
}

export async function listAuditsForProject(ex: Executor, projectId: string, opts: { limit?: number } = {}): Promise<SpecAuditRow[]> {
  return ex
    .select()
    .from(specAudits)
    .where(eq(specAudits.projectId, projectId))
    .orderBy(desc(specAudits.createdAt))
    .limit(opts.limit ?? 50);
}

export async function getLatestAudit(ex: Executor, projectId: string): Promise<SpecAuditRow | null> {
  const rows = await listAuditsForProject(ex, projectId, { limit: 1 });
  return rows[0] ?? null;
}

/** The issues the *next* revision must fix, from the last FAIL of a cycle (§21). */
export function issuesFromVerdict(verdict: unknown): AuditIssue[] {
  const v = (verdict ?? {}) as Partial<{ criticalIssues: AuditIssue[]; missingRequirements: AuditIssue[]; contradictions: AuditIssue[]; ambiguities: AuditIssue[]; warnings: AuditIssue[] }>;
  return [
    ...(v.criticalIssues ?? []),
    ...(v.missingRequirements ?? []),
    ...(v.contradictions ?? []),
    ...(v.ambiguities ?? []),
    ...(v.warnings ?? []),
  ];
}

export function checksFromVerdict(verdict: unknown): AuditChecks | null {
  const v = (verdict ?? {}) as { checks?: AuditChecks | null };
  return v.checks ?? null;
}

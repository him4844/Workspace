/**
 * Domain primitives (SPEC §3, §10A, §31, §33, §40).
 * Pure TypeScript — no IO, no framework imports (docs/02 layering rule).
 */

/** SPEC §3 — project lifecycle states (23, verbatim). */
export const PROJECT_STATES = [
  'NEW', 'INTAKE', 'REQUIREMENTS_IN_PROGRESS', 'REQUIREMENTS_COMPLETE',
  'SPEC_GENERATING', 'CLIENT_REVIEW', 'CLIENT_CHANGES_REQUESTED', 'CLIENT_APPROVED',
  'SPEC_AUDIT', 'SPEC_REVISION_REQUIRED', 'READY_FOR_BUILD', 'BUILDING',
  'CODE_AUDIT', 'CODE_REVISION_REQUIRED', 'TEAM_REVIEW', 'TEAM_REVISION',
  'PRICE_PENDING', 'DEADLINE_PENDING', 'IN_DEVELOPMENT', 'READY_FOR_DELIVERY',
  'COMPLETED', 'BLOCKED', 'FAILED',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const TERMINAL_STATES: ProjectState[] = ['COMPLETED', 'FAILED'];
export const QUARANTINE_STATES: ProjectState[] = ['BLOCKED', 'FAILED'];
/** States where the pipeline waits for a human action rather than a job. */
export const HUMAN_GATED_STATES: ProjectState[] = [
  'TEAM_REVIEW', 'TEAM_REVISION', 'PRICE_PENDING', 'DEADLINE_PENDING',
  'IN_DEVELOPMENT', 'READY_FOR_DELIVERY',
];

/** SPEC §10A — the ONLY requirement status vocabulary in the system. */
export const REQUIREMENT_STATUSES = [
  'EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED',
  'CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses that make a mandatory field complete (§10A rules). */
export const COMPLETE_STATUSES: RequirementStatus[] = [
  'CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE',
];
/** Statuses that may only be set together with an explicit client message reference. */
export const CLIENT_TRUTH_STATUSES: RequirementStatus[] = ['CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT'];

export function isMandatoryFieldComplete(status: RequirementStatus): boolean {
  return COMPLETE_STATUSES.includes(status);
}

export function requiresClientMessage(status: RequirementStatus): boolean {
  return CLIENT_TRUTH_STATUSES.includes(status);
}

export type ActorType = 'SYSTEM' | 'AI_AGENT' | 'HUMAN' | 'CLIENT';
export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'NEEDS_REVIEW' | 'CANCELLED';
export type ChannelType = 'INSTAGRAM' | 'SIMULATOR' | 'TELEGRAM' | 'WEBCHAT';
export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageStatus =
  | 'RECEIVED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SEND_BLOCKED';

export type JobType =
  | 'ECHO_REPLY'            // Phase 1 placeholder for REQUIREMENTS_TURN
  | 'SEND_OUTBOUND'
  | 'REQUIREMENTS_TURN'     // Phase 2
  | 'SPEC_GENERATE' | 'SPEC_REVISE' | 'SPEC_AUDIT' | 'CLIENT_INTENT_PARSE' | 'CLIENT_APPROVAL_TIMEOUT'
  | 'BUILD_RUN' | 'CODE_CHECK'
  | 'INACTIVITY_CHECK' | 'TOKEN_REFRESH' | 'WATCHDOG';

export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'PARKED' | 'DEAD_LETTER';

export interface JobPolicy {
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}

/** docs/02 §4 policy table — data, not hard-coded per call site. */
export const JOB_POLICIES: Record<JobType, JobPolicy> = {
  ECHO_REPLY: { concurrency: 4, timeoutMs: 60_000, maxAttempts: 3, backoffMs: 5_000 },
  SEND_OUTBOUND: { concurrency: 4, timeoutMs: 20_000, maxAttempts: 5, backoffMs: 2_000 },
  REQUIREMENTS_TURN: { concurrency: 4, timeoutMs: 60_000, maxAttempts: 3, backoffMs: 5_000 },
  SPEC_GENERATE: { concurrency: 2, timeoutMs: 300_000, maxAttempts: 3, backoffMs: 30_000 },
  SPEC_REVISE: { concurrency: 2, timeoutMs: 300_000, maxAttempts: 3, backoffMs: 30_000 },
  SPEC_AUDIT: { concurrency: 2, timeoutMs: 300_000, maxAttempts: 3, backoffMs: 30_000 },
  CLIENT_INTENT_PARSE: { concurrency: 4, timeoutMs: 30_000, maxAttempts: 2, backoffMs: 5_000 },
  CLIENT_APPROVAL_TIMEOUT: { concurrency: 1, timeoutMs: 10_000, maxAttempts: 1, backoffMs: 0 },
  BUILD_RUN: { concurrency: 1, timeoutMs: 1_800_000, maxAttempts: 2, backoffMs: 60_000 },
  CODE_CHECK: { concurrency: 1, timeoutMs: 1_200_000, maxAttempts: 2, backoffMs: 60_000 },
  INACTIVITY_CHECK: { concurrency: 1, timeoutMs: 30_000, maxAttempts: 1, backoffMs: 0 },
  TOKEN_REFRESH: { concurrency: 1, timeoutMs: 30_000, maxAttempts: 3, backoffMs: 60_000 },
  WATCHDOG: { concurrency: 1, timeoutMs: 30_000, maxAttempts: 1, backoffMs: 0 },
};

/** Job types allowed per project state (docs/05 §6) — Phase 1 subset. */
export const JOBS_ALLOWED_IN_STATE: Partial<Record<ProjectState, readonly JobType[]>> = {
  NEW: ['ECHO_REPLY'],
  INTAKE: ['ECHO_REPLY', 'REQUIREMENTS_TURN', 'SEND_OUTBOUND', 'INACTIVITY_CHECK'],
  REQUIREMENTS_IN_PROGRESS: ['REQUIREMENTS_TURN', 'ECHO_REPLY', 'SEND_OUTBOUND', 'INACTIVITY_CHECK'],
  SPEC_GENERATING: ['SPEC_GENERATE', 'SPEC_REVISE'],
  CLIENT_REVIEW: ['CLIENT_INTENT_PARSE', 'CLIENT_APPROVAL_TIMEOUT', 'SEND_OUTBOUND'],
  SPEC_AUDIT: ['SPEC_AUDIT'],
  READY_FOR_BUILD: ['BUILD_RUN'],
  BUILDING: ['BUILD_RUN'],
  CODE_AUDIT: ['CODE_CHECK'],
};

export function isJobAllowedInState(type: JobType, state: ProjectState | null): boolean {
  if (!state) return true; // project-less jobs (maintenance) are always allowed
  const allowed = JOBS_ALLOWED_IN_STATE[state];
  if (!allowed) return false; // BLOCKED/FAILED/COMPLETED/human-gated states accept no pipeline jobs
  return allowed.includes(type);
}

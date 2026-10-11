/**
 * Project state machine (SPEC §3, §4; docs/05_state_machine.md).
 * The FULL transition table lives here as data. Guards are pure functions.
 * Agents can never execute a transition: only the orchestrator/use-cases call `applyTransition`.
 */

import { ERR, toWppError, WppError } from '../errors.js';
import type { ActorType, ProjectState } from '../types.js';
import { HUMAN_GATED_STATES, TERMINAL_STATES } from '../types.js';

export type TransitionId =
  | 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10'
  | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17' | 'T18' | 'T19' | 'T20'
  | 'T21' | 'T22' | 'T23' | 'T24' | 'T25' | 'T26' | 'T27' | 'T28' | 'T29' | 'T30'
  | 'T31' | 'T32' | 'T33' | 'T34';

export type TriggerType = 'WEBHOOK' | 'AGENT_SUCCESS' | 'AGENT_FAILURE' | 'HUMAN_ACTION' | 'TIMER' | 'JOB';

export interface GuardContext {
  /** entity presence facts the pure guards may rely on (filled by the db layer) */
  hasInboundMessage?: boolean;
  hasLockedSpecVersion?: boolean;
  hasClientApproval?: boolean;
  hasBuild?: boolean;
  buildSucceeded?: boolean;
  hasCodeCheck?: boolean;
  hasRequirementsSummary?: boolean;
  completeRequirements?: boolean;
  loopAttempts?: number;
  maxLoopAttempts?: number;
  criticalSecurityIssue?: boolean;
  reason?: string;
  blockedFrom?: ProjectState | null;
  humanActorType?: ActorType;
}

export interface GuardResult {
  ok: boolean;
  code: string;
  message?: string;
}

const ok: GuardResult = { ok: true, code: 'OK' };
const fail = (code: string, message: string): GuardResult => ({ ok: false, code, message });

export interface TransitionDef {
  id: TransitionId;
  from: readonly ProjectState[];
  to: ProjectState;
  trigger: TriggerType;
  actor: ActorType;
  /** human-readable purpose, mirrors docs/05 */
  purpose: string;
  requiresReason?: boolean;
  /** phase in which the transition becomes executable (later phases are declared but guarded off) */
  implementedIn: number;
  guard: (ctx: GuardContext) => GuardResult;
}

const anyState = [
  'NEW', 'INTAKE', 'REQUIREMENTS_IN_PROGRESS', 'REQUIREMENTS_COMPLETE', 'SPEC_GENERATING',
  'CLIENT_REVIEW', 'CLIENT_CHANGES_REQUESTED', 'CLIENT_APPROVED', 'SPEC_AUDIT',
  'SPEC_REVISION_REQUIRED', 'READY_FOR_BUILD', 'BUILDING', 'CODE_AUDIT',
  'CODE_REVISION_REQUIRED', 'TEAM_REVIEW', 'TEAM_REVISION', 'PRICE_PENDING',
  'DEADLINE_PENDING', 'IN_DEVELOPMENT', 'READY_FOR_DELIVERY',
] as const satisfies readonly ProjectState[];

const reasonGuard = (ctx: GuardContext): GuardResult =>
  ctx.reason && ctx.reason.trim().length >= 3 ? ok : fail('REASON_REQUIRED', 'a reason (>= 3 chars) is required');

export const TRANSITIONS: Record<TransitionId, TransitionDef> = {
  T01: {
    id: 'T01', from: ['NEW'], to: 'NEW', trigger: 'WEBHOOK', actor: 'SYSTEM',
    purpose: 'Client message creates client + project', implementedIn: 1,
    guard: () => ok,
  },
  T02: {
    id: 'T02', from: ['NEW'], to: 'INTAKE', trigger: 'WEBHOOK', actor: 'SYSTEM',
    purpose: 'First inbound message processed → intake', implementedIn: 1,
    guard: (c) => c.hasInboundMessage ? ok : fail('NO_INBOUND_MESSAGE', 'an inbound message is required'),
  },
  T03: {
    id: 'T03', from: ['INTAKE'], to: 'REQUIREMENTS_IN_PROGRESS', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Requirements Agent sent its first question', implementedIn: 2,
    guard: (c) => c.hasInboundMessage ? ok : fail('NO_INBOUND_MESSAGE', 'inbound message required before questioning'),
  },
  T04: {
    id: 'T04', from: ['REQUIREMENTS_IN_PROGRESS'], to: 'REQUIREMENTS_IN_PROGRESS', trigger: 'WEBHOOK', actor: 'CLIENT',
    purpose: 'Answer turn updates requirement fields', implementedIn: 2,
    guard: () => ok,
  },
  T05: {
    id: 'T05', from: ['REQUIREMENTS_IN_PROGRESS'], to: 'REQUIREMENTS_COMPLETE', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Completeness engine declares requirements complete (§10)',
    implementedIn: 2,
    guard: (c) =>
      c.completeRequirements && c.hasRequirementsSummary
        ? ok
        : fail('REQUIREMENTS_INCOMPLETE', 'all mandatory fields confirmed and an internal summary artifact are required'),
  },
  T06: {
    id: 'T06', from: ['REQUIREMENTS_COMPLETE'], to: 'SPEC_GENERATING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Start specification generation', implementedIn: 3,
    guard: (c) => c.hasRequirementsSummary ? ok : fail('NO_SUMMARY', 'internal requirements summary missing'),
  },
  T07: {
    id: 'T07', from: ['SPEC_GENERATING'], to: 'CLIENT_REVIEW', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Spec vN + client summary generated and sent', implementedIn: 3,
    guard: () => ok,
  },
  T08: {
    id: 'T08', from: ['CLIENT_REVIEW'], to: 'CLIENT_CHANGES_REQUESTED', trigger: 'WEBHOOK', actor: 'CLIENT',
    purpose: 'Client requests changes to the summary', implementedIn: 3,
    guard: () => ok,
  },
  T09: {
    id: 'T09', from: ['CLIENT_CHANGES_REQUESTED'], to: 'SPEC_GENERATING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'New spec version after client changes', implementedIn: 3,
    guard: () => ok,
  },
  T10: {
    id: 'T10', from: ['CLIENT_REVIEW'], to: 'CLIENT_APPROVED', trigger: 'WEBHOOK', actor: 'CLIENT',
    purpose: 'Client approves the Client Summary (single formal approval)',
    implementedIn: 3,
    guard: (c) => c.hasClientApproval ? ok : fail('NO_APPROVAL_RECORD', 'approval requires a client message reference'),
  },
  T11: {
    id: 'T11', from: ['CLIENT_APPROVED'], to: 'SPEC_AUDIT', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Run Spec Auditor on the locked spec', implementedIn: 4,
    guard: (c) => c.hasLockedSpecVersion ? ok : fail('SPEC_NOT_LOCKED', 'spec must be locked before audit'),
  },
  T12: {
    id: 'T12', from: ['SPEC_AUDIT'], to: 'READY_FOR_BUILD', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Auditor PASS → ready for build', implementedIn: 4,
    guard: () => ok,
  },
  T13: {
    id: 'T13', from: ['SPEC_AUDIT'], to: 'SPEC_REVISION_REQUIRED', trigger: 'AGENT_FAILURE', actor: 'SYSTEM',
    purpose: 'Auditor FAIL, attempts < max', implementedIn: 4,
    guard: (c) => ((c.loopAttempts ?? 0) < (c.maxLoopAttempts ?? 3)) ? ok : fail('LOOP_LIMIT', 'revision limit reached'),
  },
  T14: {
    id: 'T14', from: ['SPEC_REVISION_REQUIRED'], to: 'SPEC_GENERATING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Spec Agent revises with findings', implementedIn: 4,
    guard: () => ok,
  },
  T15: {
    id: 'T15', from: ['SPEC_AUDIT'], to: 'BLOCKED', trigger: 'AGENT_FAILURE', actor: 'SYSTEM',
    purpose: 'Auditor FAIL after max attempts → human task (§42)', implementedIn: 4,
    guard: (c) => ((c.loopAttempts ?? 0) >= (c.maxLoopAttempts ?? 3)) ? ok : fail('LOOP_NOT_EXHAUSTED', 'not exhausted yet'),
  },
  T16: {
    id: 'T16', from: ['READY_FOR_BUILD'], to: 'BUILDING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Start a build from the locked spec', implementedIn: 5,
    guard: (c) => c.hasLockedSpecVersion ? ok : fail('SPEC_NOT_LOCKED', 'build requires a locked spec version'),
  },
  T17: {
    id: 'T17', from: ['BUILDING'], to: 'CODE_AUDIT', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Build succeeded → run code checker', implementedIn: 5,
    guard: (c) => c.buildSucceeded ? ok : fail('BUILD_FAILED', 'build must have succeeded'),
  },
  T18: {
    id: 'T18', from: ['BUILDING'], to: 'FAILED', trigger: 'AGENT_FAILURE', actor: 'SYSTEM',
    purpose: 'Unrecoverable build failure', implementedIn: 5,
    guard: () => ok,
  },
  T19: {
    id: 'T19', from: ['CODE_AUDIT'], to: 'TEAM_REVIEW', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Checker PASS → human review', implementedIn: 6,
    guard: (c) => c.buildSucceeded && !c.criticalSecurityIssue ? ok : fail('CHECK_FAILED', 'build/check prerequisites not met'),
  },
  T20: {
    id: 'T20', from: ['CODE_AUDIT'], to: 'CODE_REVISION_REQUIRED', trigger: 'AGENT_FAILURE', actor: 'SYSTEM',
    purpose: 'Checker FAIL, attempts < max', implementedIn: 6,
    guard: (c) => ((c.loopAttempts ?? 0) < (c.maxLoopAttempts ?? 3)) ? ok : fail('LOOP_LIMIT', 'revision limit reached'),
  },
  T21: {
    id: 'T21', from: ['CODE_AUDIT'], to: 'BLOCKED', trigger: 'AGENT_FAILURE', actor: 'SYSTEM',
    purpose: 'Failures exhausted or critical security issue → stop automation',
    implementedIn: 6,
    guard: (c) =>
      c.criticalSecurityIssue || (c.loopAttempts ?? 0) >= (c.maxLoopAttempts ?? 3)
        ? ok : fail('NOT_BLOCKING', 'no critical issue and limit not exhausted'),
  },
  T22: {
    id: 'T22', from: ['CODE_REVISION_REQUIRED'], to: 'BUILDING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Fix + rebuild (new build version)', implementedIn: 6, guard: () => ok,
  },
  T23: {
    id: 'T23', from: ['TEAM_REVIEW'], to: 'TEAM_REVISION', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Team requests an AI fix / edit / rebuild', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'team action required'),
  },
  T24: {
    id: 'T24', from: ['TEAM_REVISION'], to: 'BUILDING', trigger: 'JOB', actor: 'SYSTEM',
    purpose: 'Rebuild with team instructions', implementedIn: 7, guard: () => ok,
  },
  T25: {
    id: 'T25', from: ['TEAM_REVIEW'], to: 'PRICE_PENDING', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Team accepts the build → pricing decision', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'team action required'),
  },
  T26: {
    id: 'T26', from: ['PRICE_PENDING'], to: 'DEADLINE_PENDING', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Human sets final price (§30)', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'price must be set by a human'),
  },
  T27: {
    id: 'T27', from: ['DEADLINE_PENDING'], to: 'IN_DEVELOPMENT', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Human sets deadline and sends the message', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'deadline must be set by a human'),
  },
  T28: {
    id: 'T28', from: ['IN_DEVELOPMENT'], to: 'READY_FOR_DELIVERY', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Delivery preparation', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'team action required'),
  },
  T29: {
    id: 'T29', from: ['READY_FOR_DELIVERY'], to: 'COMPLETED', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Project completed and delivered', implementedIn: 7,
    guard: (c) => c.humanActorType === 'HUMAN' ? ok : fail('HUMAN_ONLY', 'team action required'),
  },
  T30: {
    id: 'T30', from: anyState, to: 'BLOCKED', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Stop automation and escalate to humans', implementedIn: 1,
    requiresReason: true,
    guard: reasonGuard,
  },
  T31: {
    id: 'T31', from: ['BLOCKED'], to: 'REQUIREMENTS_IN_PROGRESS', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Resolve a blocked project back into the pipeline', implementedIn: 1,
    requiresReason: true,
    guard: (c) => (c.blockedFrom ? reasonGuard(c) : fail('NO_RESUME_STATE', 'blocked_from must be recorded')),
  },
  T32: {
    id: 'T32', from: ['FAILED'], to: 'BLOCKED', trigger: 'TIMER', actor: 'SYSTEM',
    purpose: 'Quarantine a failed project for human triage', implementedIn: 5,
    guard: () => ok,
  },
  T33: {
    id: 'T33', from: ['COMPLETED', 'IN_DEVELOPMENT', 'READY_FOR_DELIVERY'], to: 'TEAM_REVISION', trigger: 'HUMAN_ACTION', actor: 'HUMAN',
    purpose: 'Approved change request reopens work (§35)', implementedIn: 8,
    guard: () => fail('CHANGE_REQUEST_REQUIRED', 'a locked spec can only be changed through a Change Request (§35)'),
  },
  /**
   * §21 requires the revised specification to go STRAIGHT back to the Spec Auditor ("Specification
   * Agent → new specification version → Spec Auditor"); the Phase-0 table had no edge for that
   * return, so a revision could only have re-entered through the client. Added in Phase 4 and
   * documented in docs/05 (D-036). Guarded by the locked approved base version: a project can only
   * re-audit when there is an approved specification the revision is closing gaps in.
   */
  T34: {
    id: 'T34', from: ['SPEC_GENERATING'], to: 'SPEC_AUDIT', trigger: 'AGENT_SUCCESS', actor: 'SYSTEM',
    purpose: 'Revised specification re-enters the Spec Auditor (§21)', implementedIn: 4,
    guard: (c) => c.hasLockedSpecVersion ? ok : fail('NO_APPROVED_BASE', 'the audit loop needs the client-approved (locked) specification it revises'),
  },
};

export interface TransitionRequest {
  transitionId: TransitionId;
  from: ProjectState;
  context: GuardContext;
}

export interface TransitionDecision {
  allowed: boolean;
  to: ProjectState;
  code: string;
  message?: string;
}

/**
 * Validate a transition. Pure: no IO, so every guard is unit-testable (docs/14 §2).
 */
export function decideTransition(req: TransitionRequest): TransitionDecision {
  const def = TRANSITIONS[req.transitionId];
  if (!def) return { allowed: false, to: req.from, code: 'UNKNOWN_TRANSITION', message: 'unknown transition id' };
  if (!def.from.includes(req.from)) {
    return { allowed: false, to: req.from, code: 'WRONG_FROM_STATE', message: `${def.id} cannot start from ${req.from}` };
  }
  if (TERMINAL_STATES.includes(req.from) && def.id !== 'T33' && def.id !== 'T32') {
    return { allowed: false, to: req.from, code: 'TERMINAL_STATE', message: `${req.from} is terminal` };
  }
  if (HUMAN_GATED_STATES.includes(req.from) && def.actor !== 'HUMAN' && def.id !== 'T30') {
    return { allowed: false, to: req.from, code: 'HUMAN_GATE', message: `${req.from} waits for a human action` };
  }
  const g = def.guard(req.context);
  return { allowed: g.ok, to: def.to, code: g.code, message: g.message };
}

export interface TransitionRecord {
  transitionId: TransitionId;
  from: ProjectState;
  to: ProjectState;
  actorType: ActorType;
  reason?: string;
}

/**
 * Compute the record to persist when a transition is applied (the DB layer writes it
 * inside the same transaction as its effects — docs/01 §5).
 */
export function buildTransitionRecord(
  transitionId: TransitionId,
  from: ProjectState,
  context: GuardContext,
  opts: { actorType?: ActorType; reason?: string } = {},
): TransitionRecord {
  const decision = decideTransition({ transitionId, from, context });
  if (!decision.allowed) {
    throw ERR.TRANSITION_NOT_ALLOWED(from, TRANSITIONS[transitionId].to, `${decision.code}: ${decision.message ?? ''}`);
  }
  const def = TRANSITIONS[transitionId];
  const effectiveReason = opts.reason ?? context.reason;
  if (def.requiresReason && !(effectiveReason && effectiveReason.trim().length >= 3)) {
    throw ERR.REASON_REQUIRED(transitionId);
  }
  return {
    transitionId,
    from,
    to: decision.to,
    actorType: opts.actorType ?? def.actor,
    reason: effectiveReason,
  };
}

export function transitionsFrom(state: ProjectState): TransitionDef[] {
  return Object.values(TRANSITIONS).filter((t) => t.from.includes(state));
}

export function isKnownState(s: string): s is ProjectState {
  return (anyState as readonly string[]).includes(s) || s === 'BLOCKED' || s === 'FAILED' || s === 'COMPLETED';
}

export { WppError, toWppError };

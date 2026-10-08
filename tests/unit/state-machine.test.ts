import { describe, expect, it } from 'vitest';
import {
  decideTransition, TRANSITIONS, transitionsFrom, buildTransitionRecord, PROJECT_STATES, TERMINAL_STATES,
} from '@wpp/core';

/**
 * The state machine is pure, so every guard is tested here (docs/14 §2).
 * The disallowed-pairs sweep is generated from the table, not hand-written.
 */
describe('state machine — allowed transitions', () => {
  it('NEW → INTAKE requires an inbound message (T02)', () => {
    expect(decideTransition({ transitionId: 'T02', from: 'NEW', context: {} }).allowed).toBe(false);
    const d = decideTransition({ transitionId: 'T02', from: 'NEW', context: { hasInboundMessage: true } });
    expect(d.allowed).toBe(true);
    expect(d.to).toBe('INTAKE');
  });

  it('REQUIREMENTS_COMPLETE → SPEC_GENERATING requires the internal summary (T06)', () => {
    expect(decideTransition({ transitionId: 'T06', from: 'REQUIREMENTS_COMPLETE', context: {} }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T06', from: 'REQUIREMENTS_COMPLETE', context: { hasRequirementsSummary: true } }).allowed).toBe(true);
  });

  it('completeness gate T05 needs complete fields AND a summary', () => {
    const base = { transitionId: 'T05' as const, from: 'REQUIREMENTS_IN_PROGRESS' as const };
    expect(decideTransition({ ...base, context: { completeRequirements: true } }).allowed).toBe(false);
    expect(decideTransition({ ...base, context: { hasRequirementsSummary: true } }).allowed).toBe(false);
    expect(decideTransition({ ...base, context: { completeRequirements: true, hasRequirementsSummary: true } }).allowed).toBe(true);
  });

  it('spec audit loop: FAIL under the limit revises, at the limit blocks (T13/T15)', () => {
    expect(decideTransition({ transitionId: 'T13', from: 'SPEC_AUDIT', context: { loopAttempts: 1, maxLoopAttempts: 3 } }).allowed).toBe(true);
    expect(decideTransition({ transitionId: 'T13', from: 'SPEC_AUDIT', context: { loopAttempts: 3, maxLoopAttempts: 3 } }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T15', from: 'SPEC_AUDIT', context: { loopAttempts: 2, maxLoopAttempts: 3 } }).allowed).toBe(false);
    const blocked = decideTransition({ transitionId: 'T15', from: 'SPEC_AUDIT', context: { loopAttempts: 3, maxLoopAttempts: 3 } });
    expect(blocked.allowed).toBe(true);
    expect(blocked.to).toBe('BLOCKED');
  });

  it('code check: critical security issue blocks immediately (T21)', () => {
    const d = decideTransition({ transitionId: 'T21', from: 'CODE_AUDIT', context: { criticalSecurityIssue: true, loopAttempts: 1 } });
    expect(d.allowed).toBe(true);
    expect(d.to).toBe('BLOCKED');
  });

  it('build requires a locked spec (T16) and success before the check (T17)', () => {
    expect(decideTransition({ transitionId: 'T16', from: 'READY_FOR_BUILD', context: {} }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T16', from: 'READY_FOR_BUILD', context: { hasLockedSpecVersion: true } }).allowed).toBe(true);
    expect(decideTransition({ transitionId: 'T17', from: 'BUILDING', context: { buildSucceeded: false } }).allowed).toBe(false);
  });

  it('approval needs a recorded client message reference (T10)', () => {
    expect(decideTransition({ transitionId: 'T10', from: 'CLIENT_REVIEW', context: {} }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T10', from: 'CLIENT_REVIEW', context: { hasClientApproval: true } }).allowed).toBe(true);
  });

  it('price and deadline transitions are human-only (T26, T27)', () => {
    expect(decideTransition({ transitionId: 'T26', from: 'PRICE_PENDING', context: {} }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T26', from: 'PRICE_PENDING', context: { humanActorType: 'AI_AGENT' } }).allowed).toBe(false);
    expect(decideTransition({ transitionId: 'T26', from: 'PRICE_PENDING', context: { humanActorType: 'HUMAN' } }).allowed).toBe(true);
  });

  it('BLOCKED → resume requires the recorded resume state and a reason (T31)', () => {
    expect(decideTransition({ transitionId: 'T31', from: 'BLOCKED', context: { reason: 'fixed by hand' } }).allowed).toBe(false);
    const d = decideTransition({ transitionId: 'T31', from: 'BLOCKED', context: { blockedFrom: 'REQUIREMENTS_IN_PROGRESS', reason: 'fixed by hand' } });
    expect(d.allowed).toBe(true);
    expect(d.to).toBe('REQUIREMENTS_IN_PROGRESS');
  });

  it('locked specs can only change through a Change Request (T33)', () => {
    const d = decideTransition({ transitionId: 'T33', from: 'COMPLETED', context: {} });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('CHANGE_REQUEST_REQUIRED');
  });
});

describe('state machine — disallowed pairs (generated sweep)', () => {
  it('no transition is allowed from a state it does not declare', () => {
    for (const def of Object.values(TRANSITIONS)) {
      for (const state of PROJECT_STATES) {
        if (def.from.includes(state)) continue;
        const d = decideTransition({ transitionId: def.id, from: state, context: { hasInboundMessage: true, hasRequirementsSummary: true, completeRequirements: true, hasLockedSpecVersion: true, hasClientApproval: true, buildSucceeded: true, humanActorType: 'HUMAN', blockedFrom: 'INTAKE', reason: 'because', loopAttempts: 0, maxLoopAttempts: 3 } });
        expect(d.allowed, `${def.id} from ${state} must be rejected`).toBe(false);
        expect(d.code).toBe('WRONG_FROM_STATE');
      }
    }
  });

  it('terminal states reject everything except quarantine paths', () => {
    const d = decideTransition({ transitionId: 'T16', from: 'COMPLETED', context: { hasLockedSpecVersion: true } });
    expect(d.allowed).toBe(false);
  });

  it('human-gated states reject system triggers', () => {
    // T17 (system) cannot fire from TEAM_REVIEW even with a successful build flag
    const d = decideTransition({ transitionId: 'T17', from: 'TEAM_REVIEW', context: { buildSucceeded: true } });
    expect(d.allowed).toBe(false);
  });
});

describe('state machine — transition records', () => {
  it('buildTransitionRecord raises a structured error when a guard fails', () => {
    expect(() => buildTransitionRecord('T16', 'READY_FOR_BUILD', {})).toThrowError(/Cannot move/);
  });

  it('BLOCKED requires a reason of at least 3 characters', () => {
    expect(() => buildTransitionRecord('T30', 'INTAKE', { reason: 'no' })).toThrowError();
    const rec = buildTransitionRecord('T30', 'INTAKE', { reason: 'client unreachable' }, { actorType: 'HUMAN' });
    expect(rec.to).toBe('BLOCKED');
    expect(rec.actorType).toBe('HUMAN');
  });

  it('every state has at least one declared transition except the truly terminal ones', () => {
    for (const state of PROJECT_STATES) {
      if (TERMINAL_STATES.includes(state)) continue;
      expect(transitionsFrom(state).length, `${state} should have transitions`).toBeGreaterThan(0);
    }
  });

  it('transition ids are unique and complete (T01…T34)', () => {
    const ids = Object.keys(TRANSITIONS).sort();
    // T34 was added in Phase 4: SPEC_GENERATING → SPEC_AUDIT, the return edge §21 needs so an
    // auditor-requested revision is re-audited instead of going back to the client (DECISIONS D-036).
    expect(ids.length).toBe(34);
    expect(new Set(ids).size).toBe(34);
  });
});

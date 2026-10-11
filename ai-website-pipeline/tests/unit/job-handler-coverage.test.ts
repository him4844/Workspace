/**
 * P2-3: every declared job type must have a handler.
 *
 * `WATCHDOG` was declared in `JobType` and given a `JOB_POLICIES` row, but had no entry in
 * `HANDLERS`. That is not a harmless omission: the orchestrator answers `NO_HANDLER`, `failJob`
 * escalates to DEAD_LETTER, and `failAndEscalateDeadLetter` files a CRITICAL task and moves the
 * project to BLOCKED via T30. One missing map entry turned a not-yet-built timer into a blocked
 * project. `HANDLERS` is now a *total* `Record<JobType, JobHandler>`, so the next omission is a
 * compile error; these tests keep the runtime behaviour honest as well.
 */
import { describe, expect, it } from 'vitest';
import { JOB_POLICIES, WppError, type JobType } from '@wpp/core';
import { HANDLERS, type JobHandler } from '../../apps/worker/src/handlers/index.js';

/** The job types that are declared but deliberately not built yet, and the phase that owns them. */
const DEFERRED: ReadonlyArray<{ type: JobType; phase: string }> = [
  { type: 'BUILD_RUN', phase: 'Phase 5' },
  { type: 'CODE_CHECK', phase: 'Phase 6' },
  { type: 'TOKEN_REFRESH', phase: 'Phase 5' },
  // docs/16 A3 pairs the webhook watchdog with the Team Panel banner, so it lands with Phase 7.
  { type: 'WATCHDOG', phase: 'Phase 7' },
];

describe('job handler coverage', () => {
  it('has a handler for every declared job type', () => {
    const declared = Object.keys(JOB_POLICIES) as JobType[];
    expect(declared.length).toBe(13);
    expect(declared).toContain('WATCHDOG');
    const missing = declared.filter((type) => HANDLERS[type] === undefined);
    expect(missing, 'job types with a policy but no handler').toEqual([]);
    expect(Object.keys(HANDLERS).length).toBe(declared.length);
  });

  it('keeps the map total at compile time', () => {
    // Reverting HANDLERS to Partial<Record<JobType, JobHandler>> makes this annotation fail tsc,
    // which is the point: the guarantee must not depend on anyone remembering to look.
    const total: Record<JobType, JobHandler> = HANDLERS;
    expect(Object.keys(total).sort()).toEqual(Object.keys(JOB_POLICIES).sort());
  });

  it('gives every job type a queue policy', () => {
    for (const [type, policy] of Object.entries(JOB_POLICIES)) {
      expect(policy.timeoutMs, type).toBeGreaterThan(0);
      expect(policy.maxAttempts, type).toBeGreaterThan(0);
      expect(policy.concurrency, type).toBeGreaterThan(0);
      expect(policy.backoffMs, type).toBeGreaterThanOrEqual(0);
    }
  });

  it('fails a deferred job type loudly, naming the phase that owns it', async () => {
    for (const { type, phase } of DEFERRED) {
      const handler = HANDLERS[type];
      expect(handler, `${type} has no handler`).toBeTypeOf('function');

      let failure: unknown;
      try {
        // notImplemented throws before touching ctx, so a stub context is enough to prove the
        // contract: HUMAN_REQUIRED, non-retryable, and it says which phase to wait for.
        await handler({} as never, { id: 'job-1', type, orgId: 'org-1', payload: {} } as never);
      } catch (error) {
        failure = error;
      }

      expect(failure, `${type} resolved instead of failing`).toBeInstanceOf(WppError);
      const wpp = failure as WppError;
      expect(wpp.code, type).toBe('NOT_IMPLEMENTED_IN_PHASE');
      expect(wpp.errorClass, type).toBe('HUMAN_REQUIRED');
      expect(wpp.retryable, type).toBe(false);
      expect(wpp.message, type).toContain(phase);
      expect(wpp.message, type).toContain(type);
    }
  });

  it('implements the job types that this phase actually owns', () => {
    const built = Object.keys(HANDLERS).filter(
      (type) => !DEFERRED.some((deferred) => deferred.type === type),
    );
    expect(built.sort()).toEqual([
      'CLIENT_APPROVAL_TIMEOUT', 'CLIENT_INTENT_PARSE', 'ECHO_REPLY', 'INACTIVITY_CHECK',
      'REQUIREMENTS_TURN', 'SEND_OUTBOUND', 'SPEC_AUDIT', 'SPEC_GENERATE', 'SPEC_REVISE',
    ]);
  });
});

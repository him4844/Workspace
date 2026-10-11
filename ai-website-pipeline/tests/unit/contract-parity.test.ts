/**
 * P1-4: the frozen wire contract (`docs/contracts/common-envelope.json`) and the runtime types must
 * describe the same thing.
 *
 * They had drifted: `AgentErrorCode` (runtime.ts) carried nine codes including
 * `LLM_BUDGET_EXCEEDED`, while `AGENT_ERROR_CODES` (contracts.ts) and the JSON contract carried only
 * eight. The budget guard really does throw that code (`llm-budget.ts`, `runtime.ts`) and the
 * orchestrator really does route on it, so a budget-exceeded envelope could be produced but never
 * validated. `AgentErrorCode` is now *derived* from `AGENT_ERROR_CODES`, which makes the runtime/enum
 * half of the drift unrepresentable; these tests hold the JSON half in place.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_ERROR_CODES, AGENT_STATUSES, AgentEnvelopeSchema } from '@wpp/agents';
import type { AgentErrorCode, LlmErrorCode } from '@wpp/agents';

const CONTRACT_PATH = 'docs/contracts/common-envelope.json';

/** Walk a parsed JSON document without resorting to `any` (the codebase has none, and stays that way). */
function dig(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readContract(): unknown {
  return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as unknown;
}

function stringArray(value: unknown, where: string): string[] {
  expect(Array.isArray(value), `${CONTRACT_PATH}: ${where} must be an array`).toBe(true);
  const items = value as unknown[];
  expect(items.every((v) => typeof v === 'string'), `${CONTRACT_PATH}: ${where} must hold strings`).toBe(true);
  return items as string[];
}

/**
 * Compile-time exhaustiveness proof: `Record<LlmErrorCode, …>` forces a key for *every* transport
 * error code, so adding one to llm/types.ts without teaching the envelope about it breaks
 * `npm run typecheck` rather than the production budget path.
 */
const TRANSPORT_CODE_AS_ENVELOPE_CODE: Record<LlmErrorCode, AgentErrorCode> = {
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMITED: 'LLM_RATE_LIMITED',
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  LLM_BUDGET_EXCEEDED: 'LLM_BUDGET_EXCEEDED',
  CONTENT_POLICY: 'CONTENT_POLICY',
};

describe('P1-4 agent envelope contract parity (SPEC §49, docs/06 §8)', () => {
  it('lists exactly the error codes the JSON contract lists, in the same order', () => {
    const contract = readContract();
    const fromJson = stringArray(
      dig(contract, '$defs', 'failed', 'properties', 'errorCode', 'enum'),
      '$defs.failed.properties.errorCode.enum',
    );
    expect(fromJson).toEqual([...AGENT_ERROR_CODES]);
    expect(fromJson.length).toBe(9);
  });

  it('carries LLM_BUDGET_EXCEEDED, which the budget guard actually throws', () => {
    expect([...AGENT_ERROR_CODES]).toContain('LLM_BUDGET_EXCEEDED');
    const envelope = {
      status: 'FAILED' as const,
      runId: '018f2a10-0000-7000-8000-000000000000',
      errorCode: 'LLM_BUDGET_EXCEEDED' as const,
      message: 'daily spend cap reached',
      retryable: false,
    };
    // A `satisfies` check would be compile-time only; parsing proves the enum really accepts it.
    const parsed = AgentEnvelopeSchema.safeParse(envelope);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
  });

  it('rejects an error code that is not in the contract', () => {
    const parsed = AgentEnvelopeSchema.safeParse({
      status: 'FAILED',
      runId: '018f2a10-0000-7000-8000-000000000000',
      errorCode: 'NOT_A_REAL_ERROR_CODE',
      message: 'invented code',
      retryable: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('maps every transport error code onto a legal envelope code', () => {
    const codes = AGENT_ERROR_CODES as readonly string[];
    for (const [transport, envelopeCode] of Object.entries(TRANSPORT_CODE_AS_ENVELOPE_CODE)) {
      expect(codes, `envelope cannot carry ${transport}`).toContain(envelopeCode);
    }
  });

  it('agrees on the three envelope statuses', () => {
    const contract = readContract();
    const branches = dig(contract, 'oneOf');
    expect(Array.isArray(branches)).toBe(true);
    const refs = (branches as { $ref?: unknown }[]).map((b) => b.$ref);
    expect(refs).toEqual(['#/$defs/success', '#/$defs/failed', '#/$defs/needsReview']);

    const declared = (['success', 'failed', 'needsReview'] as const).map(
      (branch) => dig(contract, '$defs', branch, 'properties', 'status', 'const'),
    );
    expect(declared).toEqual([...AGENT_STATUSES]);
  });
});

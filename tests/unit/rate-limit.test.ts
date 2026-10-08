/**
 * Free-tier pacing (D-029 / §58): a 429 is a pause, not an error.
 *
 * Providers reserve `prompt + max_tokens` against a tokens-per-minute budget; when the window is
 * full they say exactly how long to wait. The runtime waits that long (bounded) instead of failing
 * the run, so a free tier produces slow results rather than dead-letter jobs (§21 still holds: the
 * wait is capped, and a provider asking for minutes fails the job for the queue's retry policy).
 */
import { describe, expect, it } from 'vitest';
import { LlmError, parseRetryAfterMs, runAgentTurn } from '@wpp/agents';
import type { LlmClient, LlmRequest } from '@wpp/agents';

function clientOf(handler: (request: LlmRequest) => Promise<{ text: string }>): LlmClient {
  return { provider: 'test', complete: async (request) => {
    const { text } = await handler(request);
    return { text, usage: { provider: 'test', model: request.model, promptTokens: 10, completionTokens: 5 } };
  } };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  task: 'Say hello',
  projectData: {},
  clientMessages: [],
  outputSchema: { type: 'object' },
  validate: (raw: unknown) => ({ ok: true as const, value: raw as { ok: boolean } }),
  model: 'test-model',
  ...overrides,
});

describe('parseRetryAfterMs (provider headers and prose)', () => {
  it('reads retry-after-ms, retry-after seconds and a date', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '1500' }), '')).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '16' }), '')).toBe(16_000);
    const at = new Date(Date.now() + 5_000).toUTCString();
    const fromDate = parseRetryAfterMs(new Headers({ 'retry-after': at }), '');
    expect(fromDate).toBeGreaterThan(3_000);
    expect(fromDate).toBeLessThan(6_500);
  });

  it("reads Groq's prose (\"Please try again in 16.19s\")", () => {
    expect(parseRetryAfterMs(new Headers(), 'Rate limit reached … Please try again in 16.192499999s.')).toBe(16_193);
  });

  it('returns undefined when there is no wait to respect', () => {
    expect(parseRetryAfterMs(new Headers(), '{"error":{"message":"rate limited"}}')).toBeUndefined();
  });
});

describe('runtime rate-limit waiting', () => {
  it('waits for the interval the provider asked for, then succeeds (§58 free tier)', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => {
          calls += 1;
          if (calls === 1) throw new LlmError('LLM_RATE_LIMITED', 'rate limited', true, undefined, 12_000);
          return { text: '{"ok":true}' };
        }),
        systemInstructions: 'test',
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('SUCCESS');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([12_000]);
  });

  it('fails immediately when the provider asks for longer than a job may wait', async () => {
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => { throw new LlmError('LLM_RATE_LIMITED', 'rate limited', true, undefined, 600_000); }),
        systemInstructions: 'test',
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('FAILED');
    if (envelope.status === 'FAILED') expect(envelope.errorCode).toBe('LLM_RATE_LIMITED');
    expect(sleeps).toEqual([]); // the queue's backoff owns waits that long
  });

  it('gives up after the bounded number of waits', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => { calls += 1; throw new LlmError('LLM_RATE_LIMITED', 'rate limited', true, undefined, 1_000); }),
        systemInstructions: 'test',
        maxRateLimitWaits: 2,
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('FAILED');
    expect(calls).toBe(3);      // one attempt + two bounded waits
    expect(sleeps.length).toBe(2);
  });

  it('waits out a provider 5xx spike (Gemini "high demand" 503) instead of dead-lettering the job', async () => {
    // Measured live on 2026-10-08: the identical specification-sized request returned 503 in one
    // minute and a valid completion in the next. The spike is a pause; the job's retry budget is not.
    let calls = 0;
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => {
          calls += 1;
          if (calls <= 2) throw new LlmError('LLM_PROVIDER_ERROR', 'openai-compatible returned 503', true, undefined, 5_000);
          return { text: '{"ok":true}' };
        }),
        systemInstructions: 'test',
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('SUCCESS');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('does not retry a client error (400) — that is our bug, not the provider being busy', async () => {
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => { throw new LlmError('LLM_PROVIDER_ERROR', 'returned 400: bad schema', false); }),
        systemInstructions: 'test',
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('FAILED');
    expect(sleeps).toEqual([]);
  });

  it('a 429 without any wait hint is not waited for', async () => {
    const sleeps: number[] = [];
    const envelope = await runAgentTurn<{ ok: boolean }>(
      {
        client: clientOf(async () => { throw new LlmError('LLM_RATE_LIMITED', 'rate limited', true, undefined); }),
        systemInstructions: 'test',
        sleepMs: async (ms) => { sleeps.push(ms); },
      },
      input(),
    );
    expect(envelope.status).toBe('FAILED');
    expect(sleeps).toEqual([]);
  });
});

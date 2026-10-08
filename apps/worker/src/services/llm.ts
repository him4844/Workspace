/**
 * LLM wiring for the API and worker entrypoints (SPEC §51, D-015).
 *
 * `none`          → no client: the pipeline stays on the Phase-1 acknowledgment path
 * `openai` …      → real provider through `packages/agents`
 * `scripted`      → the demo/test personas from `packages/testing` (no network, no key)
 *
 * `scripted` exists so the whole pipeline — planner, prompt, contract validation, persistence,
 * completeness — can be demonstrated and CI-tested without a provider key. It is never a
 * fallback: it must be selected explicitly with `LLM_PROVIDER=scripted`.
 */
import type { Logger } from 'pino';
import { createLlmClient, routeDecision, type ResolvedLlm } from '@wpp/agents';
import type { Config } from '@wpp/infra';

export async function resolveLlmClient(config: Config, logger?: Logger): Promise<ResolvedLlm | null> {
  if (config.LLM_PROVIDER === 'scripted') {
    const { createPipelineLlm } = await import('@wpp/testing');
    // One router for the whole pipeline: the requirements persona answers interview turns, the
    // specification persona answers specification/revision turns and the client-intent classifier —
    // chosen from the task block the runtime built, so a task can never reach the wrong persona.
    // useClientAnswer: the dev console records the human's own words instead of the canned set.
    const client = createPipelineLlm();
    return { client, defaultProvider: 'scripted', defaultModel: 'scripted-client-persona' };
  }
  const resolved = createLlmClient(config);
  if (!resolved) {
    const decision = routeDecision(config);
    logger?.warn({ provider: config.LLM_PROVIDER, preset: config.LLM_PRESET ?? null, freeOnly: config.LLM_FREE_ONLY, reason: decision.reason },
      'LLM disabled: no usable route (see config/llm-presets.json and docs/12)');
  }
  return resolved;
}

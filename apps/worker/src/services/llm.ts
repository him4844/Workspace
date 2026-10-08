/**
 * LLM wiring for the API and worker entrypoints (SPEC §51, D-015).
 *
 * `none`          → no client: the pipeline stays on the Phase-1 acknowledgment path
 * `openai` …      → real provider through `packages/agents`
 * `scripted`      → the demo/test persona from `packages/testing` (no network, no key)
 *
 * `scripted` exists so the whole pipeline — planner, prompt, contract validation, persistence,
 * completeness — can be demonstrated and CI-tested without a provider key. It is never a
 * fallback: it must be selected explicitly with `LLM_PROVIDER=scripted`.
 */
import { createLlmClient, type ResolvedLlm } from '@wpp/agents';
import type { Config } from '@wpp/infra';

export async function resolveLlmClient(config: Config): Promise<ResolvedLlm | null> {
  if (config.LLM_PROVIDER === 'scripted') {
    const { createPersonaLlm, RESTAURANT_PERSONA } = await import('@wpp/testing');
    // useClientAnswer: the dev console records the human's own words instead of the canned set.
    const client = createPersonaLlm(RESTAURANT_PERSONA, { useClientAnswer: true });
    return { client, defaultProvider: 'scripted', defaultModel: 'scripted-client-persona' };
  }
  return createLlmClient(config);
}

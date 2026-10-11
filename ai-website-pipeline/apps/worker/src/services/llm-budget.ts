/** Persisted daily LLM spend guard (SPEC §26, Q4). */
import { estimateCostUsd, estimatePromptTokens, LlmError, routeDecision, type LlmRequest, type LlmUsage } from '@wpp/agents';
import { reserveDailyBudget, settleDailyBudgetReservation, type Db } from '@wpp/db';
import type { Config } from '@wpp/infra';

export interface DailyBudgetGuardInput {
  db: Db;
  orgId: string;
  config: Config;
  provider: string;
  /** For a dedicated route, the caller can prove its own preset is free (writer config is separate). */
  freeRoute?: boolean;
}

export interface DailyBudgetGuard {
  beforeRequest(request: LlmRequest): Promise<unknown>;
  afterRequest(reservation: unknown, outcome: { usage?: LlmUsage; error?: unknown }): Promise<void>;
}

/**
 * Every paid request gets an atomic, per-org/UTC-day worst-case reservation before the provider is
 * called. Successful calls settle against the provider-reported/estimated actual cost; a rate-limit
 * rejection releases the reservation; uncertain failures conservatively retain the reservation.
 * Unknown-price paid routes are refused. Free-tier routes make no reservation and remain $0.
 */
export function createDailyBudgetGuard(input: DailyBudgetGuardInput): DailyBudgetGuard {
  return {
    async beforeRequest(request) {
      if (input.provider === 'none' || input.provider === 'scripted' || input.provider.startsWith('scripted-')) return undefined;

      const openRouterFreeModel = input.provider === 'openrouter' && request.model.endsWith(':free');
      const routeFree = input.freeRoute
        ?? (openRouterFreeModel || (input.config.LLM_FREE_ONLY && routeDecision(input.config).free));
      if (routeFree) return undefined;

      const promptTokens = estimatePromptTokens(request.messages);
      const estimated = estimateCostUsd(input.provider, request.model, promptTokens, request.maxOutputTokens ?? 0);
      if (estimated === undefined) {
        throw new LlmError(
          'LLM_BUDGET_EXCEEDED',
          `daily spend cap cannot be enforced: no price is configured for ${input.provider}/${request.model}; add a verified price or use a free preset`,
          false,
        );
      }
      // chars/4 is an estimate, not a tokenizer. Reserve a 25% margin to protect the hard cap from
      // modest model-tokenization variance; the provider-reported usage settles the reservation later.
      const reservedUsd = Math.max(0.000001, Number((estimated * 1.25).toFixed(6)));
      const now = new Date();
      const utcDay = now.toISOString().slice(0, 10);
      const result = await input.db.transaction((tx) => reserveDailyBudget(tx, {
        orgId: input.orgId,
        utcDay,
        provider: input.provider,
        model: request.model,
        reservedUsd,
        capUsd: input.config.LLM_DAILY_BUDGET_USD,
      }));
      if (!result.ok) {
        throw new LlmError(
          'LLM_BUDGET_EXCEEDED',
          `daily LLM budget exceeded: $${result.spentOrReservedUsd.toFixed(4)} reserved/spent + $${reservedUsd.toFixed(4)} worst-case > $${result.capUsd.toFixed(2)} cap (UTC day)`,
          false,
        );
      }
      return result.reservationId;
    },

    async afterRequest(reservation, outcome) {
      if (typeof reservation !== 'string') return;
      const error = outcome.error as { code?: unknown } | undefined;
      const release = error?.code === 'LLM_RATE_LIMITED';
      const actualUsd = outcome.usage?.costUsd;
      // Missing usage / uncertain provider failure settles at the reserved upper bound rather than
      // opening a loophole. A definite 429 was rejected before inference and releases its hold.
      await input.db.transaction((tx) => settleDailyBudgetReservation(tx, {
        reservationId: reservation,
        actualUsd,
        release,
      }));
    },
  };
}

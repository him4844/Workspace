import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { llmBudgetReservations, llmDailyBudgets } from '../schema.js';
import { uuidv7 } from '@wpp/infra';

export interface ReserveDailyBudgetInput {
  orgId: string;
  utcDay: string;
  provider: string;
  model: string;
  reservedUsd: number;
  capUsd: number;
}

export type ReserveDailyBudgetResult =
  | { ok: true; reservationId: string; reservedUsd: number }
  | { ok: false; spentOrReservedUsd: number; capUsd: number };

/**
 * Atomically reserve the worst-case request cost against one org's UTC-day cap. The UPDATE locks
 * the org/day row and re-checks the predicate after concurrent writers, so two workers cannot both
 * consume the same remaining balance.
 */
export async function reserveDailyBudget(ex: Executor, input: ReserveDailyBudgetInput): Promise<ReserveDailyBudgetResult> {
  const amount = Math.max(0, input.reservedUsd);
  const amountText = amount.toFixed(6);
  const capText = input.capUsd.toFixed(6);
  await ex.insert(llmDailyBudgets).values({ orgId: input.orgId, utcDay: input.utcDay, reservedUsd: '0', actualUsd: '0' }).onConflictDoNothing();

  const updated = await ex.update(llmDailyBudgets)
    .set({
      reservedUsd: sql`${llmDailyBudgets.reservedUsd} + ${amountText}::numeric`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(llmDailyBudgets.orgId, input.orgId),
      eq(llmDailyBudgets.utcDay, input.utcDay),
      sql`${llmDailyBudgets.reservedUsd} + ${llmDailyBudgets.actualUsd} + ${amountText}::numeric <= ${capText}::numeric`,
    ))
    .returning({ reservedUsd: llmDailyBudgets.reservedUsd, actualUsd: llmDailyBudgets.actualUsd });

  if (updated.length === 0) {
    const [current] = await ex.select({ reservedUsd: llmDailyBudgets.reservedUsd, actualUsd: llmDailyBudgets.actualUsd })
      .from(llmDailyBudgets)
      .where(and(eq(llmDailyBudgets.orgId, input.orgId), eq(llmDailyBudgets.utcDay, input.utcDay)))
      .limit(1);
    return {
      ok: false,
      spentOrReservedUsd: Number(current?.reservedUsd ?? 0) + Number(current?.actualUsd ?? 0),
      capUsd: input.capUsd,
    };
  }

  const reservationId = uuidv7();
  await ex.insert(llmBudgetReservations).values({
    id: reservationId,
    orgId: input.orgId,
    utcDay: input.utcDay,
    provider: input.provider,
    model: input.model,
    reservedUsd: amountText,
    status: 'RESERVED',
  });
  return { ok: true, reservationId, reservedUsd: amount };
}

/** Release an unbilled failure, or settle a completed/uncertain request at its actual/estimated cost. */
export async function settleDailyBudgetReservation(
  ex: Executor,
  params: { reservationId: string; actualUsd?: number; release?: boolean },
): Promise<void> {
  const [reservation] = await ex.select().from(llmBudgetReservations)
    .where(eq(llmBudgetReservations.id, params.reservationId)).limit(1);
  if (!reservation || reservation.status !== 'RESERVED') return;

  const reservedUsd = Number(reservation.reservedUsd);
  const actualUsd = params.release ? 0 : (params.actualUsd !== undefined && params.actualUsd >= 0 ? params.actualUsd : reservedUsd);
  await ex.update(llmDailyBudgets)
    .set({
      reservedUsd: sql`greatest(0, ${llmDailyBudgets.reservedUsd} - ${reservation.reservedUsd}::numeric)`,
      actualUsd: sql`${llmDailyBudgets.actualUsd} + ${actualUsd.toFixed(6)}::numeric`,
      updatedAt: new Date(),
    })
    .where(and(eq(llmDailyBudgets.orgId, reservation.orgId), eq(llmDailyBudgets.utcDay, reservation.utcDay)));
  await ex.update(llmBudgetReservations)
    .set({
      status: params.release ? 'RELEASED' : 'SETTLED',
      actualUsd: actualUsd.toFixed(6),
      settledAt: new Date(),
    })
    .where(and(eq(llmBudgetReservations.id, params.reservationId), eq(llmBudgetReservations.status, 'RESERVED')));
}

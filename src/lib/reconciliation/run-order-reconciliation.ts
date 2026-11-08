import { CalculationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import type { Prisma, POSRecord, ReconciliationCase, SettlementRecord } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { computeDifference, toMoney } from "@/lib/money";
import { calculateExpectedAmount, noCalculationBreakdown } from "./calculation";
import { createRateAssumptionEvidence } from "./evidence";
import { matchSettlementsToPos } from "./matching";
import { CALCULATION_FORMULA_VERSION, type RunOrderReconciliationInput, type RunOrderReconciliationResult } from "./types";

/**
 * Matches settlement↔POS records for a restaurant/aggregator/period, computes
 * expected-vs-actual for every matched pair, and creates a ReconciliationCase
 * for every outcome — matched, unmatched-settlement, and unmatched-POS alike
 * — so nothing is invisible. Rerunning for a key that already has a live
 * case supersedes it (see types.ts/schema doc comments) rather than
 * mutating it. The whole run is one transaction, serialized by an advisory
 * lock keyed to this exact scope (same pattern as commit-import.ts's
 * duplicate-detection lock) so two concurrent reruns can't both create a
 * competing "live" case for the same key.
 */
export async function runOrderReconciliation(input: RunOrderReconciliationInput): Promise<RunOrderReconciliationResult> {
  const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${input.periodEnd}T23:59:59.999Z`);
  const lockKey = `${input.restaurantId}:${input.aggregatorId}:${input.periodStart}:${input.periodEnd}:order`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Matching deliberately looks across EVERY aggregator's settlements for
    // this restaurant/period, not just input.aggregatorId. POSRecord carries
    // no aggregatorId (a known Phase 1 limitation), so if this query were
    // scoped to one aggregator, matching.ts's cross-aggregator ambiguity rule
    // could never see the other aggregator's settlements and would never
    // fire — two separate per-aggregator runs could then each successfully
    // (and independently) match the same POS row to their own settlement
    // under a colliding orderRef, double-counting one POS sale as two orders.
    // Fetching everything first lets the ambiguity rule catch that collision;
    // only the matches/unmatched-settlements belonging to THIS run's
    // aggregator are turned into cases below — the other aggregator's own
    // run is responsible for its own settlements.
    const [allSettlements, posRecords] = await Promise.all([
      tx.settlementRecord.findMany({
        where: { restaurantId: input.restaurantId, date: { gte: periodStart, lte: periodEnd } },
      }),
      tx.pOSRecord.findMany({
        where: { restaurantId: input.restaurantId, date: { gte: periodStart, lte: periodEnd } },
      }),
    ]);

    const { matched, unmatchedSettlements, unmatchedPos, ambiguousOrderRefs } = matchSettlementsToPos(allSettlements, posRecords);

    const matchedForThisAggregator = matched.filter((pair) => pair.settlement.aggregatorId === input.aggregatorId);
    const unmatchedSettlementsForThisAggregator = unmatchedSettlements.filter((s) => s.aggregatorId === input.aggregatorId);
    // unmatchedPos is already "unmatched by any aggregator's settlements" —
    // a POS row matched under a different aggregator is not in this list.
    // A POS row whose orderRef also has an unmatched (incl. ambiguous)
    // settlement under THIS aggregator is excluded here: that settlement
    // already gets its own case at this exact (restaurant, aggregator,
    // orderRef) key below, and creating a second, POS-only case for the same
    // key would immediately supersede — and silently discard — the
    // settlement-side case within this same run.
    const settlementCoveredOrderRefs = new Set(
      unmatchedSettlementsForThisAggregator.map((s) => s.orderRef?.trim()).filter((ref): ref is string => Boolean(ref)),
    );
    const unmatchedPosForThisAggregator = unmatchedPos.filter((p) => {
      const ref = p.orderRef?.trim();
      return !ref || !settlementCoveredOrderRefs.has(ref);
    });

    let casesCreated = 0;
    let casesSuperseded = 0;

    for (const pair of matchedForThisAggregator) {
      const superseded = await upsertMatchedCase(tx, input, pair.settlement, pair.pos);
      casesCreated += 1;
      if (superseded) casesSuperseded += 1;
    }

    for (const settlement of unmatchedSettlementsForThisAggregator) {
      const superseded = await upsertUnmatchedSettlementCase(tx, input, settlement);
      casesCreated += 1;
      if (superseded) casesSuperseded += 1;
    }

    for (const pos of unmatchedPosForThisAggregator) {
      const superseded = await upsertUnmatchedPosCase(tx, input, pos);
      casesCreated += 1;
      if (superseded) casesSuperseded += 1;
    }

    return {
      matchedCount: matchedForThisAggregator.length,
      unmatchedSettlementCount: unmatchedSettlementsForThisAggregator.length,
      unmatchedPosCount: unmatchedPosForThisAggregator.length,
      ambiguousOrderRefCount: ambiguousOrderRefs.length,
      casesCreated,
      casesSuperseded,
    };
  });
}

async function findLiveOrderCase(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  aggregatorId: string,
  orderRef: string | null,
): Promise<ReconciliationCase | null> {
  if (!orderRef) return null;
  return tx.reconciliationCase.findFirst({
    where: { restaurantId, aggregatorId, orderRef, scope: ReconciliationScope.ORDER_LEVEL, isSuperseded: false },
  });
}

/**
 * Retires the existing live case BEFORE the new one is inserted. Order
 * matters here: the "one live case per key" partial unique index (see
 * migration SQL) has predicate `isSuperseded = false`, so if the new row
 * were inserted first, both rows would briefly satisfy that predicate at
 * once and the insert would fail its own unique constraint. Retiring first
 * frees the key for the new row's insert.
 */
async function retireIfExists(tx: Prisma.TransactionClient, existing: ReconciliationCase | null): Promise<boolean> {
  if (!existing) return false;
  await tx.reconciliationCase.update({ where: { id: existing.id }, data: { isSuperseded: true } });
  return true;
}

async function upsertMatchedCase(
  tx: Prisma.TransactionClient,
  input: RunOrderReconciliationInput,
  settlement: SettlementRecord,
  pos: POSRecord,
): Promise<boolean> {
  const orderRef = settlement.orderRef!.trim();
  const existing = await findLiveOrderCase(tx, input.restaurantId, input.aggregatorId, orderRef);
  const wasSuperseded = await retireIfExists(tx, existing);

  const grossAmount = toMoney(pos.amount.toString());
  const actualAmount = toMoney(settlement.amount.toString());
  const outcome = calculateExpectedAmount(grossAmount, input.rates);
  const difference = outcome.expectedAmount ? computeDifference(outcome.expectedAmount, actualAmount) : null;

  const newCase = await tx.reconciliationCase.create({
    data: {
      restaurantId: input.restaurantId,
      aggregatorId: input.aggregatorId,
      scope: ReconciliationScope.ORDER_LEVEL,
      orderRef,
      expectedAmount: outcome.expectedAmount?.toFixed(2),
      actualAmount: actualAmount.toFixed(2),
      difference: difference?.toFixed(2),
      calculationStatus: outcome.isCalculated ? CalculationStatus.CALCULATED : CalculationStatus.INSUFFICIENT_DATA,
      calculationFormulaVersion: CALCULATION_FORMULA_VERSION,
      calculationBreakdown: outcome.breakdown as unknown as Prisma.InputJsonValue,
      createdByActorId: input.actorId,
      supersedesCaseId: existing?.id,
    },
  });

  await tx.caseRecordLink.create({ data: { caseId: newCase.id, settlementRecordId: settlement.id } });
  await tx.caseRecordLink.create({ data: { caseId: newCase.id, posRecordId: pos.id } });
  if (input.rates) await createRateAssumptionEvidence(tx, newCase.id, input.actorId, input.rates);

  return wasSuperseded;
}

async function upsertUnmatchedSettlementCase(
  tx: Prisma.TransactionClient,
  input: RunOrderReconciliationInput,
  settlement: SettlementRecord,
): Promise<boolean> {
  const orderRef = settlement.orderRef?.trim() || null;
  const existing = await findLiveOrderCase(tx, input.restaurantId, input.aggregatorId, orderRef);
  const wasSuperseded = await retireIfExists(tx, existing);
  const actualAmount = toMoney(settlement.amount.toString());

  const newCase = await tx.reconciliationCase.create({
    data: {
      restaurantId: input.restaurantId,
      aggregatorId: input.aggregatorId,
      scope: ReconciliationScope.ORDER_LEVEL,
      orderRef,
      expectedAmount: null,
      actualAmount: actualAmount.toFixed(2),
      difference: null,
      calculationStatus: CalculationStatus.UNMATCHED,
      calculationFormulaVersion: CALCULATION_FORMULA_VERSION,
      calculationBreakdown: noCalculationBreakdown(
        "No matching POS record found for this settlement row (or the match was ambiguous — see ambiguousOrderRefCount).",
      ) as unknown as Prisma.InputJsonValue,
      createdByActorId: input.actorId,
      supersedesCaseId: existing?.id,
    },
  });

  await tx.caseRecordLink.create({ data: { caseId: newCase.id, settlementRecordId: settlement.id } });

  return wasSuperseded;
}

async function upsertUnmatchedPosCase(
  tx: Prisma.TransactionClient,
  input: RunOrderReconciliationInput,
  pos: POSRecord,
): Promise<boolean> {
  const orderRef = pos.orderRef?.trim() || null;
  const existing = await findLiveOrderCase(tx, input.restaurantId, input.aggregatorId, orderRef);
  const wasSuperseded = await retireIfExists(tx, existing);

  const newCase = await tx.reconciliationCase.create({
    data: {
      restaurantId: input.restaurantId,
      aggregatorId: input.aggregatorId,
      scope: ReconciliationScope.ORDER_LEVEL,
      orderRef,
      expectedAmount: null,
      actualAmount: null,
      difference: null,
      calculationStatus: CalculationStatus.UNMATCHED,
      calculationFormulaVersion: CALCULATION_FORMULA_VERSION,
      calculationBreakdown: noCalculationBreakdown(
        "No matching settlement record found for this POS order yet — POS records carry no verified aggregator tag (a known Phase 1 limitation), so this is tracked under the aggregator selected for this run, not a confirmed fact.",
      ) as unknown as Prisma.InputJsonValue,
      createdByActorId: input.actorId,
      supersedesCaseId: existing?.id,
    },
  });

  await tx.caseRecordLink.create({ data: { caseId: newCase.id, posRecordId: pos.id } });

  return wasSuperseded;
}

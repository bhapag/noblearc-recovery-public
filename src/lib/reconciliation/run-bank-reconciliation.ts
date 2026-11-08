import { CalculationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { computeDifference, sumMoney, toMoney } from "@/lib/money";
import { CALCULATION_FORMULA_VERSION, type RunBankReconciliationInput, type RunBankReconciliationResult } from "./types";

/**
 * Compares a settlement cycle's total (sum of that period's matched
 * settlement records) against the actual bank credit for the same period —
 * a BANK_CYCLE-scope case, entirely separate from any ORDER_LEVEL case for
 * the same orders. This never feeds into or adjusts an order-level number,
 * and vice versa: the two are independent signals, never summed together
 * (see the ReconciliationScope doc comment in schema.prisma). A shortfall
 * here is not automatically CONFIRMED_DISCREPANCY — it gets the same blank
 * classification as any other case.
 */
export async function runBankReconciliation(input: RunBankReconciliationInput): Promise<RunBankReconciliationResult> {
  const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${input.periodEnd}T23:59:59.999Z`);
  const lockKey = `${input.restaurantId}:${input.aggregatorId}:${input.periodStart}:${input.periodEnd}:bank`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const bankRecord = await tx.bankRecord.findUniqueOrThrow({ where: { id: input.bankRecordId } });
    const settlements = await tx.settlementRecord.findMany({
      where: { restaurantId: input.restaurantId, aggregatorId: input.aggregatorId, date: { gte: periodStart, lte: periodEnd } },
    });

    const actualAmount = toMoney(bankRecord.amount.toString());
    const expectedTotal = settlements.length > 0 ? sumMoney(settlements.map((s) => toMoney(s.amount.toString()))) : null;
    const difference = expectedTotal ? computeDifference(expectedTotal, actualAmount) : null;

    const existing = await tx.reconciliationCase.findFirst({
      where: {
        restaurantId: input.restaurantId,
        aggregatorId: input.aggregatorId,
        scope: ReconciliationScope.BANK_CYCLE,
        periodStart,
        periodEnd,
        isSuperseded: false,
      },
    });

    // Retire the old live case BEFORE inserting the new one — see the same
    // ordering note in run-order-reconciliation.ts's retireIfExists: the
    // partial unique index only allows one non-superseded row per key.
    if (existing) {
      await tx.reconciliationCase.update({ where: { id: existing.id }, data: { isSuperseded: true } });
    }

    const newCase = await tx.reconciliationCase.create({
      data: {
        restaurantId: input.restaurantId,
        aggregatorId: input.aggregatorId,
        scope: ReconciliationScope.BANK_CYCLE,
        orderRef: null,
        periodStart,
        periodEnd,
        expectedAmount: expectedTotal?.toFixed(2),
        actualAmount: actualAmount.toFixed(2),
        difference: difference?.toFixed(2),
        calculationStatus: expectedTotal ? CalculationStatus.CALCULATED : CalculationStatus.INSUFFICIENT_DATA,
        calculationFormulaVersion: CALCULATION_FORMULA_VERSION,
        calculationBreakdown: {
          formulaVersion: CALCULATION_FORMULA_VERSION,
          kind: "bank_cycle",
          settlementRecordCount: settlements.length,
          settlementTotal: expectedTotal?.toFixed(2) ?? null,
          bankCreditAmount: actualAmount.toFixed(2),
          notes:
            settlements.length === 0
              ? "No settlement records found for this restaurant/aggregator/period — nothing to compare the bank credit against."
              : `Sum of ${settlements.length} settlement record(s) for this period, compared against the bank credit.`,
        },
        createdByActorId: input.actorId,
        supersedesCaseId: existing?.id,
      },
    });

    await tx.caseRecordLink.create({ data: { caseId: newCase.id, bankRecordId: bankRecord.id } });
    for (const settlement of settlements) {
      await tx.caseRecordLink.create({ data: { caseId: newCase.id, settlementRecordId: settlement.id } });
    }

    return { caseCreated: true, caseSuperseded: Boolean(existing), settlementRecordCount: settlements.length };
  });
}

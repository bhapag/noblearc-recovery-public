import { ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

export interface EligibleDiscrepancyPickerInput {
  restaurantId: string;
  aggregatorId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface EligibleDiscrepancyOption {
  id: string;
  scope: ReconciliationScope;
  orderRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amount: string;
  derivedDate: string | null;
}

/**
 * The Phase 2 exception named in the Phase 3 brief: a period-scoped
 * (restaurant + aggregator + date range) picker over eligible Confirmed
 * Discrepancy items, purpose-built for recovery-case creation. This does
 * NOT modify or broaden the general /reconciliation workspace, whose
 * order-level results table remains intentionally unscoped by period (see
 * PROJECT_STATE.md) — this is a separate, narrower read path.
 *
 * "Eligible" here means: classification is Confirmed Discrepancy, not
 * superseded, and not already linked to another open recovery case. The
 * authoritative eligibility check still happens again (with a row lock)
 * inside createRecoveryCase/linkDiscrepancyToOpenCase at attach time — this
 * function is a read-only convenience for what to show the operator, not a
 * substitute for that check.
 */
export async function listEligibleDiscrepancies(input: EligibleDiscrepancyPickerInput): Promise<EligibleDiscrepancyOption[]> {
  const candidates = await prisma.reconciliationCase.findMany({
    where: {
      restaurantId: input.restaurantId,
      aggregatorId: input.aggregatorId,
      status: ClassificationStatus.CONFIRMED_DISCREPANCY,
      isSuperseded: false,
    },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 0) return [];

  const activeLinks = await prisma.recoveryCaseReconciliationLink.findMany({
    where: { reconciliationCaseId: { in: candidates.map((c) => c.id) }, releasedAt: null },
    select: { reconciliationCaseId: true },
  });
  const alreadyLinked = new Set(activeLinks.map((l) => l.reconciliationCaseId));

  const bankCycleInRange = candidates.filter(
    (c) =>
      c.scope === ReconciliationScope.BANK_CYCLE &&
      !alreadyLinked.has(c.id) &&
      c.periodStart &&
      c.periodEnd &&
      c.periodStart <= input.periodEnd &&
      c.periodEnd >= input.periodStart,
  );

  const orderLevelCandidates = candidates.filter((c) => c.scope === ReconciliationScope.ORDER_LEVEL && !alreadyLinked.has(c.id));
  const orderLevelResults: EligibleDiscrepancyOption[] = [];
  for (const c of orderLevelCandidates) {
    // ORDER_LEVEL cases carry no period of their own — derive one from the
    // linked settlement record's date (existing Phase 2 data), same
    // technique as confirmed-total.ts. A case with no settlement link
    // (e.g. a POS-only unmatched case) cannot be period-scoped and is
    // excluded from this picker rather than shown with a guessed date.
    const link = await prisma.caseRecordLink.findFirst({
      where: { caseId: c.id, settlementRecordId: { not: null } },
      include: { settlementRecord: true },
    });
    const derivedDate = link?.settlementRecord?.date ?? null;
    if (derivedDate && derivedDate >= input.periodStart && derivedDate <= input.periodEnd) {
      orderLevelResults.push({
        id: c.id,
        scope: c.scope,
        orderRef: c.orderRef,
        periodStart: null,
        periodEnd: null,
        amount: c.difference?.toString() ?? "0",
        derivedDate: derivedDate.toISOString(),
      });
    }
  }

  const bankCycleResults: EligibleDiscrepancyOption[] = bankCycleInRange.map((c) => ({
    id: c.id,
    scope: c.scope,
    orderRef: c.orderRef,
    periodStart: c.periodStart?.toISOString() ?? null,
    periodEnd: c.periodEnd?.toISOString() ?? null,
    amount: c.difference?.toString() ?? "0",
    derivedDate: null,
  }));

  return [...orderLevelResults, ...bankCycleResults];
}

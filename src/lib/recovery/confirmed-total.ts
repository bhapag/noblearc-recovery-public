import { ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import type { ReconciliationCase } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sumMoney, toMoney } from "@/lib/money";
import type { ConfirmedTotalLineItem, ConfirmedTotalResult } from "./types";

interface CandidateItem {
  recoveryCaseId: string;
  reconciliationCase: ReconciliationCase;
  /** Only for ORDER_LEVEL items: the date derived from the linked settlement record, if any. */
  derivedDate: Date | null;
}

/**
 * An ORDER_LEVEL ReconciliationCase has no periodStart/periodEnd of its own
 * (see schema.prisma) — its only date signal is the settlement record it's
 * linked to via CaseRecordLink. This is existing Phase 2 data, not a new
 * field: exactly the "use existing period/scope data where available"
 * instruction. Returns null when no settlement link exists (e.g. a
 * POS-only unmatched case), in which case this item simply cannot be
 * checked for bank-cycle overlap.
 */
async function deriveOrderLevelDate(reconciliationCaseId: string): Promise<Date | null> {
  const link = await prisma.caseRecordLink.findFirst({
    where: { caseId: reconciliationCaseId, settlementRecordId: { not: null } },
    include: { settlementRecord: true },
  });
  return link?.settlementRecord?.date ?? null;
}

function isCurrentlyEligible(reconciliationCase: ReconciliationCase): boolean {
  return reconciliationCase.status === ClassificationStatus.CONFIRMED_DISCREPANCY && !reconciliationCase.isSuperseded;
}

function ineligibleReasonFor(reconciliationCase: ReconciliationCase): string | null {
  if (reconciliationCase.isSuperseded) return "Superseded by a newer calculation since it was linked.";
  if (reconciliationCase.status !== ClassificationStatus.CONFIRMED_DISCREPANCY) {
    return `Reclassified to ${reconciliationCase.status} since it was linked.`;
  }
  return null;
}

/** Every eligible, actively-linked item across every OPEN/REPORT_SENT recovery case for one restaurant/aggregator — the candidate pool for cross-case overlap detection. */
async function fetchCandidatePool(restaurantId: string, aggregatorId: string): Promise<CandidateItem[]> {
  const links = await prisma.recoveryCaseReconciliationLink.findMany({
    where: {
      releasedAt: null,
      recoveryCase: { restaurantId, aggregatorId, status: { in: ["OPEN", "REPORT_SENT"] } },
    },
    include: { reconciliationCase: true },
  });

  const eligibleLinks = links.filter((l) => isCurrentlyEligible(l.reconciliationCase));
  const orderLevelIds = eligibleLinks.filter((l) => l.reconciliationCase.scope === ReconciliationScope.ORDER_LEVEL).map((l) => l.reconciliationCaseId);
  const dateByReconciliationCaseId = new Map<string, Date | null>();
  await Promise.all(
    orderLevelIds.map(async (id) => {
      dateByReconciliationCaseId.set(id, await deriveOrderLevelDate(id));
    }),
  );

  return eligibleLinks.map((l) => ({
    recoveryCaseId: l.recoveryCaseId,
    reconciliationCase: l.reconciliationCase,
    derivedDate: l.reconciliationCase.scope === ReconciliationScope.ORDER_LEVEL ? (dateByReconciliationCaseId.get(l.reconciliationCaseId) ?? null) : null,
  }));
}

function orderLevelFallsWithinBankCycle(orderDate: Date, bankCycle: ReconciliationCase): boolean {
  if (!bankCycle.periodStart || !bankCycle.periodEnd) return false;
  return orderDate >= bankCycle.periodStart && orderDate <= bankCycle.periodEnd;
}

/**
 * Computes the RecoveryCase's confirmed total deterministically from its
 * currently-eligible linked ReconciliationCases — never a stored, manually
 * entered figure. Detects BANK_CYCLE vs ORDER_LEVEL overlap (same
 * restaurant/aggregator/period, within this case or any other concurrently
 * open case) and withholds the overlapping amounts from includedTotal
 * unless the case's overlap review has been completed — see
 * RecoveryCase.overlapReviewed in schema.prisma.
 */
export async function computeConfirmedTotal(recoveryCaseId: string): Promise<ConfirmedTotalResult> {
  const recoveryCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });

  // Deliberately NOT filtered by releasedAt: releasedAt only means "no
  // longer exclusively locking this discrepancy against a NEW recovery
  // case" (see schema.prisma) — it is set on every link when THIS case
  // closes, precisely so the discrepancy becomes available elsewhere. That
  // must not also erase the item from this case's own confirmed total and
  // history. A link only disappears from a case's own record via an actual
  // removal (unlinkDiscrepancy hard-deletes the row — see link.ts).
  const activeLinks = await prisma.recoveryCaseReconciliationLink.findMany({
    where: { recoveryCaseId },
    include: { reconciliationCase: true },
  });

  const ownOrderLevelIds = activeLinks
    .filter((l) => isCurrentlyEligible(l.reconciliationCase) && l.reconciliationCase.scope === ReconciliationScope.ORDER_LEVEL)
    .map((l) => l.reconciliationCaseId);
  const ownDateByReconciliationCaseId = new Map<string, Date | null>();
  await Promise.all(
    ownOrderLevelIds.map(async (id) => {
      ownDateByReconciliationCaseId.set(id, await deriveOrderLevelDate(id));
    }),
  );

  const pool = await fetchCandidatePool(recoveryCase.restaurantId, recoveryCase.aggregatorId);
  const poolBankCycleItems = pool.filter((c) => c.reconciliationCase.scope === ReconciliationScope.BANK_CYCLE);
  const poolOrderLevelItems = pool.filter((c) => c.reconciliationCase.scope === ReconciliationScope.ORDER_LEVEL && c.derivedDate);

  const lineItems: ConfirmedTotalLineItem[] = [];
  const includableAmounts: ReturnType<typeof toMoney>[] = [];
  const blockedAmounts: ReturnType<typeof toMoney>[] = [];
  let hasUnresolvedOverlap = false;

  for (const link of activeLinks) {
    const rc = link.reconciliationCase;
    const currentlyEligible = isCurrentlyEligible(rc);
    let overlapping = false;
    let overlapsWithRecoveryCaseId: string | null = null;

    if (currentlyEligible) {
      if (rc.scope === ReconciliationScope.BANK_CYCLE) {
        const overlap = poolOrderLevelItems.find((o) => o.derivedDate && orderLevelFallsWithinBankCycle(o.derivedDate, rc));
        if (overlap) {
          overlapping = true;
          overlapsWithRecoveryCaseId = overlap.recoveryCaseId;
        }
      } else if (rc.scope === ReconciliationScope.ORDER_LEVEL) {
        const orderDate = ownDateByReconciliationCaseId.get(rc.id) ?? null;
        if (orderDate) {
          const overlap = poolBankCycleItems.find((b) => orderLevelFallsWithinBankCycle(orderDate, b.reconciliationCase));
          if (overlap) {
            overlapping = true;
            overlapsWithRecoveryCaseId = overlap.recoveryCaseId;
          }
        }
      }
    }

    const amount = rc.difference ? toMoney(rc.difference.toString()) : null;
    if (currentlyEligible && amount) {
      if (overlapping && !recoveryCase.overlapReviewed) {
        blockedAmounts.push(amount);
        hasUnresolvedOverlap = true;
      } else {
        includableAmounts.push(amount);
      }
    }

    lineItems.push({
      reconciliationCaseId: rc.id,
      scope: rc.scope,
      orderRef: rc.orderRef,
      periodStart: rc.periodStart?.toISOString() ?? null,
      periodEnd: rc.periodEnd?.toISOString() ?? null,
      amount: amount?.toFixed(2) ?? "0.00",
      currentlyEligible,
      ineligibleReason: currentlyEligible ? null : ineligibleReasonFor(rc),
      overlapping,
      overlapsWithRecoveryCaseId,
    });
  }

  return {
    includedTotal: sumMoney(includableAmounts).toFixed(2),
    blockedAmount: sumMoney(blockedAmounts).toFixed(2),
    hasUnresolvedOverlap,
    lineItems,
  };
}

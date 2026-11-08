import { RecoveryCaseStatus, RecoveryEventStatus } from "@/generated/prisma/enums";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sumMoney, toMoney, type Money } from "@/lib/money";
import { computeConfirmedTotal } from "@/lib/recovery/confirmed-total";
import { getAllocationCaps } from "./eligibility";
import type { RecoveryPositionResult } from "./types";

type QueryClient = PrismaClient | Prisma.TransactionClient;

/**
 * SUM(allocatedAmount) per reconciliationCaseId across THIS RecoveryCase's
 * currently-ACTIVE RecoveryEvents — i.e. what this case itself has verified
 * recovered. Used for the read-side position view and for deriving this case's
 * own status.
 *
 * NEVER use this for allocation-cap enforcement: the cap belongs to the
 * ReconciliationCase, not to one RecoveryCase, so it must be checked against
 * computeGlobalActiveAllocationSums below. Enforcing it against this
 * per-case sum was a real defect that allowed the same discrepancy to be
 * allocated in full again under a second RecoveryCase.
 *
 * Accepts either the global client or a transaction client: callers inside a
 * write transaction MUST pass `tx` so this sees rows written earlier in that
 * same transaction (a plain global-client read would not, since it hasn't
 * committed yet).
 */
export async function computeActiveAllocationSums(client: QueryClient, recoveryCaseId: string): Promise<Map<string, Money>> {
  const allocations = await client.recoveryAllocation.findMany({
    where: { recoveryEvent: { recoveryCaseId, status: RecoveryEventStatus.ACTIVE } },
    select: { reconciliationCaseId: true, allocatedAmount: true },
  });

  const sums = new Map<string, Money>();
  for (const a of allocations) {
    const current = sums.get(a.reconciliationCaseId) ?? toMoney("0");
    sums.set(a.reconciliationCaseId, current.plus(toMoney(a.allocatedAmount.toString())));
  }
  return sums;
}

/**
 * SUM(allocatedAmount) per reconciliationCaseId across ACTIVE RecoveryEvents in
 * EVERY RecoveryCase — deliberately NOT scoped to one RecoveryCase.
 *
 * This is the only sum the hard allocation cap may ever be enforced against.
 * The cap itself is a property of the ReconciliationCase (its own confirmed
 * discrepancy amount), so the "already allocated" side must be measured at the
 * same scope. Measuring it per-RecoveryCase was a real defect: a discrepancy
 * released by one case (see RecoveryCaseReconciliationLink.releasedAt) and
 * re-linked into another could then be allocated a second time in full, because
 * the first case's still-ACTIVE allocations were invisible to the second case's
 * check. Never reintroduce a recoveryCaseId filter here.
 *
 * Callers inside a write transaction MUST pass `tx` so this sees rows written
 * earlier in that same transaction, and MUST already hold the FOR UPDATE lock on
 * the targeted reconciliation_cases rows — that lock is what serializes
 * competing allocation attempts arriving through different RecoveryCases.
 */
export async function computeGlobalActiveAllocationSums(
  client: QueryClient,
  reconciliationCaseIds: string[],
): Promise<Map<string, Money>> {
  const allocations = await client.recoveryAllocation.findMany({
    where: { reconciliationCaseId: { in: reconciliationCaseIds }, recoveryEvent: { status: RecoveryEventStatus.ACTIVE } },
    select: { reconciliationCaseId: true, allocatedAmount: true },
  });

  const sums = new Map<string, Money>();
  for (const a of allocations) {
    const current = sums.get(a.reconciliationCaseId) ?? toMoney("0");
    sums.set(a.reconciliationCaseId, current.plus(toMoney(a.allocatedAmount.toString())));
  }
  return sums;
}

function clampToZero(value: Money): Money {
  return value.isNegative() ? toMoney("0") : value;
}

/**
 * Sums two per-reconciliationCase maps into RecoveryCase-level totals, over
 * the caps map's own key set (every ReconciliationCase ever linked to this
 * RecoveryCase — see getAllocationCaps) so a reconciliationCaseId can never
 * be double-counted or silently dropped because it's missing from one map
 * but not the other. Shared by the read-side view and both write paths
 * (create-event.ts, void-event.ts) so status derivation never drifts from
 * what the UI displays.
 */
export function aggregateTotals(caps: Map<string, Money>, sums: Map<string, Money>): { totalConfirmed: Money; totalVerifiedRecovered: Money } {
  let totalConfirmed = toMoney("0");
  let totalVerifiedRecovered = toMoney("0");
  for (const [id, confirmedAmount] of caps) {
    totalConfirmed = totalConfirmed.plus(confirmedAmount);
    totalVerifiedRecovered = totalVerifiedRecovered.plus(sums.get(id) ?? toMoney("0"));
  }
  return { totalConfirmed, totalVerifiedRecovered };
}

/**
 * The one approved deterministic rule (see CLAUDE.md): verifiedRecovered==0
 * -> AWAITING_RECOVERY; 0<verifiedRecovered<totalConfirmed -> PARTIALLY_RECOVERED;
 * verifiedRecovered==totalConfirmed -> RECOVERY_VERIFIED. Deliberately never
 * returns RECOVERY_CLOSED_PARTIAL — that status is only ever set by the
 * explicit human close-partial action (close-partial.ts) and only ever
 * cleared by a void recomputing through this same function again
 * (void-event.ts) — this function itself has no concept of "closed partial."
 */
export function deriveStatusFromTotals(totalConfirmed: Money, totalVerifiedRecovered: Money): RecoveryCaseStatus {
  if (totalVerifiedRecovered.lessThanOrEqualTo(0)) return RecoveryCaseStatus.AWAITING_RECOVERY;
  if (totalVerifiedRecovered.greaterThanOrEqualTo(totalConfirmed)) return RecoveryCaseStatus.RECOVERY_VERIFIED;
  return RecoveryCaseStatus.PARTIALLY_RECOVERED;
}

/**
 * The full read-side recovery position for one RecoveryCase — every figure
 * the UI's "Confirmed Discrepancy / Verified Recovered / Outstanding" labels
 * are computed from, always derived live, never a stored competing total
 * (the same discipline Phase 3's confirmed-total.ts established). Safe to
 * call outside a transaction for display purposes; write paths that need
 * this to see their own uncommitted writes must not use this — see
 * computeActiveAllocationSums's own client parameter for why, and
 * create-event.ts/void-event.ts for how they recompute status directly.
 */
export async function computeRecoveryPosition(recoveryCaseId: string): Promise<RecoveryPositionResult> {
  const [caps, sums, confirmedTotal] = await Promise.all([
    getAllocationCaps(recoveryCaseId),
    computeActiveAllocationSums(prisma, recoveryCaseId),
    computeConfirmedTotal(recoveryCaseId),
  ]);

  const reconciliationCases = confirmedTotal.lineItems.map((item) => {
    const confirmedAmount = caps.get(item.reconciliationCaseId) ?? toMoney("0");
    const verifiedRecovered = sums.get(item.reconciliationCaseId) ?? toMoney("0");
    const outstanding = clampToZero(confirmedAmount.minus(verifiedRecovered));
    return {
      reconciliationCaseId: item.reconciliationCaseId,
      scope: item.scope,
      orderRef: item.orderRef,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      confirmedAmount: confirmedAmount.toFixed(2),
      verifiedRecovered: verifiedRecovered.toFixed(2),
      outstanding: outstanding.toFixed(2),
    };
  });

  const { totalConfirmed, totalVerifiedRecovered } = aggregateTotals(caps, sums);
  const totalOutstanding = sumMoney(reconciliationCases.map((r) => toMoney(r.outstanding)));

  return {
    reconciliationCases,
    totalConfirmedAmount: totalConfirmed.toFixed(2),
    totalVerifiedRecovered: totalVerifiedRecovered.toFixed(2),
    totalOutstanding: totalOutstanding.toFixed(2),
    derivedStatus: deriveStatusFromTotals(totalConfirmed, totalVerifiedRecovered),
  };
}

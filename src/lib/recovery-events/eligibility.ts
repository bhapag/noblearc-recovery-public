import { prisma } from "@/lib/prisma";
import { toMoney } from "@/lib/money";
import { computeConfirmedTotal } from "@/lib/recovery/confirmed-total";

/**
 * The confirmed-discrepancy cap for every ReconciliationCase currently
 * counted in this RecoveryCase's own confirmed total — deliberately reusing
 * computeConfirmedTotal's exact eligibility rule (currently classified
 * Confirmed Discrepancy, not superseded, and not withheld by an unresolved
 * overlap) rather than re-deriving it, so Phase 5's allocation cap can never
 * silently drift from what the case's own confirmed-total display already
 * shows. A ReconciliationCase absent from this map (or present at "0.00")
 * may not receive any allocation.
 */
export async function getAllocationCaps(recoveryCaseId: string): Promise<Map<string, ReturnType<typeof toMoney>>> {
  const recoveryCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
  const confirmedTotal = await computeConfirmedTotal(recoveryCaseId);

  const caps = new Map<string, ReturnType<typeof toMoney>>();
  for (const item of confirmedTotal.lineItems) {
    const included = item.currentlyEligible && !(item.overlapping && !recoveryCase.overlapReviewed);
    caps.set(item.reconciliationCaseId, included ? toMoney(item.amount) : toMoney("0"));
  }
  return caps;
}

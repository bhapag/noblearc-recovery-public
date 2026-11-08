import { RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { lockAndCheckEligibility } from "./eligibility";
import { recordRecoveryCaseEvent } from "./events";
import type { LinkDiscrepancyResult, UnlinkDiscrepancyResult } from "./types";

interface RecoveryCaseLockRow {
  id: string;
  status: RecoveryCaseStatus;
  restaurantId: string;
  aggregatorId: string;
}

/** Same narrow-raw-select reasoning as eligibility.ts's LockRow. */
async function lockRecoveryCase(tx: Prisma.TransactionClient, recoveryCaseId: string): Promise<RecoveryCaseLockRow | null> {
  const rows = await tx.$queryRaw<RecoveryCaseLockRow[]>`
    SELECT "id", "status", "restaurantId", "aggregatorId"
    FROM "recovery_cases" WHERE "id" = ${recoveryCaseId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Links one eligible Confirmed Discrepancy ReconciliationCase to an OPEN
 * RecoveryCase. Used both by createRecoveryCase (looping over the initial
 * selection) and as a standalone "add another discrepancy" action on an
 * already-created OPEN case. Any successful link resets the case's overlap
 * review (see schema.prisma's RecoveryCase.overlapReviewed doc comment) —
 * the linked set just changed, so a prior review no longer covers it.
 */
export async function linkDiscrepancyToOpenCase(
  tx: Prisma.TransactionClient,
  input: { recoveryCaseId: string; reconciliationCaseId: string; actorId: string },
): Promise<LinkDiscrepancyResult> {
  const recoveryCase = await lockRecoveryCase(tx, input.recoveryCaseId);
  if (!recoveryCase) {
    return { ok: false, message: "Recovery case not found." };
  }
  if (recoveryCase.status !== RecoveryCaseStatus.OPEN) {
    return { ok: false, message: "Discrepancies can only be linked while the recovery case is open." };
  }

  const eligibility = await lockAndCheckEligibility(tx, {
    reconciliationCaseId: input.reconciliationCaseId,
    restaurantId: recoveryCase.restaurantId,
    aggregatorId: recoveryCase.aggregatorId,
  });
  if (!eligibility.ok) {
    return { ok: false, message: eligibility.message };
  }

  await tx.recoveryCaseReconciliationLink.create({
    data: {
      recoveryCaseId: input.recoveryCaseId,
      reconciliationCaseId: input.reconciliationCaseId,
      linkedByActorId: input.actorId,
    },
  });
  await tx.recoveryCase.update({
    where: { id: input.recoveryCaseId },
    data: { overlapReviewed: false, overlapReviewNote: null },
  });
  await recordRecoveryCaseEvent(tx, {
    recoveryCaseId: input.recoveryCaseId,
    actorId: input.actorId,
    kind: RecoveryCaseEventKind.DISCREPANCY_LINKED,
    note: `Linked ${eligibility.reconciliationCase.scope} case${eligibility.reconciliationCase.orderRef ? ` (${eligibility.reconciliationCase.orderRef})` : ""}.`,
    metadata: { reconciliationCaseId: input.reconciliationCaseId, scope: eligibility.reconciliationCase.scope },
  });

  return { ok: true };
}

/**
 * Removes a discrepancy from an OPEN case — a deliberate correction (this
 * item should never have been part of this case), not the same thing as a
 * case closing. This hard-deletes the link row rather than soft-releasing
 * it: unlike a close (see client-response.ts), which keeps every link as
 * part of the case's permanent record while only freeing the discrepancy
 * for reuse, an explicit unlink means the item was never really this case's
 * to begin with, so it must not linger in this case's own confirmed total
 * or evidence-applicability calculations. The RecoveryCaseEvent below is
 * the permanent audit record that this happened — the row itself doesn't
 * need to persist for that.
 */
export async function unlinkDiscrepancy(
  tx: Prisma.TransactionClient,
  input: { recoveryCaseId: string; reconciliationCaseId: string; actorId: string; note?: string },
): Promise<UnlinkDiscrepancyResult> {
  const recoveryCase = await lockRecoveryCase(tx, input.recoveryCaseId);
  if (!recoveryCase) {
    return { ok: false, message: "Recovery case not found." };
  }
  if (recoveryCase.status !== RecoveryCaseStatus.OPEN) {
    return { ok: false, message: "Discrepancies can only be removed while the recovery case is open." };
  }

  const activeLink = await tx.recoveryCaseReconciliationLink.findFirst({
    where: { recoveryCaseId: input.recoveryCaseId, reconciliationCaseId: input.reconciliationCaseId, releasedAt: null },
  });
  if (!activeLink) {
    return { ok: false, message: "This discrepancy is not currently linked to this recovery case." };
  }

  await tx.recoveryCaseReconciliationLink.delete({ where: { id: activeLink.id } });
  await tx.recoveryCase.update({
    where: { id: input.recoveryCaseId },
    data: { overlapReviewed: false, overlapReviewNote: null },
  });
  await recordRecoveryCaseEvent(tx, {
    recoveryCaseId: input.recoveryCaseId,
    actorId: input.actorId,
    kind: RecoveryCaseEventKind.DISCREPANCY_UNLINKED,
    note: input.note ?? null,
    metadata: { reconciliationCaseId: input.reconciliationCaseId },
  });

  return { ok: true };
}

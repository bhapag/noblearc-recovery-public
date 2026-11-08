import { ClassificationStatus } from "@/generated/prisma/enums";
import type { Prisma, ReconciliationCase } from "@/generated/prisma/client";

export type EligibilityFailureReason =
  | "NOT_FOUND"
  | "SUPERSEDED"
  | "NOT_CONFIRMED_DISCREPANCY"
  | "RESTAURANT_MISMATCH"
  | "AGGREGATOR_MISMATCH"
  | "ALREADY_LINKED_TO_OPEN_CASE";

export type EligibilityResult =
  | { ok: true; reconciliationCase: ReconciliationCase }
  | { ok: false; reason: EligibilityFailureReason; message: string };

// Only the columns needed to decide eligibility — deliberately not `SELECT *`
// via $queryRaw, because raw query results don't go through Prisma's runtime
// type marshaling: a Decimal column comes back as a plain string, not a
// Decimal instance, and casting that to the full ReconciliationCase type
// would silently lie about it. Fields actually needed for downstream
// calculation (difference, scope, orderRef, periods) are re-read through a
// normal, fully-typed Prisma query after the lock is confirmed — see below.
interface LockRow {
  id: string;
  isSuperseded: boolean;
  status: ClassificationStatus;
  restaurantId: string;
  aggregatorId: string;
}

/**
 * Locks the target ReconciliationCase row (SELECT ... FOR UPDATE) and checks
 * every Phase 3 linking-eligibility rule against it. The row lock is the
 * concurrency-safety mechanism, not just a correctness check: two concurrent
 * attempts to link the SAME reconciliationCaseId (whether to the same or
 * different RecoveryCases) serialize on this lock, so the second attempt
 * always sees the first one's already-committed link (or reclassification)
 * before deciding. This mirrors the exact FOR UPDATE pattern already used in
 * src/lib/reconciliation/classify.ts and apply-cancellation-override.ts —
 * deliberately the same mechanism, not a new one.
 *
 * MUST be called inside the same transaction that performs the resulting
 * insert/update, and the caller MUST NOT release the transaction between
 * this check and the write that depends on it.
 */
export async function lockAndCheckEligibility(
  tx: Prisma.TransactionClient,
  input: { reconciliationCaseId: string; restaurantId: string; aggregatorId: string },
): Promise<EligibilityResult> {
  const rows = await tx.$queryRaw<LockRow[]>`
    SELECT "id", "isSuperseded", "status", "restaurantId", "aggregatorId"
    FROM "reconciliation_cases" WHERE "id" = ${input.reconciliationCaseId}::uuid FOR UPDATE
  `;
  const lockRow = rows[0];

  if (!lockRow) {
    return { ok: false, reason: "NOT_FOUND", message: "Reconciliation case not found." };
  }
  if (lockRow.isSuperseded) {
    return {
      ok: false,
      reason: "SUPERSEDED",
      message: "This reconciliation case has been superseded by a newer calculation and can no longer be linked.",
    };
  }
  if (lockRow.status !== ClassificationStatus.CONFIRMED_DISCREPANCY) {
    return {
      ok: false,
      reason: "NOT_CONFIRMED_DISCREPANCY",
      message: "Only reconciliation cases classified as Confirmed Discrepancy can be linked to a recovery case.",
    };
  }
  if (lockRow.restaurantId !== input.restaurantId) {
    return { ok: false, reason: "RESTAURANT_MISMATCH", message: "This reconciliation case belongs to a different restaurant." };
  }
  if (lockRow.aggregatorId !== input.aggregatorId) {
    return { ok: false, reason: "AGGREGATOR_MISMATCH", message: "This reconciliation case belongs to a different aggregator." };
  }

  const activeLink = await tx.recoveryCaseReconciliationLink.findFirst({
    where: { reconciliationCaseId: input.reconciliationCaseId, releasedAt: null },
  });
  if (activeLink) {
    return {
      ok: false,
      reason: "ALREADY_LINKED_TO_OPEN_CASE",
      message: "This reconciliation case is already linked to another open recovery case.",
    };
  }

  // Safe to read normally now: the row is locked by this transaction, and
  // Prisma's own query engine correctly marshals Decimal/enum/Date fields.
  const reconciliationCase = await tx.reconciliationCase.findUniqueOrThrow({ where: { id: input.reconciliationCaseId } });
  return { ok: true, reconciliationCase };
}

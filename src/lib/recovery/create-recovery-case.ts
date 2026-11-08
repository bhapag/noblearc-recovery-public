import { RecoveryCaseEventKind } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { lockAndCheckEligibility } from "./eligibility";
import { recordRecoveryCaseEvent } from "./events";
import type { CreateRecoveryCaseInput, CreateRecoveryCaseResult } from "./types";

class IneligibleDiscrepancyError extends Error {}

/**
 * Creates a RecoveryCase and links the operator-selected set of Confirmed
 * Discrepancy reconciliation cases to it, atomically and all-or-nothing: if
 * any selected item fails eligibility, the whole creation is rejected
 * (matching this codebase's established whole-or-nothing import philosophy
 * — see commit-import.ts — rather than silently creating a case with fewer
 * items than the operator actually selected).
 *
 * Target ids are locked in sorted order before any writes, so two
 * concurrent creations that both touch an overlapping set of discrepancies
 * can never deadlock waiting on each other's row locks.
 */
export async function createRecoveryCase(input: CreateRecoveryCaseInput): Promise<CreateRecoveryCaseResult> {
  const uniqueIds = Array.from(new Set(input.reconciliationCaseIds));
  if (uniqueIds.length === 0) {
    return { ok: false, message: "Select at least one Confirmed Discrepancy item to create a recovery case." };
  }
  const sortedIds = [...uniqueIds].sort();

  try {
    const recoveryCaseId = await prisma.$transaction(async (tx) => {
      const recoveryCase = await tx.recoveryCase.create({
        data: {
          restaurantId: input.restaurantId,
          aggregatorId: input.aggregatorId,
          createdByActorId: input.actorId,
        },
      });

      const linkedSummaries: { reconciliationCaseId: string; scope: string; orderRef: string | null }[] = [];
      for (const reconciliationCaseId of sortedIds) {
        const eligibility = await lockAndCheckEligibility(tx, {
          reconciliationCaseId,
          restaurantId: input.restaurantId,
          aggregatorId: input.aggregatorId,
        });
        if (!eligibility.ok) {
          throw new IneligibleDiscrepancyError(eligibility.message);
        }
        await tx.recoveryCaseReconciliationLink.create({
          data: {
            recoveryCaseId: recoveryCase.id,
            reconciliationCaseId,
            linkedByActorId: input.actorId,
          },
        });
        linkedSummaries.push({
          reconciliationCaseId,
          scope: eligibility.reconciliationCase.scope,
          orderRef: eligibility.reconciliationCase.orderRef,
        });
      }

      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: recoveryCase.id,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.CASE_CREATED,
        note: `Created with ${linkedSummaries.length} linked discrepanc${linkedSummaries.length === 1 ? "y" : "ies"}.`,
        metadata: { linked: linkedSummaries },
      });

      return recoveryCase.id;
    });

    return { ok: true, recoveryCaseId };
  } catch (error) {
    if (error instanceof IneligibleDiscrepancyError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

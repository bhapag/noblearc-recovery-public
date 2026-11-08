import { CalculationStatus } from "@/generated/prisma/enums";
import type { Prisma, ReconciliationCase } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { computeDifference, toMoney } from "@/lib/money";
import { calculateCancellationOverrideAmount } from "./calculation";
import { copyEvidenceForward, createCancellationOverrideEvidence } from "./evidence";

export interface ApplyCancellationOverrideInput {
  caseId: string;
  actorId: string;
  cancellationFeeAmount: string;
  sourceReference: string;
}

export type ApplyCancellationOverrideResult =
  | { ok: true; case: ReconciliationCase }
  | { ok: false; message: string };

class InvalidOverrideStateError extends Error {}

/**
 * The per-case cancellation/void override (Action 14 correction,
 * generalized — never a universal rule): the operator explicitly marks one
 * order as cancelled/voided under an evidenced contract rule, supplying the
 * evidenced cancellation-fee amount and its source. This supersedes the
 * case (same audit-preserving mechanism as any other recalculation,
 * classification reset to blank) rather than mutating it in place. Unlike a
 * full rerun, the case's prior evidence is copied forward — this is a
 * targeted correction layered on top of what was already known, not a
 * wholesale re-evaluation with new assumptions.
 */
export async function applyCancellationOverride(input: ApplyCancellationOverrideInput): Promise<ApplyCancellationOverrideResult> {
  if (!input.sourceReference || input.sourceReference.trim().length === 0) {
    return { ok: false, message: "A source reference for the evidenced contract rule is required." };
  }

  const cancellationFeeAmount = toMoney(input.cancellationFeeAmount);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Lock the row before reading it: two concurrent overrides (or an
      // override racing a rerun) on the same case could otherwise both pass
      // the isSuperseded check and both try to supersede it, colliding on
      // the unique supersedesCaseId constraint with an ugly raw DB error
      // instead of the clean "already superseded" message below. See the
      // matching FOR UPDATE lock in classify.ts.
      await tx.$queryRaw`SELECT "id" FROM "reconciliation_cases" WHERE "id" = ${input.caseId}::uuid FOR UPDATE`;
      const existing = await tx.reconciliationCase.findUniqueOrThrow({ where: { id: input.caseId } });
      if (existing.isSuperseded) {
        throw new InvalidOverrideStateError("Cannot apply an override to a superseded case — apply it to the current (superseding) case instead.");
      }
      if (existing.actualAmount === null) {
        throw new InvalidOverrideStateError("Cannot apply a cancellation override to a case with no actual settlement amount to compare against.");
      }

      const actualAmount = toMoney(existing.actualAmount.toString());
      const outcome = calculateCancellationOverrideAmount(cancellationFeeAmount, input.sourceReference.trim());
      const difference = computeDifference(outcome.expectedAmount!, actualAmount);

      // Retire the old case BEFORE inserting the new one — see the ordering
      // note in run-order-reconciliation.ts's retireIfExists: the partial
      // unique index only allows one non-superseded row per key.
      await tx.reconciliationCase.update({ where: { id: existing.id }, data: { isSuperseded: true } });

      const newCase = await tx.reconciliationCase.create({
        data: {
          restaurantId: existing.restaurantId,
          aggregatorId: existing.aggregatorId,
          scope: existing.scope,
          orderRef: existing.orderRef,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
          expectedAmount: outcome.expectedAmount!.toFixed(2),
          actualAmount: actualAmount.toFixed(2),
          difference: difference.toFixed(2),
          calculationStatus: CalculationStatus.CALCULATED,
          calculationFormulaVersion: existing.calculationFormulaVersion,
          calculationBreakdown: outcome.breakdown as unknown as Prisma.InputJsonValue,
          cancellationOverrideApplied: true,
          createdByActorId: input.actorId,
          supersedesCaseId: existing.id,
        },
      });

      // Carry forward the original record links (same underlying settlement/POS/bank rows).
      const oldLinks = await tx.caseRecordLink.findMany({ where: { caseId: existing.id } });
      for (const link of oldLinks) {
        await tx.caseRecordLink.create({
          data: {
            caseId: newCase.id,
            settlementRecordId: link.settlementRecordId,
            posRecordId: link.posRecordId,
            bankRecordId: link.bankRecordId,
          },
        });
      }

      await copyEvidenceForward(tx, existing.id, newCase.id);
      await createCancellationOverrideEvidence(tx, newCase.id, input.actorId, cancellationFeeAmount.toFixed(2), input.sourceReference.trim());

      return newCase;
    });

    return { ok: true, case: updated };
  } catch (error) {
    if (error instanceof InvalidOverrideStateError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

import { DisputeOutcome, RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { toMoney } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import type { RecordDispositionInput, RecordDispositionResult } from "./types";

const CLOSING_OUTCOMES: DisputeOutcome[] = [DisputeOutcome.REJECTED, DisputeOutcome.UNRESOLVED];
const RECOVERY_ELIGIBLE_OUTCOMES: DisputeOutcome[] = [DisputeOutcome.ACCEPTED, DisputeOutcome.PARTIALLY_ACCEPTED];

/**
 * Records the human-decided terminal outcome of one dispute submission —
 * never inferred from free text, never auto-assigned merely because time
 * passed. This is the one place a disposition can change the RecoveryCase's
 * own lifecycle status: REJECTED/UNRESOLVED close it (there is nothing
 * further to pursue this attempt); ACCEPTED/PARTIALLY_ACCEPTED move it to
 * AWAITING_RECOVERY — the Phase 5 entry point — but do NOT themselves
 * create any recovery. `aggregatorStatedAmount`, if provided, is recorded as
 * exactly that: what the aggregator says, never money received, a recovered
 * amount, a success fee, or an invoice figure. It is read-only context for
 * Phase 5 (see src/lib/recovery-events/) — never automatically populates a
 * RecoveryEvent or RecoveryAllocation.
 *
 * The owning RecoveryCase is locked for the duration so this can't race a
 * concurrent resubmission attempt (which also locks the same row) or a
 * second disposition attempt on the same submission (backstopped by the
 * @unique constraint on disputeSubmissionId regardless).
 */
export async function recordDisposition(input: RecordDispositionInput): Promise<RecordDispositionResult> {
  if (!input.evidenceNote.trim()) {
    return { ok: false, message: "An evidence/reference note is required to record a disposition." };
  }
  if (input.aggregatorStatedAmount !== undefined) {
    try {
      toMoney(input.aggregatorStatedAmount);
    } catch {
      return { ok: false, message: "Aggregator-stated amount must be a valid decimal number." };
    }
  }

  const submission = await prisma.disputeSubmission.findUnique({
    where: { id: input.disputeSubmissionId },
    include: { disposition: true },
  });
  if (!submission) {
    return { ok: false, message: "Dispute submission not found." };
  }
  if (!submission.isActive) {
    return { ok: false, message: "This dispute submission has been superseded and can no longer receive a disposition." };
  }
  if (submission.disposition) {
    return { ok: false, message: "A disposition has already been recorded for this dispute submission." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus }[]>`
        SELECT "id", "status" FROM "recovery_cases" WHERE "id" = ${submission.recoveryCaseId}::uuid FOR UPDATE
      `;
      const recoveryCase = lockRows[0];
      if (!recoveryCase) {
        throw new Error("Recovery case not found.");
      }

      await tx.disputeDisposition.create({
        data: {
          disputeSubmissionId: input.disputeSubmissionId,
          outcome: input.outcome,
          decidedAt: input.decidedAt,
          decidedByActorId: input.actorId,
          evidenceNote: input.evidenceNote.trim(),
          aggregatorStatedAmount: input.aggregatorStatedAmount ?? null,
        },
      });
      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: submission.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.DISPOSITION_RECORDED,
        note: `${input.outcome}: ${input.evidenceNote.trim()}`,
        metadata: { disputeSubmissionId: input.disputeSubmissionId, outcome: input.outcome },
      });

      const closes = CLOSING_OUTCOMES.includes(input.outcome) && recoveryCase.status !== RecoveryCaseStatus.CLOSED;
      if (closes) {
        await tx.recoveryCase.update({
          where: { id: submission.recoveryCaseId },
          data: { status: RecoveryCaseStatus.CLOSED, closedAt: new Date() },
        });
        await tx.recoveryCaseReconciliationLink.updateMany({
          where: { recoveryCaseId: submission.recoveryCaseId, releasedAt: null },
          data: { releasedAt: new Date(), releasedByActorId: input.actorId },
        });
        await recordRecoveryCaseEvent(tx, {
          recoveryCaseId: submission.recoveryCaseId,
          actorId: input.actorId,
          kind: RecoveryCaseEventKind.STATUS_CHANGED,
          note: `Closed automatically: dispute disposition recorded as ${input.outcome}.`,
          metadata: { fromStatus: recoveryCase.status, toStatus: RecoveryCaseStatus.CLOSED },
        });
      } else if (RECOVERY_ELIGIBLE_OUTCOMES.includes(input.outcome) && recoveryCase.status !== RecoveryCaseStatus.AWAITING_RECOVERY) {
        await tx.recoveryCase.update({
          where: { id: submission.recoveryCaseId },
          data: { status: RecoveryCaseStatus.AWAITING_RECOVERY },
        });
        await recordRecoveryCaseEvent(tx, {
          recoveryCaseId: submission.recoveryCaseId,
          actorId: input.actorId,
          kind: RecoveryCaseEventKind.STATUS_CHANGED,
          note: `Awaiting recovery: dispute disposition recorded as ${input.outcome}.`,
          metadata: { fromStatus: recoveryCase.status, toStatus: RecoveryCaseStatus.AWAITING_RECOVERY },
        });
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, message: "A disposition has already been recorded for this dispute submission." };
    }
    throw error;
  }

  return { ok: true };
}

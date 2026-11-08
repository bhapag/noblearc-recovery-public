import { RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "./events";
import type { RecordOverlapReviewInput, RecordOverlapReviewResult } from "./types";

/**
 * Records the human checkpoint required before an overlapping BANK_CYCLE /
 * ORDER_LEVEL amount may be summed into the confirmed total (see
 * confirmed-total.ts). The software never decides which item is the
 * duplicate or that the amounts are independent — it only enforces that a
 * human explicitly said so, with a reason, before the total includes them.
 */
export async function recordOverlapReview(input: RecordOverlapReviewInput): Promise<RecordOverlapReviewResult> {
  if (input.reviewed && input.note.trim().length === 0) {
    return { ok: false, message: "A note explaining the overlap review is required." };
  }

  const recoveryCase = await prisma.recoveryCase.findUnique({ where: { id: input.recoveryCaseId } });
  if (!recoveryCase) {
    return { ok: false, message: "Recovery case not found." };
  }
  if (recoveryCase.status === RecoveryCaseStatus.CLOSED) {
    return { ok: false, message: "This recovery case is closed and can no longer be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.recoveryCase.update({
      where: { id: input.recoveryCaseId },
      data: {
        overlapReviewed: input.reviewed,
        overlapReviewNote: input.reviewed ? input.note.trim() : null,
      },
    });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.OVERLAP_REVIEWED,
      note: input.reviewed ? input.note.trim() : "Overlap review cleared.",
      metadata: { reviewed: input.reviewed },
    });
  });

  return { ok: true };
}

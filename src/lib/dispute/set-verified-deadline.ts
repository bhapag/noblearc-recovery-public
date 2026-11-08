import { DeadlineConfidence, RecoveryCaseEventKind } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import type { SetVerifiedDeadlineInput, SetVerifiedDeadlineResult } from "./types";

const VERIFIED_CONFIDENCES: DeadlineConfidence[] = [
  DeadlineConfidence.VERIFIED_PLATFORM_POLICY,
  DeadlineConfidence.VERIFIED_CONTRACT,
  DeadlineConfidence.VERIFIED_PRIOR_CASE,
];

/**
 * The only path that ever sets a verifiedDeadline — always an explicit
 * human action naming its evidence source, never an automatic upgrade from
 * an assumption. Only allowed on the still-active, not-yet-decided
 * submission: once a disposition exists the matter is settled and the
 * deadline is no longer actionable.
 */
export async function setVerifiedDeadline(input: SetVerifiedDeadlineInput): Promise<SetVerifiedDeadlineResult> {
  if (!VERIFIED_CONFIDENCES.includes(input.deadlineConfidence)) {
    return { ok: false, message: "A verified deadline must use one of the VERIFIED_* confidence levels." };
  }
  if (!input.deadlineSourceEvidence.trim()) {
    return { ok: false, message: "A source/evidence reference is required to record a verified deadline." };
  }

  const submission = await prisma.disputeSubmission.findUnique({
    where: { id: input.disputeSubmissionId },
    include: { disposition: true },
  });
  if (!submission) {
    return { ok: false, message: "Dispute submission not found." };
  }
  if (!submission.isActive) {
    return { ok: false, message: "This dispute submission has been superseded and can no longer be changed." };
  }
  if (submission.disposition) {
    return { ok: false, message: "This dispute submission already has a recorded disposition and can no longer be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.disputeSubmission.update({
      where: { id: input.disputeSubmissionId },
      data: {
        verifiedDeadline: input.verifiedDeadline,
        deadlineSourceEvidence: input.deadlineSourceEvidence.trim(),
        deadlineConfidence: input.deadlineConfidence,
      },
    });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: submission.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.VERIFIED_DEADLINE_SET,
      note: `Verified deadline set (${input.deadlineConfidence}): ${input.deadlineSourceEvidence.trim()}`,
      metadata: { disputeSubmissionId: input.disputeSubmissionId, verifiedDeadline: input.verifiedDeadline.toISOString() },
    });
  });

  return { ok: true };
}

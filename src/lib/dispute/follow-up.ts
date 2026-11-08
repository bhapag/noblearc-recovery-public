import { RecoveryCaseEventKind } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import type { AddFollowUpInput, AddFollowUpResult } from "./types";

/**
 * Logs one human-recorded follow-up contact against the specific submission
 * it happened under — never directly against the RecoveryCase, so history
 * stays attached to its own attempt across a resubmission. Purely a factual
 * record: no automated sending, no reminders, no aggregator communication
 * performed by this function or anything it calls.
 */
export async function addFollowUp(input: AddFollowUpInput): Promise<AddFollowUpResult> {
  if (!input.summary.trim()) {
    return { ok: false, message: "A summary is required to record a follow-up." };
  }

  const submission = await prisma.disputeSubmission.findUnique({
    where: { id: input.disputeSubmissionId },
    include: { disposition: true },
  });
  if (!submission) {
    return { ok: false, message: "Dispute submission not found." };
  }
  if (!submission.isActive) {
    return { ok: false, message: "This dispute submission has been superseded and can no longer receive follow-ups." };
  }
  if (submission.disposition) {
    return { ok: false, message: "This dispute submission already has a recorded disposition." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.followUpEntry.create({
      data: {
        disputeSubmissionId: input.disputeSubmissionId,
        occurredAt: input.occurredAt,
        channel: input.channel,
        actorId: input.actorId,
        summary: input.summary.trim(),
        aggregatorResponse: input.aggregatorResponse?.trim() || null,
        nextAction: input.nextAction?.trim() || null,
      },
    });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: submission.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.FOLLOW_UP_ADDED,
      note: input.summary.trim(),
      metadata: { disputeSubmissionId: input.disputeSubmissionId },
    });
  });

  return { ok: true };
}

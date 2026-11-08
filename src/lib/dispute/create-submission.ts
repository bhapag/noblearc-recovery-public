import { ClientResponseStatus, DeadlineConfidence, RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import { buildEvidenceSnapshot } from "./evidence-snapshot";
import type { CreateDisputeSubmissionInput, CreateDisputeSubmissionResult } from "./types";

interface RecoveryCaseLockRow {
  id: string;
  status: RecoveryCaseStatus;
  clientResponseStatus: ClientResponseStatus;
}

async function lockRecoveryCase(tx: Prisma.TransactionClient, recoveryCaseId: string): Promise<RecoveryCaseLockRow | null> {
  const rows = await tx.$queryRaw<RecoveryCaseLockRow[]>`
    SELECT "id", "status", "clientResponseStatus" FROM "recovery_cases" WHERE "id" = ${recoveryCaseId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Creates a dispute submission for an eligible client-approved RecoveryCase,
 * or — if an active submission already exists with no disposition yet —
 * transparently performs a resubmission: the prior active row is superseded
 * (never mutated) before the new one is inserted, matching the exact
 * ordering requirement the partial unique index depends on (see the
 * migration SQL's comment). Once the active submission already has a
 * disposition, the matter is considered decided for Phase 4's purposes and
 * resubmission is rejected — a genuinely new attempt belongs in a fresh
 * RecoveryCase once this one's discrepancies are released (Phase 3
 * behavior, unchanged).
 *
 * The RecoveryCase row is locked for the whole operation, which is what
 * makes "one active submission per case" concurrency-safe: two simultaneous
 * submission attempts for the same case serialize on this lock, so the
 * second one always sees the first's already-committed row before deciding
 * whether to supersede it.
 */
export async function createDisputeSubmission(input: CreateDisputeSubmissionInput): Promise<CreateDisputeSubmissionResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, input.recoveryCaseId);
      if (!recoveryCase) {
        return { ok: false, message: "Recovery case not found." };
      }
      if (recoveryCase.status === RecoveryCaseStatus.CLOSED) {
        return { ok: false, message: "This recovery case is closed and cannot receive a dispute submission." };
      }
      if (recoveryCase.clientResponseStatus !== ClientResponseStatus.APPROVED) {
        return { ok: false, message: "Only a client-approved recovery case may receive a dispute submission." };
      }

      const existingActive = await tx.disputeSubmission.findFirst({
        where: { recoveryCaseId: input.recoveryCaseId, isActive: true },
        include: { disposition: true },
      });
      if (existingActive?.disposition) {
        return {
          ok: false,
          message: "The active dispute submission for this case already has a recorded disposition and cannot be resubmitted.",
        };
      }

      let assumptionPolicyId: string | null = null;
      let workingAssumptionDeadline: Date | null = null;
      if (input.assumptionPolicyId) {
        const policy = await tx.deadlineAssumptionPolicy.findUnique({ where: { id: input.assumptionPolicyId } });
        if (!policy || !policy.active) {
          return { ok: false, message: "Selected deadline assumption policy is invalid or inactive." };
        }
        assumptionPolicyId = policy.id;
        workingAssumptionDeadline = new Date(input.submittedAt.getTime() + policy.defaultDays * 24 * 60 * 60 * 1000);
      }

      const snapshotResult = await buildEvidenceSnapshot(tx, input.recoveryCaseId);
      if (!snapshotResult.ok) {
        return { ok: false, message: snapshotResult.message };
      }

      if (existingActive) {
        await tx.disputeSubmission.update({
          where: { id: existingActive.id },
          data: { isActive: false, supersededAt: new Date(), supersededByActorId: input.actorId },
        });
        await recordRecoveryCaseEvent(tx, {
          recoveryCaseId: input.recoveryCaseId,
          actorId: input.actorId,
          kind: RecoveryCaseEventKind.DISPUTE_SUBMISSION_SUPERSEDED,
          note: "Superseded by a resubmission.",
          metadata: { disputeSubmissionId: existingActive.id },
        });
      }

      const created = await tx.disputeSubmission.create({
        data: {
          recoveryCaseId: input.recoveryCaseId,
          ticketOrReferenceNumber: input.ticketOrReferenceNumber?.trim() || null,
          channel: input.channel,
          submittedAt: input.submittedAt,
          deadlineConfidence: assumptionPolicyId ? DeadlineConfidence.ASSUMED_DEFAULT : DeadlineConfidence.UNKNOWN,
          workingAssumptionDeadline,
          assumptionPolicyId,
          evidenceSnapshot: snapshotResult.snapshot as unknown as Prisma.InputJsonValue,
          createdByActorId: input.actorId,
        },
      });

      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: input.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.DISPUTE_SUBMISSION_CREATED,
        note: existingActive
          ? `Resubmitted (findings report v${snapshotResult.findingsReportVersion}).`
          : `Submitted (findings report v${snapshotResult.findingsReportVersion}).`,
        metadata: { disputeSubmissionId: created.id, findingsReportVersion: snapshotResult.findingsReportVersion },
      });

      return { ok: true, disputeSubmissionId: created.id };
    });
  } catch (error) {
    // A same-instant concurrent submission that both pass the lock-protected
    // check above (shouldn't happen given the row lock, but the partial
    // unique index is the unconditional DB-level backstop) surfaces as a
    // unique constraint violation here rather than corrupting state.
    if (error instanceof Error && error.message.includes("dispute_submissions_active_key")) {
      return { ok: false, message: "Another active dispute submission already exists for this recovery case." };
    }
    throw error;
  }
}

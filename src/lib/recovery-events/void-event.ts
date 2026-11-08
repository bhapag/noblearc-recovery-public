import { RecoveryCaseEventKind, RecoveryCaseStatus, RecoveryEventStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import { aggregateTotals, computeActiveAllocationSums, deriveStatusFromTotals } from "./position";
import { getAllocationCaps } from "./eligibility";
import type { VoidRecoveryEventInput, VoidRecoveryEventResult } from "./types";

/**
 * The only correction mechanism: marks a RecoveryEvent VOIDED (never a hard
 * delete — the original amount, method, date, evidence, and allocations
 * remain permanently queryable) and immediately recomputes which allocations
 * now count as active. This can downgrade or fully reopen the RecoveryCase's
 * status, including overwriting a RECOVERY_CLOSED_PARTIAL declaration — an
 * explicit human closure must never be left standing once the ledger
 * underneath it has changed; the operator must explicitly re-declare it if
 * still appropriate (see close-partial.ts). Voiding is allowed regardless of
 * the RecoveryCase's current status (unlike creating a new event) because a
 * correction must always be possible.
 */
export async function voidRecoveryEvent(input: VoidRecoveryEventInput): Promise<VoidRecoveryEventResult> {
  if (!input.voidReason.trim()) {
    return { ok: false, message: "A void reason is required." };
  }

  const preCheck = await prisma.recoveryEvent.findUnique({ where: { id: input.recoveryEventId } });
  if (!preCheck) {
    return { ok: false, message: "Recovery event not found." };
  }

  return await prisma.$transaction(async (tx) => {
    // Lock the RecoveryEvent row itself before re-checking its status — two
    // concurrent void attempts on the same event must serialize here, or the
    // second could silently overwrite the first's voidReason/voidedByActorId
    // with its own (a real, previously-unfixed race; see CLAUDE.md).
    const eventLockRows = await tx.$queryRaw<{ id: string; status: RecoveryEventStatus; recoveryCaseId: string; method: string; amount: string }[]>`
      SELECT "id", "status", "recoveryCaseId", "method", "amount" FROM "recovery_events" WHERE "id" = ${input.recoveryEventId}::uuid FOR UPDATE
    `;
    const event = eventLockRows[0];
    if (!event) {
      return { ok: false, message: "Recovery event not found." };
    }
    if (event.status === RecoveryEventStatus.VOIDED) {
      return { ok: false, message: "This recovery event has already been voided." };
    }

    const caseLockRows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus }[]>`
      SELECT "id", "status" FROM "recovery_cases" WHERE "id" = ${event.recoveryCaseId}::uuid FOR UPDATE
    `;
    const recoveryCase = caseLockRows[0];
    if (!recoveryCase) {
      return { ok: false, message: "Recovery case not found." };
    }

    const voidedAt = new Date();
    await tx.recoveryEvent.update({
      where: { id: input.recoveryEventId },
      data: { status: RecoveryEventStatus.VOIDED, voidedAt, voidedByActorId: input.actorId, voidReason: input.voidReason.trim() },
    });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: event.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.RECOVERY_VOIDED,
      note: `Voided (${event.method}, ${event.amount}): ${input.voidReason.trim()}`,
      metadata: { recoveryEventId: event.id, voidReason: input.voidReason.trim() },
    });

    const caps = await getAllocationCaps(event.recoveryCaseId);
    const sumsAfter = await computeActiveAllocationSums(tx, event.recoveryCaseId);
    const { totalConfirmed, totalVerifiedRecovered } = aggregateTotals(caps, sumsAfter);
    const newStatus = deriveStatusFromTotals(totalConfirmed, totalVerifiedRecovered);

    if (newStatus !== recoveryCase.status) {
      await tx.recoveryCase.update({ where: { id: event.recoveryCaseId }, data: { status: newStatus } });
      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: event.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.STATUS_CHANGED,
        note:
          recoveryCase.status === RecoveryCaseStatus.RECOVERY_CLOSED_PARTIAL
            ? "Reopened after void: the recovery position changed, so the prior partial-closure declaration no longer applies."
            : `Recovery position changed after void: ${totalVerifiedRecovered.toFixed(2)} of ${totalConfirmed.toFixed(2)} verified.`,
        metadata: { fromStatus: recoveryCase.status, toStatus: newStatus },
      });
    }

    return { ok: true };
  });
}

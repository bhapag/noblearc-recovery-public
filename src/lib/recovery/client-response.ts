import { ClientResponseStatus, RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "./events";
import type { RecordClientResponseInput, RecordClientResponseResult } from "./types";

/**
 * Manually records what the client said outside the system — never an
 * approval link, e-signature, or automated channel.
 *
 * Recording DECLINED closes the case automatically: there is nothing
 * further for its lifecycle to track once the client has said no. Recording
 * APPROVED deliberately does NOT close the case (a Phase 4 extension to the
 * lifecycle Phase 3 originally shipped, where every non-AWAITING response
 * closed the case) — an approved case stays open so a dispute can be
 * submitted against it; only a dispute disposition of REJECTED or
 * UNRESOLVED closes it from there (see src/lib/dispute/disposition.ts).
 *
 * The client response becomes IMMUTABLE through this path as soon as any
 * DisputeSubmission exists for the case. Filing a dispute is an irreversible
 * real-world act, so retroactively changing the client's recorded
 * approval/decline through the ordinary Phase 3 action is no longer coherent
 * — and, concretely, recording DECLINED afterwards would close the case and
 * release every linked discrepancy out from under a dispute (and, once
 * Phase 5 recovery exists, out from under a live financial ledger whose
 * allocations stay ACTIVE). The cutoff is deliberately at submission, not at
 * disposition or at Phase 5 entry. A post-submission correction, if it is
 * ever needed, belongs in a separate explicitly-audited workflow — not here.
 */
export async function recordClientResponse(input: RecordClientResponseInput): Promise<RecordClientResponseResult> {
  const now = new Date();
  const closes = input.status === ClientResponseStatus.DECLINED;

  return await prisma.$transaction(async (tx) => {
    // Every other writer of this row (create-submission.ts, disposition.ts,
    // close-partial.ts, create-event.ts, findings-report.ts, link.ts) takes this
    // same FOR UPDATE lock first, and this one must too: the checks below —
    // especially "has a dispute already been submitted" — are only meaningful if
    // they are serialized against the action they gate. Read unlocked, a
    // concurrent createDisputeSubmission could commit between the check and the
    // write, leaving a live submission attached to a case this call then closes
    // and strips every discrepancy link from.
    const lockRows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus }[]>`
      SELECT "id", "status" FROM "recovery_cases" WHERE "id" = ${input.recoveryCaseId}::uuid FOR UPDATE
    `;
    const recoveryCase = lockRows[0];
    if (!recoveryCase) {
      return { ok: false, message: "Recovery case not found." };
    }
    if (recoveryCase.status === RecoveryCaseStatus.CLOSED) {
      return { ok: false, message: "This recovery case is already closed." };
    }
    if (recoveryCase.status === RecoveryCaseStatus.OPEN) {
      return { ok: false, message: "A findings report must be sent before a client response can be recorded." };
    }

    const existingSubmission = await tx.disputeSubmission.findFirst({
      where: { recoveryCaseId: input.recoveryCaseId },
      select: { id: true },
    });
    if (existingSubmission) {
      return {
        ok: false,
        message: "A dispute has already been submitted for this recovery case — the recorded client response can no longer be changed here.",
      };
    }

    await tx.recoveryCase.update({
      where: { id: input.recoveryCaseId },
      data: {
        clientResponseStatus: input.status,
        clientResponseDate: now,
        clientResponseNote: input.note?.trim() || null,
        ...(closes ? { status: RecoveryCaseStatus.CLOSED, closedAt: now } : {}),
      },
    });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.CLIENT_RESPONSE_RECORDED,
      note: input.note?.trim() || null,
      metadata: { status: input.status },
    });
    if (closes) {
      // Release every active link so its discrepancy is free to join a
      // future recovery case — see RecoveryCaseReconciliationLink.releasedAt
      // in schema.prisma. This must happen in the same transaction as the
      // status flip to CLOSED, or a link could briefly (or permanently, if
      // this step were missing) look "actively held by an open case" when
      // its owning case is actually already closed.
      await tx.recoveryCaseReconciliationLink.updateMany({
        where: { recoveryCaseId: input.recoveryCaseId, releasedAt: null },
        data: { releasedAt: now, releasedByActorId: input.actorId },
      });
      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: input.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.STATUS_CHANGED,
        note: `Closed automatically: client response recorded as ${input.status}.`,
        metadata: { fromStatus: recoveryCase.status, toStatus: RecoveryCaseStatus.CLOSED },
      });
    }

    return { ok: true };
  });
}

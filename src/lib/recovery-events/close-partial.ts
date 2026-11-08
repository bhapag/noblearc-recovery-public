import { RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import type { DeclareRecoveryClosedPartialInput, DeclareRecoveryClosedPartialResult } from "./types";

const RECOVERY_OPEN_STATUSES: RecoveryCaseStatus[] = [RecoveryCaseStatus.AWAITING_RECOVERY, RecoveryCaseStatus.PARTIALLY_RECOVERED];

/**
 * The one explicit human override in the Phase 5 status sub-machine: "no
 * further recovery is expected," declared while some amount remains
 * outstanding — never inferred from age, a deadline, or inactivity. Requires
 * a non-empty justification. Only valid while some recovery is genuinely
 * still outstanding (AWAITING_RECOVERY or PARTIALLY_RECOVERED); a case
 * already fully verified has nothing left to give up on, and this
 * declaration is automatically invalidated/reopened by a later void that
 * changes the underlying numbers (see void-event.ts) — it is never silently
 * left standing against a ledger it no longer describes.
 */
export async function declareRecoveryClosedPartial(input: DeclareRecoveryClosedPartialInput): Promise<DeclareRecoveryClosedPartialResult> {
  if (!input.note.trim()) {
    return { ok: false, message: "A justification note is required to close recovery as partial." };
  }

  return await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus }[]>`
      SELECT "id", "status" FROM "recovery_cases" WHERE "id" = ${input.recoveryCaseId}::uuid FOR UPDATE
    `;
    const recoveryCase = rows[0];
    if (!recoveryCase) {
      return { ok: false, message: "Recovery case not found." };
    }
    if (!RECOVERY_OPEN_STATUSES.includes(recoveryCase.status)) {
      return { ok: false, message: "Recovery can only be closed as partial while the case is Awaiting Recovery or Partially Recovered." };
    }

    await tx.recoveryCase.update({ where: { id: input.recoveryCaseId }, data: { status: RecoveryCaseStatus.RECOVERY_CLOSED_PARTIAL } });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.RECOVERY_CLOSED_PARTIAL_DECLARED,
      note: input.note.trim(),
      metadata: { fromStatus: recoveryCase.status },
    });

    return { ok: true };
  });
}

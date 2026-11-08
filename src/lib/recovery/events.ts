import type { Prisma } from "@/generated/prisma/client";
import type { RecoveryCaseEventKind } from "@/generated/prisma/enums";

/**
 * The single write path for RecoveryCaseEvent — the Phase 3 extension of the
 * append-only audit pattern ClassificationEvent already established. Always
 * called inside the same transaction as the state change it records, never
 * as a separate, best-effort follow-up write.
 */
export async function recordRecoveryCaseEvent(
  tx: Prisma.TransactionClient,
  input: {
    recoveryCaseId: string;
    actorId: string;
    kind: RecoveryCaseEventKind;
    note?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.recoveryCaseEvent.create({
    data: {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: input.kind,
      note: input.note ?? null,
      metadata: input.metadata,
    },
  });
}

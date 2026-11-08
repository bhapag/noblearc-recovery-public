import { ClassificationStatus } from "@/generated/prisma/enums";
import type { ReconciliationCase } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ClassifyInput } from "./types";

interface CaseStatusRow {
  status: ClassificationStatus;
  isSuperseded: boolean;
}

export type ClassifyResult =
  | { ok: true; case: ReconciliationCase }
  | { ok: false; message: string };

class SupersededCaseError extends Error {}

/**
 * The only function permitted to change ReconciliationCase.status — mirrors
 * Phase 0's guardrail that nothing may set a non-UNCLASSIFIED status
 * directly. Every change is atomic with its audit trail: a
 * ClassificationEvent is written in the same transaction as the status
 * update, never separately. Enforced here (not just in the UI) so a direct
 * request can't bypass the CONFIRMED_DISCREPANCY gate.
 */
export async function classifyCase(input: ClassifyInput): Promise<ClassifyResult> {
  if (!input.rationale || input.rationale.trim().length === 0) {
    return { ok: false, message: "A rationale is required to classify a case." };
  }

  if (input.toStatus === ClassificationStatus.UNCLASSIFIED) {
    return { ok: false, message: "UNCLASSIFIED is the blank default — it cannot be explicitly (re-)selected." };
  }

  if (input.toStatus === ClassificationStatus.CONFIRMED_DISCREPANCY) {
    if (!input.confirmedEvidenceReviewed || !input.confirmedSupportable) {
      return {
        ok: false,
        message:
          "Confirming a discrepancy requires acknowledging both that supporting evidence has been reviewed and that the item is considered supportable enough to pursue later.",
      };
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // A plain SELECT here would let two concurrent classifyCase calls on
      // the same case both read the same pre-update status and both write a
      // ClassificationEvent claiming that same (now-stale) fromStatus,
      // corrupting the "what it used to be" audit trail this function exists
      // to protect. SELECT ... FOR UPDATE takes a row lock so the second
      // concurrent call blocks until the first commits, then reads the
      // already-updated status.
      const rows = await tx.$queryRaw<CaseStatusRow[]>`
        SELECT "status", "isSuperseded" FROM "reconciliation_cases" WHERE "id" = ${input.caseId}::uuid FOR UPDATE
      `;
      const current = rows[0];
      if (!current) {
        throw new Error(`ReconciliationCase not found: ${input.caseId}`);
      }
      if (current.isSuperseded) {
        throw new SupersededCaseError();
      }

      await tx.classificationEvent.create({
        data: {
          caseId: input.caseId,
          actorId: input.actorId,
          fromStatus: current.status,
          toStatus: input.toStatus,
          rationale: input.rationale.trim(),
        },
      });

      return tx.reconciliationCase.update({
        where: { id: input.caseId },
        data: { status: input.toStatus },
      });
    });

    return { ok: true, case: updated };
  } catch (error) {
    if (error instanceof SupersededCaseError) {
      return { ok: false, message: "This case has been superseded by a newer calculation — classify the current case instead." };
    }
    throw error;
  }
}

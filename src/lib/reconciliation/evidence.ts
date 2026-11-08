import { EvidenceKind } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { RateAssumptions } from "./types";

/**
 * Records the operator-entered rate assumptions used for a run as
 * case-specific evidence — one row per provided rate, all sharing the run's
 * sourceReference. Never a global "this is the rate" table (CLAUDE.md).
 */
export async function createRateAssumptionEvidence(
  tx: Prisma.TransactionClient,
  caseId: string,
  actorId: string,
  rates: RateAssumptions,
): Promise<void> {
  const entries: { description: string; value: string }[] = [];
  if (rates.commissionRatePercent) {
    entries.push({ description: `Commission rate: ${rates.commissionRatePercent}%`, value: rates.commissionRatePercent });
  }
  if (rates.gstRatePercent) {
    entries.push({ description: `GST on commission rate: ${rates.gstRatePercent}%`, value: rates.gstRatePercent });
  }
  if (rates.fixedFeeAmount) {
    entries.push({ description: `Fixed platform fee: ${rates.fixedFeeAmount}`, value: rates.fixedFeeAmount });
  }
  if (rates.tdsRatePercent) {
    entries.push({ description: `TDS/withholding rate: ${rates.tdsRatePercent}%`, value: rates.tdsRatePercent });
  }
  if (rates.adjustmentAmount) {
    entries.push({ description: `Manual adjustment: ${rates.adjustmentAmount}`, value: rates.adjustmentAmount });
  }

  for (const entry of entries) {
    await tx.caseEvidence.create({
      data: {
        caseId,
        actorId,
        kind: EvidenceKind.RATE_SHEET,
        description: entry.description,
        value: entry.value,
        sourceReference: rates.sourceReference,
      },
    });
  }
}

/** The evidence backing a cancellation/void override — see calculation.ts. */
export async function createCancellationOverrideEvidence(
  tx: Prisma.TransactionClient,
  caseId: string,
  actorId: string,
  cancellationFeeAmount: string,
  sourceReference: string,
): Promise<void> {
  await tx.caseEvidence.create({
    data: {
      caseId,
      actorId,
      kind: EvidenceKind.CONTRACT_TERM,
      description: `Cancelled/voided under evidenced contract rule — expected amount set to ${cancellationFeeAmount}.`,
      value: cancellationFeeAmount,
      sourceReference,
    },
  });
}

/**
 * Copies an old case's evidence onto its new superseding case as fresh rows
 * — never a shared FK. This is the same duplication-is-fine, audit-safe
 * tradeoff CLAUDE.md already establishes for CaseEvidence: the old case's
 * evidence stays exactly as it was, permanently, and the new case gets its
 * own independent copy it can add to or (via a fresh run) not carry forward.
 */
export async function copyEvidenceForward(
  tx: Prisma.TransactionClient,
  oldCaseId: string,
  newCaseId: string,
): Promise<void> {
  const oldEvidence = await tx.caseEvidence.findMany({ where: { caseId: oldCaseId } });
  for (const evidence of oldEvidence) {
    await tx.caseEvidence.create({
      data: {
        caseId: newCaseId,
        actorId: evidence.actorId,
        kind: evidence.kind,
        description: evidence.description,
        value: evidence.value,
        sourceReference: evidence.sourceReference,
        effectiveFrom: evidence.effectiveFrom,
        effectiveTo: evidence.effectiveTo,
        verified: evidence.verified,
      },
    });
  }
}

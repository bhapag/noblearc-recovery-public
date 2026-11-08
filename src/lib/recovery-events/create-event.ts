import { DisputeOutcome, RecoveryCaseEventKind, RecoveryCaseStatus, RecoveryEventStatus, RecoveryMethod } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { roundMoney, sumMoney, toMoney } from "@/lib/money";
import { recordRecoveryCaseEvent } from "@/lib/recovery/events";
import { aggregateTotals, computeActiveAllocationSums, computeGlobalActiveAllocationSums, deriveStatusFromTotals } from "./position";
import { getAllocationCaps } from "./eligibility";
import { normalizeEvidenceReference } from "./normalize";
import type { CreateRecoveryEventInput, CreateRecoveryEventResult } from "./types";

const RECOVERY_OPEN_STATUSES: RecoveryCaseStatus[] = [RecoveryCaseStatus.AWAITING_RECOVERY, RecoveryCaseStatus.PARTIALLY_RECOVERED];
const RECOVERY_ELIGIBLE_OUTCOMES: DisputeOutcome[] = [DisputeOutcome.ACCEPTED, DisputeOutcome.PARTIALLY_ACCEPTED];

/**
 * Records one human-verified recovery fact and its allocations, atomically.
 * This is the ONLY place that ever creates a RecoveryEvent — a plain
 * recording, or (when `supersedesEventId` is set) a correction replacing a
 * specific already-VOIDED prior event (see schema.prisma's RecoveryEvent
 * doc comment). The hard allocation cap
 * (`SUM(active allocations) <= confirmedAmount`, no override) and the
 * `0 < SUM(allocations) <= amount` invariant cannot be expressed as
 * row-local CHECK constraints, so both are enforced here under row locks:
 * the owning RecoveryCase row and every targeted ReconciliationCase row
 * (locked in sorted-id order to avoid deadlocking against a concurrent
 * multi-allocation request) are locked FOR UPDATE before any cap math runs,
 * so two concurrent attempts against the same ReconciliationCase always
 * serialize — the second sees the first's already-committed allocation
 * before deciding whether it still fits under the cap. Imported-record and
 * evidence-reference duplicate protection use the same
 * advisory-lock-then-check pattern already established in Phase 1/2, with
 * the partial unique indexes from the migration as the unconditional
 * DB-level backstop.
 */
export async function createRecoveryEvent(input: CreateRecoveryEventInput): Promise<CreateRecoveryEventResult> {
  // Every monetary value is normalized to canonical 2dp FIRST (the project's
  // existing roundMoney/ROUND_HALF_UP discipline), then validated, then
  // persisted — in that order. Validating an unrounded value and persisting a
  // raw string would let a sub-paisa input (e.g. "0.001") pass a `> 0` check
  // and then land as 0.00 in the DECIMAL(14,2) column, tripping the
  // positive-amount CHECK as an unhandled exception instead of a clean
  // validation message, and would let stored allocations drift a fraction of a
  // paisa away from their event's stored amount.
  let amount: ReturnType<typeof toMoney>;
  try {
    amount = roundMoney(toMoney(input.amount));
  } catch {
    return { ok: false, message: "Amount must be a valid decimal number." };
  }
  if (amount.lessThanOrEqualTo(0)) {
    return { ok: false, message: "Amount must be greater than zero." };
  }
  if (!input.evidenceReference.trim()) {
    return { ok: false, message: "An evidence reference is required." };
  }
  if (input.allocations.length === 0) {
    return { ok: false, message: "At least one allocation is required." };
  }

  let allocations: { reconciliationCaseId: string; amount: ReturnType<typeof toMoney> }[];
  try {
    allocations = input.allocations.map((a) => {
      const allocatedAmount = roundMoney(toMoney(a.allocatedAmount));
      if (allocatedAmount.lessThanOrEqualTo(0)) throw new RangeError("non-positive allocation");
      return { reconciliationCaseId: a.reconciliationCaseId, amount: allocatedAmount };
    });
  } catch {
    return { ok: false, message: "Each allocation amount must be a valid, positive decimal number." };
  }

  const uniqueIds = new Set(allocations.map((a) => a.reconciliationCaseId));
  if (uniqueIds.size !== allocations.length) {
    return { ok: false, message: "Each reconciliation case may only be allocated once per recovery event." };
  }
  const allocationTotal = sumMoney(allocations.map((a) => a.amount));
  if (allocationTotal.greaterThan(amount)) {
    return { ok: false, message: "Total allocated amount cannot exceed the recovery event's own amount." };
  }

  if (input.method === RecoveryMethod.OTHER_EVIDENCED_METHOD && (input.bankRecordId || input.settlementRecordId)) {
    return { ok: false, message: "Other Evidenced Method does not use an imported bank or settlement record." };
  }
  if (input.method === RecoveryMethod.DIRECT_BANK_CREDIT && input.settlementRecordId) {
    return { ok: false, message: "Direct Bank Credit cannot reference a settlement record." };
  }
  if (input.method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && input.bankRecordId) {
    return { ok: false, message: "Future Settlement Offset cannot reference a bank record." };
  }
  // Unlike DIRECT_BANK_CREDIT/OTHER_EVIDENCED_METHOD, a FUTURE_SETTLEMENT_OFFSET
  // has no free-text-only fallback: a promise, email, or ticket response saying
  // "will be adjusted" is explicitly insufficient (see the schema/spec's
  // "future settlement offset safety" boundary) and, unlike a bank credit,
  // there is no other real-world signal a human could point at instead — an
  // actual imported SettlementRecord proving the adjustment already appeared
  // is mandatory for this method.
  if (input.method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && !input.settlementRecordId) {
    return { ok: false, message: "Future Settlement Offset requires a matching imported settlement record proving the adjustment actually appeared — a promise to adjust is not sufficient evidence." };
  }

  const normalizedEvidenceReference = normalizeEvidenceReference(input.evidenceReference);

  try {
    return await prisma.$transaction(async (tx) => {
      const caseLockRows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus; restaurantId: string; aggregatorId: string }[]>`
        SELECT "id", "status", "restaurantId", "aggregatorId" FROM "recovery_cases" WHERE "id" = ${input.recoveryCaseId}::uuid FOR UPDATE
      `;
      const recoveryCase = caseLockRows[0];
      if (!recoveryCase) {
        return { ok: false, message: "Recovery case not found." };
      }
      if (!RECOVERY_OPEN_STATUSES.includes(recoveryCase.status)) {
        return { ok: false, message: "Recovery can only be recorded while the case is Awaiting Recovery or Partially Recovered." };
      }

      const activeLinks = await tx.recoveryCaseReconciliationLink.findMany({
        where: { recoveryCaseId: input.recoveryCaseId, releasedAt: null, reconciliationCaseId: { in: [...uniqueIds] } },
      });
      if (activeLinks.length !== uniqueIds.size) {
        return { ok: false, message: "One or more allocations target a reconciliation case not currently linked to this recovery case." };
      }

      // Deterministic lock ordering across every targeted ReconciliationCase
      // row avoids a deadlock against a concurrent request that targets an
      // overlapping set in a different order.
      const sortedIds = [...uniqueIds].sort();
      await tx.$queryRaw`SELECT "id" FROM "reconciliation_cases" WHERE "id" = ANY(${sortedIds}::uuid[]) ORDER BY "id" FOR UPDATE`;

      if (input.supersedesEventId) {
        const superseded = await tx.recoveryEvent.findUnique({ where: { id: input.supersedesEventId } });
        if (!superseded) return { ok: false, message: "The recovery event being corrected was not found." };
        if (superseded.recoveryCaseId !== input.recoveryCaseId) {
          return { ok: false, message: "The recovery event being corrected belongs to a different recovery case." };
        }
        if (superseded.status !== RecoveryEventStatus.VOIDED) {
          return { ok: false, message: "Only a voided recovery event can be corrected — void it first." };
        }
      }

      const activeSubmission = await tx.disputeSubmission.findFirst({
        where: { recoveryCaseId: input.recoveryCaseId, isActive: true },
        include: { disposition: true },
      });
      if (!activeSubmission?.disposition) {
        return { ok: false, message: "No dispute disposition exists for this recovery case." };
      }
      if (!RECOVERY_ELIGIBLE_OUTCOMES.includes(activeSubmission.disposition.outcome)) {
        return { ok: false, message: "Recovery can only be recorded against an Accepted or Partially Accepted dispute disposition." };
      }

      const caps = await getAllocationCaps(input.recoveryCaseId);
      // The cap belongs to the ReconciliationCase, so the "already allocated"
      // side must be measured at the same scope — GLOBALLY, across every
      // RecoveryCase, not just this one. A discrepancy released by a closed
      // case and re-linked into a new one still carries its earlier ACTIVE
      // allocations, and those must keep counting against its cap. Safe to
      // read here because the targeted reconciliation_cases rows were locked
      // FOR UPDATE above, which serializes competing allocation attempts
      // arriving through different RecoveryCases.
      const globalSumsBefore = await computeGlobalActiveAllocationSums(tx, sortedIds);
      for (const a of allocations) {
        const cap = caps.get(a.reconciliationCaseId) ?? toMoney("0");
        const already = globalSumsBefore.get(a.reconciliationCaseId) ?? toMoney("0");
        if (already.plus(a.amount).greaterThan(cap)) {
          return {
            ok: false,
            message: `Allocation would exceed the confirmed discrepancy amount for one reconciliation case (already allocated ${already.toFixed(2)} of a ${cap.toFixed(2)} cap — no override exists).`,
          };
        }
      }

      if (input.bankRecordId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"recovery-bank:" + input.bankRecordId}))`;
        const bankRecord = await tx.bankRecord.findUnique({ where: { id: input.bankRecordId } });
        if (!bankRecord || bankRecord.restaurantId !== recoveryCase.restaurantId) {
          return { ok: false, message: "Selected bank record was not found for this restaurant." };
        }
        const existing = await tx.recoveryEvent.findFirst({ where: { bankRecordId: input.bankRecordId, status: RecoveryEventStatus.ACTIVE } });
        if (existing) return { ok: false, message: "This bank record is already claimed by another active recovery event." };
      }
      if (input.settlementRecordId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"recovery-settlement:" + input.settlementRecordId}))`;
        const settlementRecord = await tx.settlementRecord.findUnique({ where: { id: input.settlementRecordId } });
        if (!settlementRecord || settlementRecord.restaurantId !== recoveryCase.restaurantId || settlementRecord.aggregatorId !== recoveryCase.aggregatorId) {
          return { ok: false, message: "Selected settlement record was not found for this restaurant/aggregator." };
        }
        const existing = await tx.recoveryEvent.findFirst({ where: { settlementRecordId: input.settlementRecordId, status: RecoveryEventStatus.ACTIVE } });
        if (existing) return { ok: false, message: "This settlement record is already claimed by another active recovery event." };
      }
      if (!input.bankRecordId && !input.settlementRecordId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.method + ":" + normalizedEvidenceReference}))`;
        const existing = await tx.recoveryEvent.findFirst({
          where: { method: input.method, normalizedEvidenceReference, bankRecordId: null, settlementRecordId: null, status: RecoveryEventStatus.ACTIVE },
        });
        if (existing) return { ok: false, message: "An active recovery event already exists with this same method and evidence reference." };
      }

      const created = await tx.recoveryEvent.create({
        data: {
          recoveryCaseId: input.recoveryCaseId,
          disputeSubmissionId: activeSubmission.id,
          disputeDispositionId: activeSubmission.disposition.id,
          method: input.method,
          amount: amount.toFixed(2),
          occurredAt: input.occurredAt,
          evidenceReference: input.evidenceReference.trim(),
          normalizedEvidenceReference,
          operatorNote: input.operatorNote?.trim() || null,
          bankRecordId: input.bankRecordId ?? null,
          settlementRecordId: input.settlementRecordId ?? null,
          supersedesEventId: input.supersedesEventId ?? null,
          verifiedByActorId: input.actorId,
          verifiedAt: input.verifiedAt,
        },
      });

      await tx.recoveryAllocation.createMany({
        data: allocations.map((a) => ({
          recoveryEventId: created.id,
          reconciliationCaseId: a.reconciliationCaseId,
          allocatedAmount: a.amount.toFixed(2),
        })),
      });

      const unallocatedRemainder = amount.minus(allocationTotal);
      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: input.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.RECOVERY_RECORDED,
        note: input.supersedesEventId
          ? `Correction recorded (${input.method}, ${amount.toFixed(2)}), superseding a voided event.`
          : `Recovery recorded (${input.method}, ${amount.toFixed(2)}).`,
        metadata: {
          recoveryEventId: created.id,
          method: input.method,
          amount: amount.toFixed(2),
          allocations: allocations.map((a) => ({ reconciliationCaseId: a.reconciliationCaseId, allocatedAmount: a.amount.toFixed(2) })),
          unallocatedRemainder: unallocatedRemainder.toFixed(2),
          supersedesEventId: input.supersedesEventId ?? null,
        },
      });

      const sumsAfter = await computeActiveAllocationSums(tx, input.recoveryCaseId);
      const { totalConfirmed, totalVerifiedRecovered } = aggregateTotals(caps, sumsAfter);
      const newStatus = deriveStatusFromTotals(totalConfirmed, totalVerifiedRecovered);
      if (newStatus !== recoveryCase.status) {
        await tx.recoveryCase.update({ where: { id: input.recoveryCaseId }, data: { status: newStatus } });
        await recordRecoveryCaseEvent(tx, {
          recoveryCaseId: input.recoveryCaseId,
          actorId: input.actorId,
          kind: RecoveryCaseEventKind.STATUS_CHANGED,
          note: `${newStatus === RecoveryCaseStatus.RECOVERY_VERIFIED ? "Fully" : "Partially"} recovered: ${totalVerifiedRecovered.toFixed(2)} of ${totalConfirmed.toFixed(2)} verified.`,
          metadata: { fromStatus: recoveryCase.status, toStatus: newStatus },
        });
      }

      return { ok: true, recoveryEventId: created.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, message: "This bank record, settlement record, or evidence reference is already claimed by another active recovery event." };
    }
    throw error;
  }
}

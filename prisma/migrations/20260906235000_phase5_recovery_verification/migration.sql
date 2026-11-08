-- CreateEnum
CREATE TYPE "RecoveryMethod" AS ENUM ('DIRECT_BANK_CREDIT', 'FUTURE_SETTLEMENT_OFFSET', 'OTHER_EVIDENCED_METHOD');

-- CreateEnum
CREATE TYPE "RecoveryEventStatus" AS ENUM ('ACTIVE', 'VOIDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'RECOVERY_RECORDED';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'RECOVERY_VOIDED';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'RECOVERY_CLOSED_PARTIAL_DECLARED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecoveryCaseStatus" ADD VALUE 'AWAITING_RECOVERY';
ALTER TYPE "RecoveryCaseStatus" ADD VALUE 'PARTIALLY_RECOVERED';
ALTER TYPE "RecoveryCaseStatus" ADD VALUE 'RECOVERY_VERIFIED';
ALTER TYPE "RecoveryCaseStatus" ADD VALUE 'RECOVERY_CLOSED_PARTIAL';

-- CreateTable
CREATE TABLE "recovery_events" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "disputeSubmissionId" UUID NOT NULL,
    "disputeDispositionId" UUID NOT NULL,
    "method" "RecoveryMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "evidenceReference" TEXT NOT NULL,
    "normalizedEvidenceReference" TEXT NOT NULL,
    "operatorNote" TEXT,
    "verifiedByActorId" UUID NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "status" "RecoveryEventStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesEventId" UUID,
    "bankRecordId" UUID,
    "settlementRecordId" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidedByActorId" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_allocations" (
    "id" UUID NOT NULL,
    "recoveryEventId" UUID NOT NULL,
    "reconciliationCaseId" UUID NOT NULL,
    "allocatedAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_events_supersedesEventId_key" ON "recovery_events"("supersedesEventId");

-- CreateIndex
CREATE INDEX "recovery_events_recoveryCaseId_idx" ON "recovery_events"("recoveryCaseId");

-- CreateIndex
CREATE INDEX "recovery_allocations_reconciliationCaseId_idx" ON "recovery_allocations"("reconciliationCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_allocations_recoveryEventId_reconciliationCaseId_key" ON "recovery_allocations"("recoveryEventId", "reconciliationCaseId");

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_disputeSubmissionId_fkey" FOREIGN KEY ("disputeSubmissionId") REFERENCES "dispute_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_disputeDispositionId_fkey" FOREIGN KEY ("disputeDispositionId") REFERENCES "dispute_dispositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_bankRecordId_fkey" FOREIGN KEY ("bankRecordId") REFERENCES "bank_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_settlementRecordId_fkey" FOREIGN KEY ("settlementRecordId") REFERENCES "settlement_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_verifiedByActorId_fkey" FOREIGN KEY ("verifiedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_voidedByActorId_fkey" FOREIGN KEY ("voidedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_supersedesEventId_fkey" FOREIGN KEY ("supersedesEventId") REFERENCES "recovery_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_allocations" ADD CONSTRAINT "recovery_allocations_recoveryEventId_fkey" FOREIGN KEY ("recoveryEventId") REFERENCES "recovery_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_allocations" ADD CONSTRAINT "recovery_allocations_reconciliationCaseId_fkey" FOREIGN KEY ("reconciliationCaseId") REFERENCES "reconciliation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma's schema DSL cannot express these; see
-- CLAUDE.md "Phase 5 recovery-verification decisions to preserve" for the
-- rationale).

-- Row-local invariant: a recovery amount, and each of its allocations, must
-- be a positive figure. The cross-row "SUM(allocations) <= confirmed amount"
-- and "0 < SUM(allocations) <= event.amount" invariants CANNOT be expressed
-- this way (they depend on other rows/tables) — those are enforced
-- transactionally with row locking in src/lib/recovery-events/create-event.ts.
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "recovery_allocations" ADD CONSTRAINT "recovery_allocations_amount_positive_check" CHECK ("allocatedAmount" > 0);

-- A VOIDED event must always carry its reason/actor/timestamp together —
-- never a silent, unexplained status flip.
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_void_fields_required_check"
  CHECK (("status" <> 'VOIDED') OR ("voidReason" IS NOT NULL AND "voidedAt" IS NOT NULL AND "voidedByActorId" IS NOT NULL));

-- Duplicate-prevention partial unique indexes, all scoped to ACTIVE events
-- only (never a permanent constraint) so a corrected replacement event can
-- reuse the same imported row or evidence reference once the erroneous
-- event that originally claimed it has been voided — see
-- src/lib/recovery-events/void-event.ts and create-event.ts.
--
-- At most one ACTIVE event may claim a given imported BankRecord/
-- SettlementRecord row as its proving evidence — these are the STRONG
-- provenance signal (an imported row represents one real, already-verified
-- financial fact) and are scoped globally, not per-case: the same imported
-- row must never back two different active recovery claims for any reason.
CREATE UNIQUE INDEX "recovery_events_active_bank_record_key"
  ON "recovery_events"("bankRecordId") WHERE "status" = 'ACTIVE' AND "bankRecordId" IS NOT NULL;
CREATE UNIQUE INDEX "recovery_events_active_settlement_record_key"
  ON "recovery_events"("settlementRecordId") WHERE "status" = 'ACTIVE' AND "settlementRecordId" IS NOT NULL;

-- The free-text evidence-reference fallback is a WEAKER provenance signal
-- than an imported row, so its duplicate protection only applies when no
-- imported row backs the event at all (bankRecordId AND settlementRecordId
-- both null) — otherwise two active events that both happen to reuse
-- generic supplementary note text (while each backed by a distinct, already
-- deduplicated imported row) would be wrongly blocked. Keyed on
-- (method, normalizedEvidenceReference) per the approved "same
-- method/reference" duplicate rule, scoped globally for the same
-- real-world-uniqueness reasoning as the imported-row indexes above.
CREATE UNIQUE INDEX "recovery_events_active_reference_key"
  ON "recovery_events"("method", "normalizedEvidenceReference")
  WHERE "status" = 'ACTIVE' AND "bankRecordId" IS NULL AND "settlementRecordId" IS NULL;

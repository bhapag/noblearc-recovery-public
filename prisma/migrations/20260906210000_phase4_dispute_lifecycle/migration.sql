-- CreateEnum
CREATE TYPE "SubmissionChannel" AS ENUM ('AGGREGATOR_PORTAL', 'EMAIL', 'OFFICIAL_SUPPORT', 'OTHER_OFFICIAL_CHANNEL');

-- CreateEnum
CREATE TYPE "DeadlineConfidence" AS ENUM ('UNKNOWN', 'ASSUMED_DEFAULT', 'VERIFIED_PLATFORM_POLICY', 'VERIFIED_CONTRACT', 'VERIFIED_PRIOR_CASE');

-- CreateEnum
CREATE TYPE "DisputeOutcome" AS ENUM ('ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'UNRESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'DISPUTE_SUBMISSION_CREATED';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'DISPUTE_SUBMISSION_SUPERSEDED';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'VERIFIED_DEADLINE_SET';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'FOLLOW_UP_ADDED';
ALTER TYPE "RecoveryCaseEventKind" ADD VALUE 'DISPOSITION_RECORDED';

-- CreateTable
CREATE TABLE "deadline_assumption_policies" (
    "id" UUID NOT NULL,
    "aggregatorId" UUID NOT NULL,
    "category" TEXT,
    "defaultDays" INTEGER NOT NULL,
    "sourceNote" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deadline_assumption_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_submissions" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "ticketOrReferenceNumber" TEXT,
    "channel" "SubmissionChannel" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "verifiedDeadline" TIMESTAMP(3),
    "deadlineSourceEvidence" TEXT,
    "deadlineConfidence" "DeadlineConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "workingAssumptionDeadline" TIMESTAMP(3),
    "assumptionPolicyId" UUID,
    "evidenceSnapshot" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supersededAt" TIMESTAMP(3),
    "supersededByActorId" UUID,
    "createdByActorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispute_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_entries" (
    "id" UUID NOT NULL,
    "disputeSubmissionId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "channel" "SubmissionChannel" NOT NULL,
    "actorId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "aggregatorResponse" TEXT,
    "nextAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_dispositions" (
    "id" UUID NOT NULL,
    "disputeSubmissionId" UUID NOT NULL,
    "outcome" "DisputeOutcome" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "decidedByActorId" UUID NOT NULL,
    "evidenceNote" TEXT NOT NULL,
    "aggregatorStatedAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deadline_assumption_policies_aggregatorId_active_idx" ON "deadline_assumption_policies"("aggregatorId", "active");

-- CreateIndex
CREATE INDEX "dispute_submissions_recoveryCaseId_idx" ON "dispute_submissions"("recoveryCaseId");

-- CreateIndex
CREATE INDEX "follow_up_entries_disputeSubmissionId_occurredAt_idx" ON "follow_up_entries"("disputeSubmissionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_dispositions_disputeSubmissionId_key" ON "dispute_dispositions"("disputeSubmissionId");

-- AddForeignKey
ALTER TABLE "deadline_assumption_policies" ADD CONSTRAINT "deadline_assumption_policies_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_submissions" ADD CONSTRAINT "dispute_submissions_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_submissions" ADD CONSTRAINT "dispute_submissions_assumptionPolicyId_fkey" FOREIGN KEY ("assumptionPolicyId") REFERENCES "deadline_assumption_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_submissions" ADD CONSTRAINT "dispute_submissions_createdByActorId_fkey" FOREIGN KEY ("createdByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_submissions" ADD CONSTRAINT "dispute_submissions_supersededByActorId_fkey" FOREIGN KEY ("supersededByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_entries" ADD CONSTRAINT "follow_up_entries_disputeSubmissionId_fkey" FOREIGN KEY ("disputeSubmissionId") REFERENCES "dispute_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_entries" ADD CONSTRAINT "follow_up_entries_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_dispositions" ADD CONSTRAINT "dispute_dispositions_disputeSubmissionId_fkey" FOREIGN KEY ("disputeSubmissionId") REFERENCES "dispute_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_dispositions" ADD CONSTRAINT "dispute_dispositions_decidedByActorId_fkey" FOREIGN KEY ("decidedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraint (Prisma's schema DSL cannot express this; see
-- CLAUDE.md "Phase 4 dispute-lifecycle decisions to preserve" for the
-- rationale).
--
-- "At most one ACTIVE DisputeSubmission per RecoveryCase" is the same
-- pattern as Phase 3's "one live case per key" / "one active discrepancy
-- link" indexes: a same-table, immutable-per-row partial unique index on
-- isActive, not a cross-table CHECK (which Postgres cannot express). A
-- resubmission sets the old row's isActive to false BEFORE inserting the
-- new row (same ordering requirement as Phase 2/3's supersession pattern —
-- reversing it trips this same index).
CREATE UNIQUE INDEX "dispute_submissions_active_key"
  ON "dispute_submissions"("recoveryCaseId")
  WHERE "isActive" = true;


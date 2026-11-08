-- CreateEnum
CREATE TYPE "CalculationStatus" AS ENUM ('CALCULATED', 'INSUFFICIENT_DATA', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "ReconciliationScope" AS ENUM ('ORDER_LEVEL', 'BANK_CYCLE');

-- AlterEnum
BEGIN;
CREATE TYPE "ClassificationStatus_new" AS ENUM ('UNCLASSIFIED', 'VALID_DEDUCTION', 'TIMING_DIFFERENCE', 'MISSING_DATA_UNMATCHED_ORDER', 'COMMERCIAL_RULE_DIFFERENCE', 'CONFIRMED_DISCREPANCY', 'REQUIRES_HUMAN_REVIEW');
ALTER TABLE "public"."reconciliation_cases" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reconciliation_cases" ALTER COLUMN "status" TYPE "ClassificationStatus_new" USING ("status"::text::"ClassificationStatus_new");
ALTER TABLE "classification_events" ALTER COLUMN "fromStatus" TYPE "ClassificationStatus_new" USING ("fromStatus"::text::"ClassificationStatus_new");
ALTER TABLE "classification_events" ALTER COLUMN "toStatus" TYPE "ClassificationStatus_new" USING ("toStatus"::text::"ClassificationStatus_new");
ALTER TYPE "ClassificationStatus" RENAME TO "ClassificationStatus_old";
ALTER TYPE "ClassificationStatus_new" RENAME TO "ClassificationStatus";
DROP TYPE "public"."ClassificationStatus_old";
ALTER TABLE "reconciliation_cases" ALTER COLUMN "status" SET DEFAULT 'UNCLASSIFIED';
COMMIT;

-- AlterTable
ALTER TABLE "case_evidence" ADD COLUMN     "effectiveFrom" TIMESTAMP(3),
ADD COLUMN     "effectiveTo" TIMESTAMP(3),
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reconciliation_cases" ADD COLUMN     "calculationBreakdown" JSONB NOT NULL,
ADD COLUMN     "calculationFormulaVersion" TEXT NOT NULL,
ADD COLUMN     "calculationStatus" "CalculationStatus" NOT NULL,
ADD COLUMN     "cancellationOverrideApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scope" "ReconciliationScope" NOT NULL,
ADD COLUMN     "supersedesCaseId" UUID,
ADD COLUMN     "isSuperseded" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "expectedAmount" DROP NOT NULL,
ALTER COLUMN "actualAmount" DROP NOT NULL,
ALTER COLUMN "difference" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_cases_supersedesCaseId_key" ON "reconciliation_cases"("supersedesCaseId");

-- CreateIndex
CREATE INDEX "reconciliation_cases_restaurantId_aggregatorId_scope_period_idx" ON "reconciliation_cases"("restaurantId", "aggregatorId", "scope", "periodStart");

-- AddForeignKey
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_supersedesCaseId_fkey" FOREIGN KEY ("supersedesCaseId") REFERENCES "reconciliation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma's schema DSL cannot express these; see
-- CLAUDE.md "Phase 2 reconciliation decisions to preserve" for the rationale).

-- The Phase 0 CHECK "difference = expectedAmount - actualAmount" is being
-- replaced, not just carried over: Postgres CHECK constraints pass whenever
-- the expression evaluates to NULL, so with these columns now nullable, the
-- old constraint would silently accept e.g. expectedAmount = NULL with a
-- non-null, wrong "difference" (NULL - x = NULL, and "anything = NULL" is
-- NULL, which CHECK treats as satisfied). The replacement makes the
-- independent-nullability rule explicit: difference is non-null exactly
-- when both amounts are non-null, and when non-null it must equal the
-- subtraction.
ALTER TABLE "reconciliation_cases" DROP CONSTRAINT IF EXISTS "reconciliation_cases_difference_check";
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_difference_check" CHECK (
  (
    "difference" IS NULL
    AND ("expectedAmount" IS NULL OR "actualAmount" IS NULL)
  )
  OR
  (
    "difference" IS NOT NULL
    AND "expectedAmount" IS NOT NULL
    AND "actualAmount" IS NOT NULL
    AND "difference" = "expectedAmount" - "actualAmount"
  )
);

-- At most one "live" (non-superseded) case per key. Split by scope since
-- only ORDER_LEVEL has a meaningful orderRef key; BANK_CYCLE is scoped by
-- period instead. Postgres partial-index predicates must be immutable
-- per-row expressions — they cannot contain a subquery — so "is this the
-- live case" is read from the isSuperseded column (denormalized alongside
-- supersedesCaseId; application code sets both in the same transaction),
-- not computed via NOT EXISTS against supersedesCaseId.
CREATE UNIQUE INDEX "reconciliation_cases_live_order_key"
  ON "reconciliation_cases"("restaurantId", "aggregatorId", "orderRef")
  WHERE "scope" = 'ORDER_LEVEL'
    AND "orderRef" IS NOT NULL
    AND "isSuperseded" = false;

CREATE UNIQUE INDEX "reconciliation_cases_live_bank_cycle_key"
  ON "reconciliation_cases"("restaurantId", "aggregatorId", "periodStart", "periodEnd")
  WHERE "scope" = 'BANK_CYCLE'
    AND "isSuperseded" = false;


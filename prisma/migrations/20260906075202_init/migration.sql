-- CreateEnum
CREATE TYPE "RecordKind" AS ENUM ('SETTLEMENT', 'POS', 'BANK');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('UNCLASSIFIED', 'NEEDS_MORE_EVIDENCE', 'CONFIRMED_DISCREPANCY', 'FALSE_POSITIVE', 'WAIVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('RATE_SHEET', 'CONTRACT_TERM', 'SCREENSHOT', 'NOTE', 'POLICY_DOCUMENT');

-- CreateTable
CREATE TABLE "actors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregators" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aggregators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_aggregator_accounts" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "aggregatorId" UUID NOT NULL,
    "externalOutletId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_aggregator_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_files" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" "RecordKind" NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByActorId" UUID NOT NULL,

    CONSTRAINT "source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_records" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "aggregatorId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "orderRef" TEXT,
    "sourceFileId" UUID,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_records" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "orderRef" TEXT,
    "sourceFileId" UUID,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_records" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "sourceFileId" UUID,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_cases" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "aggregatorId" UUID NOT NULL,
    "orderRef" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "expectedAmount" DECIMAL(14,2) NOT NULL,
    "actualAmount" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,
    "status" "ClassificationStatus" NOT NULL DEFAULT 'UNCLASSIFIED',
    "createdByActorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_record_links" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "settlementRecordId" UUID,
    "posRecordId" UUID,
    "bankRecordId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_events" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "fromStatus" "ClassificationStatus",
    "toStatus" "ClassificationStatus" NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_evidence" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "description" TEXT NOT NULL,
    "value" DECIMAL(14,2),
    "sourceReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "actors_email_key" ON "actors"("email");

-- CreateIndex
CREATE UNIQUE INDEX "aggregators_name_key" ON "aggregators"("name");

-- CreateIndex
CREATE UNIQUE INDEX "aggregators_slug_key" ON "aggregators"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "restaurants_code_key" ON "restaurants"("code");

-- CreateIndex
CREATE INDEX "restaurant_aggregator_accounts_restaurantId_idx" ON "restaurant_aggregator_accounts"("restaurantId");

-- CreateIndex
CREATE INDEX "restaurant_aggregator_accounts_aggregatorId_idx" ON "restaurant_aggregator_accounts"("aggregatorId");

-- CreateIndex
CREATE INDEX "source_files_kind_uploadedAt_idx" ON "source_files"("kind", "uploadedAt");

-- CreateIndex
CREATE INDEX "settlement_records_restaurantId_aggregatorId_date_idx" ON "settlement_records"("restaurantId", "aggregatorId", "date");

-- CreateIndex
CREATE INDEX "settlement_records_orderRef_idx" ON "settlement_records"("orderRef");

-- CreateIndex
CREATE INDEX "pos_records_restaurantId_date_idx" ON "pos_records"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "pos_records_orderRef_idx" ON "pos_records"("orderRef");

-- CreateIndex
CREATE INDEX "bank_records_restaurantId_date_idx" ON "bank_records"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "reconciliation_cases_restaurantId_status_idx" ON "reconciliation_cases"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_cases_restaurantId_aggregatorId_orderRef_idx" ON "reconciliation_cases"("restaurantId", "aggregatorId", "orderRef");

-- CreateIndex
CREATE INDEX "case_record_links_caseId_idx" ON "case_record_links"("caseId");

-- CreateIndex
CREATE INDEX "classification_events_caseId_createdAt_idx" ON "classification_events"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "case_evidence_caseId_idx" ON "case_evidence"("caseId");

-- AddForeignKey
ALTER TABLE "restaurant_aggregator_accounts" ADD CONSTRAINT "restaurant_aggregator_accounts_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_aggregator_accounts" ADD CONSTRAINT "restaurant_aggregator_accounts_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_uploadedByActorId_fkey" FOREIGN KEY ("uploadedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "source_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_records" ADD CONSTRAINT "pos_records_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_records" ADD CONSTRAINT "pos_records_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "source_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_records" ADD CONSTRAINT "bank_records_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_records" ADD CONSTRAINT "bank_records_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "source_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_createdByActorId_fkey" FOREIGN KEY ("createdByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_record_links" ADD CONSTRAINT "case_record_links_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "reconciliation_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_record_links" ADD CONSTRAINT "case_record_links_settlementRecordId_fkey" FOREIGN KEY ("settlementRecordId") REFERENCES "settlement_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_record_links" ADD CONSTRAINT "case_record_links_posRecordId_fkey" FOREIGN KEY ("posRecordId") REFERENCES "pos_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_record_links" ADD CONSTRAINT "case_record_links_bankRecordId_fkey" FOREIGN KEY ("bankRecordId") REFERENCES "bank_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_events" ADD CONSTRAINT "classification_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "reconciliation_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_events" ADD CONSTRAINT "classification_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "reconciliation_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma's schema DSL cannot express these; see
-- CLAUDE.md "Phase 0 schema decisions to preserve" for the rationale).

-- CaseRecordLink: exactly one of the three record FKs must be set.
ALTER TABLE "case_record_links" ADD CONSTRAINT "case_record_links_exactly_one_record_check" CHECK (
  (
    (CASE WHEN "settlementRecordId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "posRecordId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "bankRecordId" IS NOT NULL THEN 1 ELSE 0 END)
  ) = 1
);

-- ReconciliationCase.difference must always equal expectedAmount - actualAmount
-- (the expected-actual sign convention: positive means the restaurant is owed
-- money). Defense in depth on top of always writing it via computeDifference()
-- in src/lib/money.ts.
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_difference_check" CHECK (
  "difference" = "expectedAmount" - "actualAmount"
);

-- RestaurantAggregatorAccount: a plain multi-column unique index would not
-- prevent duplicates when externalOutletId is NULL (Postgres treats every
-- NULL as distinct). Two partial unique indexes instead: at most one
-- "unspecified outlet" row per restaurant+aggregator, and normal uniqueness
-- once an outlet is identified.
CREATE UNIQUE INDEX "restaurant_aggregator_accounts_unique_no_outlet"
  ON "restaurant_aggregator_accounts"("restaurantId", "aggregatorId")
  WHERE "externalOutletId" IS NULL;

CREATE UNIQUE INDEX "restaurant_aggregator_accounts_unique_with_outlet"
  ON "restaurant_aggregator_accounts"("restaurantId", "aggregatorId", "externalOutletId")
  WHERE "externalOutletId" IS NOT NULL;

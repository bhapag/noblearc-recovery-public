-- CreateEnum
CREATE TYPE "RecoveryCaseStatus" AS ENUM ('OPEN', 'REPORT_SENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "ClientResponseStatus" AS ENUM ('AWAITING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "RecoveryCaseEventKind" AS ENUM ('CASE_CREATED', 'DISCREPANCY_LINKED', 'DISCREPANCY_UNLINKED', 'EVIDENCE_ITEM_ADDED', 'EVIDENCE_ITEM_UPDATED', 'EVIDENCE_ITEM_REMOVED', 'OVERLAP_REVIEWED', 'REPORT_GENERATED', 'REPORT_MARKED_SENT', 'CLIENT_RESPONSE_RECORDED', 'STATUS_CHANGED');

-- CreateTable
CREATE TABLE "evidence_categories" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isConditional" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "evidence_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "recovery_cases" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "aggregatorId" UUID NOT NULL,
    "status" "RecoveryCaseStatus" NOT NULL DEFAULT 'OPEN',
    "clientResponseStatus" "ClientResponseStatus" NOT NULL DEFAULT 'AWAITING',
    "clientResponseDate" TIMESTAMP(3),
    "clientResponseNote" TEXT,
    "overlapReviewed" BOOLEAN NOT NULL DEFAULT false,
    "overlapReviewNote" TEXT,
    "reportSentAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdByActorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_case_reconciliation_links" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "reconciliationCaseId" UUID NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedByActorId" UUID NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedByActorId" UUID,

    CONSTRAINT "recovery_case_reconciliation_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_items" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evidence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings_reports" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedByActorId" UUID NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentByActorId" UUID,
    "sentVia" TEXT,

    CONSTRAINT "findings_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_case_events" (
    "id" UUID NOT NULL,
    "recoveryCaseId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "kind" "RecoveryCaseEventKind" NOT NULL,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_case_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_cases_restaurantId_aggregatorId_status_idx" ON "recovery_cases"("restaurantId", "aggregatorId", "status");

-- CreateIndex
CREATE INDEX "recovery_case_reconciliation_links_recoveryCaseId_idx" ON "recovery_case_reconciliation_links"("recoveryCaseId");

-- CreateIndex
CREATE INDEX "recovery_case_reconciliation_links_reconciliationCaseId_idx" ON "recovery_case_reconciliation_links"("reconciliationCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_items_recoveryCaseId_categoryCode_key" ON "evidence_items"("recoveryCaseId", "categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "findings_reports_recoveryCaseId_version_key" ON "findings_reports"("recoveryCaseId", "version");

-- CreateIndex
CREATE INDEX "recovery_case_events_recoveryCaseId_createdAt_idx" ON "recovery_case_events"("recoveryCaseId", "createdAt");

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_createdByActorId_fkey" FOREIGN KEY ("createdByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_reconciliation_links" ADD CONSTRAINT "recovery_case_reconciliation_links_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_reconciliation_links" ADD CONSTRAINT "recovery_case_reconciliation_links_reconciliationCaseId_fkey" FOREIGN KEY ("reconciliationCaseId") REFERENCES "reconciliation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_reconciliation_links" ADD CONSTRAINT "recovery_case_reconciliation_links_linkedByActorId_fkey" FOREIGN KEY ("linkedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_reconciliation_links" ADD CONSTRAINT "recovery_case_reconciliation_links_releasedByActorId_fkey" FOREIGN KEY ("releasedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "evidence_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings_reports" ADD CONSTRAINT "findings_reports_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings_reports" ADD CONSTRAINT "findings_reports_generatedByActorId_fkey" FOREIGN KEY ("generatedByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings_reports" ADD CONSTRAINT "findings_reports_sentByActorId_fkey" FOREIGN KEY ("sentByActorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_events" ADD CONSTRAINT "recovery_case_events_recoveryCaseId_fkey" FOREIGN KEY ("recoveryCaseId") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_case_events" ADD CONSTRAINT "recovery_case_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraint (Prisma's schema DSL cannot express this; see
-- CLAUDE.md "Phase 3 recovery-case decisions to preserve" for the rationale).
--
-- "A given ReconciliationCase may belong to only one OPEN RecoveryCase at a
-- time" cannot be expressed as a CHECK constraint (that would require
-- reading another table's live status, which Postgres CHECK constraints
-- cannot do) or as a plain unique constraint (a discrepancy legitimately
-- gets a fresh link row after its previous RecoveryCase closes and
-- releases it). Instead: releasedAt is NULL exactly while a link is
-- "active" (the owning RecoveryCase is still OPEN or REPORT_SENT), and this
-- partial unique index enforces "at most one active link per
-- reconciliationCaseId" — a same-table, immutable-per-row predicate, which
-- Postgres partial indexes CAN express. Application code sets releasedAt
-- (never deletes the row) when a RecoveryCase closes or a link is
-- explicitly removed; the classification-eligibility check itself (is the
-- linked case currently Confirmed Discrepancy?) is enforced separately in
-- src/lib/recovery/create-recovery-case.ts via a row lock, not here.
CREATE UNIQUE INDEX "recovery_case_reconciliation_links_active_key"
  ON "recovery_case_reconciliation_links"("reconciliationCaseId")
  WHERE "releasedAt" IS NULL;


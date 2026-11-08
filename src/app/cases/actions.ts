"use server";

import { z } from "zod";
import { ClientResponseStatus, RecoveryCaseStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { createRecoveryCase } from "@/lib/recovery/create-recovery-case";
import { linkDiscrepancyToOpenCase, unlinkDiscrepancy } from "@/lib/recovery/link";
import { setEvidenceItem, removeEvidenceItem, computeEvidenceReadiness } from "@/lib/recovery/evidence";
import { recordOverlapReview } from "@/lib/recovery/overlap-review";
import { generateFindingsReport, markReportSent } from "@/lib/recovery/findings-report";
import { recordClientResponse } from "@/lib/recovery/client-response";
import { computeConfirmedTotal } from "@/lib/recovery/confirmed-total";
import { listEligibleDiscrepancies, type EligibleDiscrepancyOption } from "@/lib/recovery/eligible-discrepancy-picker";
import type { ConfirmedTotalResult, EvidenceReadinessResult } from "@/lib/recovery/types";

/** Same known, documented no-authentication limitation as Phase 1/2. */
async function getSystemActorId(): Promise<string> {
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return systemActor.id;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (yyyy-MM-dd).");

export async function getCasesContextAction(): Promise<{
  restaurants: { id: string; name: string; code: string }[];
  aggregators: { id: string; name: string; slug: string }[];
}> {
  const [restaurants, aggregators] = await Promise.all([
    prisma.restaurant.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    prisma.aggregator.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
  ]);
  return { restaurants, aggregators };
}

const pickerSchema = z.object({
  restaurantId: z.string().uuid(),
  aggregatorId: z.string().uuid(),
  periodStart: isoDate,
  periodEnd: isoDate,
});

export async function listEligibleDiscrepanciesAction(
  input: unknown,
): Promise<{ ok: true; options: EligibleDiscrepancyOption[] } | { ok: false; message: string }> {
  const parsed = pickerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, or period." };
  const periodStart = new Date(`${parsed.data.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${parsed.data.periodEnd}T23:59:59.999Z`);
  if (periodStart > periodEnd) return { ok: false, message: "Period start must be on or before period end." };

  const options = await listEligibleDiscrepancies({
    restaurantId: parsed.data.restaurantId,
    aggregatorId: parsed.data.aggregatorId,
    periodStart,
    periodEnd,
  });
  return { ok: true, options };
}

const createSchema = z.object({
  restaurantId: z.string().uuid(),
  aggregatorId: z.string().uuid(),
  reconciliationCaseIds: z.array(z.string().uuid()).min(1),
});

export async function createRecoveryCaseAction(input: unknown): Promise<{ ok: true; recoveryCaseId: string } | { ok: false; message: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, or discrepancy selection." };
  const actorId = await getSystemActorId();
  return createRecoveryCase({ ...parsed.data, actorId });
}

export interface RecoveryCaseSummary {
  id: string;
  restaurantName: string;
  restaurantCode: string;
  aggregatorName: string;
  status: RecoveryCaseStatus;
  clientResponseStatus: ClientResponseStatus;
  createdAt: string;
  reportSentAt: string | null;
  closedAt: string | null;
  linkedCount: number;
  confirmedTotal: string;
  hasUnresolvedOverlap: boolean;
  evidenceReady: boolean;
}

const listCasesSchema = z.object({
  restaurantId: z.string().uuid().optional(),
  aggregatorId: z.string().uuid().optional(),
  status: z.enum([RecoveryCaseStatus.OPEN, RecoveryCaseStatus.REPORT_SENT, RecoveryCaseStatus.CLOSED]).optional(),
});

export async function listRecoveryCasesAction(input: unknown): Promise<{ ok: true; cases: RecoveryCaseSummary[] } | { ok: false; message: string }> {
  const parsed = listCasesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid filter." };

  const cases = await prisma.recoveryCase.findMany({
    where: {
      restaurantId: parsed.data.restaurantId,
      aggregatorId: parsed.data.aggregatorId,
      status: parsed.data.status,
    },
    include: {
      restaurant: true,
      aggregator: true,
      // Not filtered by releasedAt — see confirmed-total.ts's note: a
      // closed case's links are released for reuse elsewhere but remain
      // part of this case's own permanent record.
      links: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const summaries = await Promise.all(
    cases.map(async (c) => {
      const [confirmedTotal, readiness] = await Promise.all([computeConfirmedTotal(c.id), computeEvidenceReadiness(c.id)]);
      return {
        id: c.id,
        restaurantName: c.restaurant.name,
        restaurantCode: c.restaurant.code,
        aggregatorName: c.aggregator.name,
        status: c.status,
        clientResponseStatus: c.clientResponseStatus,
        createdAt: c.createdAt.toISOString(),
        reportSentAt: c.reportSentAt?.toISOString() ?? null,
        closedAt: c.closedAt?.toISOString() ?? null,
        linkedCount: c.links.length,
        confirmedTotal: confirmedTotal.includedTotal,
        hasUnresolvedOverlap: confirmedTotal.hasUnresolvedOverlap,
        evidenceReady: readiness.ready,
      };
    }),
  );

  return { ok: true, cases: summaries };
}

export interface RecoveryCaseDetail {
  id: string;
  restaurantId: string;
  aggregatorId: string;
  restaurantName: string;
  restaurantCode: string;
  aggregatorName: string;
  status: RecoveryCaseStatus;
  clientResponseStatus: ClientResponseStatus;
  clientResponseDate: string | null;
  clientResponseNote: string | null;
  overlapReviewed: boolean;
  overlapReviewNote: string | null;
  createdAt: string;
  reportSentAt: string | null;
  closedAt: string | null;
  confirmedTotal: ConfirmedTotalResult;
  evidenceReadiness: EvidenceReadinessResult;
  evidenceCategories: { code: string; label: string; isConditional: boolean; sortOrder: number }[];
  evidenceItems: { categoryCode: string; reference: string | null; note: string | null; actorName: string; updatedAt: string }[];
  reports: { id: string; version: number; generatedAt: string; sentAt: string | null; sentVia: string | null; content: Record<string, unknown> }[];
  events: { id: string; kind: string; note: string | null; actorName: string; createdAt: string; metadata: Record<string, unknown> | null }[];
}

export async function getRecoveryCaseDetailAction(input: unknown): Promise<{ ok: true; detail: RecoveryCaseDetail } | { ok: false; message: string }> {
  const parsed = z.object({ recoveryCaseId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid case id." };

  const recoveryCase = await prisma.recoveryCase.findUnique({
    where: { id: parsed.data.recoveryCaseId },
    include: {
      restaurant: true,
      aggregator: true,
      evidence: { include: { actor: true } },
      reports: { orderBy: { version: "desc" }, include: { generatedByActor: true } },
      events: { orderBy: { createdAt: "desc" }, include: { actor: true } },
    },
  });
  if (!recoveryCase) return { ok: false, message: "Recovery case not found." };

  const [confirmedTotal, evidenceReadiness, evidenceCategories] = await Promise.all([
    computeConfirmedTotal(recoveryCase.id),
    computeEvidenceReadiness(recoveryCase.id),
    prisma.evidenceCategory.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  return {
    ok: true,
    detail: {
      id: recoveryCase.id,
      restaurantId: recoveryCase.restaurantId,
      aggregatorId: recoveryCase.aggregatorId,
      restaurantName: recoveryCase.restaurant.name,
      restaurantCode: recoveryCase.restaurant.code,
      aggregatorName: recoveryCase.aggregator.name,
      status: recoveryCase.status,
      clientResponseStatus: recoveryCase.clientResponseStatus,
      clientResponseDate: recoveryCase.clientResponseDate?.toISOString() ?? null,
      clientResponseNote: recoveryCase.clientResponseNote,
      overlapReviewed: recoveryCase.overlapReviewed,
      overlapReviewNote: recoveryCase.overlapReviewNote,
      createdAt: recoveryCase.createdAt.toISOString(),
      reportSentAt: recoveryCase.reportSentAt?.toISOString() ?? null,
      closedAt: recoveryCase.closedAt?.toISOString() ?? null,
      confirmedTotal,
      evidenceReadiness,
      evidenceCategories: evidenceCategories.map((c) => ({ code: c.code, label: c.label, isConditional: c.isConditional, sortOrder: c.sortOrder })),
      evidenceItems: recoveryCase.evidence.map((e) => ({
        categoryCode: e.categoryCode,
        reference: e.reference,
        note: e.note,
        actorName: e.actor.name,
        updatedAt: e.updatedAt.toISOString(),
      })),
      reports: recoveryCase.reports.map((r) => ({
        id: r.id,
        version: r.version,
        generatedAt: r.generatedAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
        sentVia: r.sentVia,
        content: r.content as Record<string, unknown>,
      })),
      events: recoveryCase.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        note: e.note,
        actorName: e.actor.name,
        createdAt: e.createdAt.toISOString(),
        metadata: (e.metadata as Record<string, unknown> | null) ?? null,
      })),
    },
  };
}

const linkSchema = z.object({ recoveryCaseId: z.string().uuid(), reconciliationCaseId: z.string().uuid() });

export async function linkDiscrepancyAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const actorId = await getSystemActorId();
  return prisma.$transaction((tx) => linkDiscrepancyToOpenCase(tx, { ...parsed.data, actorId }));
}

const unlinkSchema = z.object({ recoveryCaseId: z.string().uuid(), reconciliationCaseId: z.string().uuid(), note: z.string().optional() });

export async function unlinkDiscrepancyAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = unlinkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const actorId = await getSystemActorId();
  return prisma.$transaction((tx) => unlinkDiscrepancy(tx, { ...parsed.data, actorId }));
}

const evidenceSchema = z.object({
  recoveryCaseId: z.string().uuid(),
  categoryCode: z.string().min(1),
  reference: z.string().optional(),
  note: z.string().optional(),
});

export async function setEvidenceItemAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid evidence request." };
  const actorId = await getSystemActorId();
  return setEvidenceItem({ ...parsed.data, actorId });
}

const removeEvidenceSchema = z.object({ recoveryCaseId: z.string().uuid(), categoryCode: z.string().min(1) });

export async function removeEvidenceItemAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = removeEvidenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid evidence request." };
  const actorId = await getSystemActorId();
  return removeEvidenceItem({ ...parsed.data, actorId });
}

const overlapReviewSchema = z.object({ recoveryCaseId: z.string().uuid(), reviewed: z.boolean(), note: z.string() });

export async function recordOverlapReviewAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = overlapReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid overlap review request." };
  const actorId = await getSystemActorId();
  return recordOverlapReview({ ...parsed.data, actorId });
}

const generateReportSchema = z.object({ recoveryCaseId: z.string().uuid() });

export async function generateFindingsReportAction(
  input: unknown,
): Promise<{ ok: true; reportId: string; version: number } | { ok: false; message: string }> {
  const parsed = generateReportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const actorId = await getSystemActorId();
  return generateFindingsReport({ ...parsed.data, actorId });
}

const markSentSchema = z.object({ reportId: z.string().uuid(), sentVia: z.string().min(1) });

export async function markReportSentAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = markSentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "A channel/reference note is required." };
  const actorId = await getSystemActorId();
  return markReportSent({ ...parsed.data, actorId });
}

const clientResponseSchema = z.object({
  recoveryCaseId: z.string().uuid(),
  status: z.enum([ClientResponseStatus.AWAITING, ClientResponseStatus.APPROVED, ClientResponseStatus.DECLINED]),
  note: z.string().optional(),
});

export async function recordClientResponseAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = clientResponseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid client response request." };
  const actorId = await getSystemActorId();
  return recordClientResponse({ ...parsed.data, actorId });
}

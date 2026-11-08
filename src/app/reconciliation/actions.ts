"use server";

import { z } from "zod";
import { ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { classifyCase } from "@/lib/reconciliation/classify";
import { applyCancellationOverride } from "@/lib/reconciliation/apply-cancellation-override";
import { runOrderReconciliation } from "@/lib/reconciliation/run-order-reconciliation";
import { runBankReconciliation } from "@/lib/reconciliation/run-bank-reconciliation";
import type { RateAssumptions } from "@/lib/reconciliation/types";

/**
 * Phase 2 has no authentication yet (same known, documented limitation as
 * Phase 1 — see CLAUDE.md/PROJECT_STATE.md). Every run/classification is
 * attributed to the single system Actor until real auth exists.
 */
async function getSystemActorId(): Promise<string> {
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return systemActor.id;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (yyyy-MM-dd).");

// A plain, unambiguous decimal string — the same shape toMoney()/Decimal
// ultimately requires. Validated at this boundary so a malformed value
// (e.g. a stray letter) is rejected here with a clean message, rather than
// reaching Decimal parsing deep inside a reconciliation run and throwing an
// unhandled RangeError.
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "Must be a plain decimal number, e.g. 12.5 or -3.25.");
// The rate-assumption form fields arrive as "" for anything the operator
// left blank — accept that alongside a well-formed decimal; toRateAssumptions
// already treats blank/whitespace-only strings as "not provided".
const optionalDecimalString = z.union([z.literal(""), decimalString]).optional();

export async function getReconciliationContextAction(): Promise<{
  restaurants: { id: string; name: string; code: string }[];
  aggregators: { id: string; name: string; slug: string }[];
}> {
  const [restaurants, aggregators] = await Promise.all([
    prisma.restaurant.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    prisma.aggregator.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
  ]);
  return { restaurants, aggregators };
}

const periodSchema = z.object({
  restaurantId: z.string().uuid(),
  aggregatorId: z.string().uuid(),
  periodStart: isoDate,
  periodEnd: isoDate,
});

export interface RecordCounts {
  settlementCount: number;
  posCount: number;
  bankRecordCount: number;
}

export async function getRecordCountsAction(input: unknown): Promise<{ ok: true; counts: RecordCounts } | { ok: false; message: string }> {
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, or period." };
  const { restaurantId, aggregatorId, periodStart, periodEnd } = parsed.data;
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const end = new Date(`${periodEnd}T23:59:59.999Z`);
  if (start > end) return { ok: false, message: "Period start must be on or before period end." };

  const [settlementCount, posCount, bankRecordCount] = await Promise.all([
    prisma.settlementRecord.count({ where: { restaurantId, aggregatorId, date: { gte: start, lte: end } } }),
    prisma.pOSRecord.count({ where: { restaurantId, date: { gte: start, lte: end } } }),
    prisma.bankRecord.count({ where: { restaurantId, date: { gte: start, lte: end } } }),
  ]);
  return { ok: true, counts: { settlementCount, posCount, bankRecordCount } };
}

const rateAssumptionsSchema = z
  .object({
    commissionRatePercent: optionalDecimalString,
    gstRatePercent: optionalDecimalString,
    fixedFeeAmount: optionalDecimalString,
    tdsRatePercent: optionalDecimalString,
    adjustmentAmount: optionalDecimalString,
    sourceReference: z.string().optional(),
  })
  .nullable();

function toRateAssumptions(raw: z.infer<typeof rateAssumptionsSchema>): { ok: true; rates: RateAssumptions | null } | { ok: false; message: string } {
  if (!raw) return { ok: true, rates: null };
  const clean = (v?: string) => (v && v.trim().length > 0 ? v.trim() : undefined);
  const commissionRatePercent = clean(raw.commissionRatePercent);
  const gstRatePercent = clean(raw.gstRatePercent);
  const fixedFeeAmount = clean(raw.fixedFeeAmount);
  const tdsRatePercent = clean(raw.tdsRatePercent);
  const adjustmentAmount = clean(raw.adjustmentAmount);
  const sourceReference = clean(raw.sourceReference);

  const anyRateProvided = Boolean(commissionRatePercent || gstRatePercent || fixedFeeAmount || tdsRatePercent || adjustmentAmount);
  if (!anyRateProvided) return { ok: true, rates: null };
  if (!sourceReference) {
    return { ok: false, message: "A source reference is required whenever a rate assumption is provided." };
  }
  return { ok: true, rates: { commissionRatePercent, gstRatePercent, fixedFeeAmount, tdsRatePercent, adjustmentAmount, sourceReference } };
}

const runOrderSchema = periodSchema.extend({ rates: rateAssumptionsSchema });

export interface RunOrderResultView {
  matchedCount: number;
  unmatchedSettlementCount: number;
  unmatchedPosCount: number;
  ambiguousOrderRefCount: number;
  casesCreated: number;
  casesSuperseded: number;
}

export async function runOrderReconciliationAction(input: unknown): Promise<{ ok: true; result: RunOrderResultView } | { ok: false; message: string }> {
  const parsed = runOrderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, period, or rate assumptions." };
  const ratesResult = toRateAssumptions(parsed.data.rates);
  if (!ratesResult.ok) return ratesResult;

  const actorId = await getSystemActorId();
  const result = await runOrderReconciliation({
    restaurantId: parsed.data.restaurantId,
    aggregatorId: parsed.data.aggregatorId,
    periodStart: parsed.data.periodStart,
    periodEnd: parsed.data.periodEnd,
    rates: ratesResult.rates,
    actorId,
  });
  return { ok: true, result };
}

export interface BankRecordOption {
  id: string;
  amount: string;
  date: string;
}

export async function listBankRecordsAction(input: unknown): Promise<{ ok: true; records: BankRecordOption[] } | { ok: false; message: string }> {
  const schema = z.object({ restaurantId: z.string().uuid(), periodStart: isoDate, periodEnd: isoDate });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant or period." };
  const start = new Date(`${parsed.data.periodStart}T00:00:00.000Z`);
  const end = new Date(`${parsed.data.periodEnd}T23:59:59.999Z`);

  const records = await prisma.bankRecord.findMany({
    where: { restaurantId: parsed.data.restaurantId, date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });
  return { ok: true, records: records.map((r) => ({ id: r.id, amount: r.amount.toString(), date: r.date.toISOString() })) };
}

const runBankSchema = periodSchema.extend({ bankRecordId: z.string().uuid() });

export interface RunBankResultView {
  caseCreated: boolean;
  caseSuperseded: boolean;
  settlementRecordCount: number;
}

export async function runBankReconciliationAction(input: unknown): Promise<{ ok: true; result: RunBankResultView } | { ok: false; message: string }> {
  const parsed = runBankSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, period, or bank record." };
  const actorId = await getSystemActorId();
  const result = await runBankReconciliation({
    restaurantId: parsed.data.restaurantId,
    aggregatorId: parsed.data.aggregatorId,
    periodStart: parsed.data.periodStart,
    periodEnd: parsed.data.periodEnd,
    bankRecordId: parsed.data.bankRecordId,
    actorId,
  });
  return { ok: true, result };
}

export interface ReconciliationCaseSummary {
  id: string;
  scope: ReconciliationScope;
  orderRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  expectedAmount: string | null;
  actualAmount: string | null;
  difference: string | null;
  calculationStatus: string;
  status: ClassificationStatus;
  cancellationOverrideApplied: boolean;
  createdAt: string;
}

const listCasesSchema = z.object({
  restaurantId: z.string().uuid(),
  aggregatorId: z.string().uuid(),
  scope: z.enum([ReconciliationScope.ORDER_LEVEL, ReconciliationScope.BANK_CYCLE]),
});

export async function listCasesAction(input: unknown): Promise<{ ok: true; cases: ReconciliationCaseSummary[] } | { ok: false; message: string }> {
  const parsed = listCasesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid restaurant, aggregator, or scope." };

  const cases = await prisma.reconciliationCase.findMany({
    where: {
      restaurantId: parsed.data.restaurantId,
      aggregatorId: parsed.data.aggregatorId,
      scope: parsed.data.scope,
      isSuperseded: false,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return {
    ok: true,
    cases: cases.map((c) => ({
      id: c.id,
      scope: c.scope,
      orderRef: c.orderRef,
      periodStart: c.periodStart?.toISOString() ?? null,
      periodEnd: c.periodEnd?.toISOString() ?? null,
      expectedAmount: c.expectedAmount?.toString() ?? null,
      actualAmount: c.actualAmount?.toString() ?? null,
      difference: c.difference?.toString() ?? null,
      calculationStatus: c.calculationStatus,
      status: c.status,
      cancellationOverrideApplied: c.cancellationOverrideApplied,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

export interface ReconciliationCaseDetail extends ReconciliationCaseSummary {
  restaurantId: string;
  aggregatorId: string;
  calculationFormulaVersion: string;
  calculationBreakdown: Record<string, unknown>;
  supersedesCaseId: string | null;
  isSuperseded: boolean;
  linkedSettlements: { id: string; amount: string; orderRef: string | null; date: string }[];
  linkedPos: { id: string; amount: string; orderRef: string | null; date: string }[];
  linkedBank: { id: string; amount: string; date: string }[];
  evidence: { id: string; kind: string; description: string; value: string | null; sourceReference: string | null; verified: boolean; createdAt: string }[];
  classificationHistory: { id: string; fromStatus: ClassificationStatus | null; toStatus: ClassificationStatus; rationale: string; actorName: string; createdAt: string }[];
}

export async function getCaseDetailAction(input: unknown): Promise<{ ok: true; detail: ReconciliationCaseDetail } | { ok: false; message: string }> {
  const parsed = z.object({ caseId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid case id." };

  const reconCase = await prisma.reconciliationCase.findUnique({
    where: { id: parsed.data.caseId },
    include: {
      recordLinks: { include: { settlementRecord: true, posRecord: true, bankRecord: true } },
      evidence: { orderBy: { createdAt: "asc" } },
      classificationEvents: { orderBy: { createdAt: "asc" }, include: { actor: true } },
    },
  });
  if (!reconCase) return { ok: false, message: "Case not found." };

  const linkedSettlements = reconCase.recordLinks
    .map((l) => l.settlementRecord)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({ id: r.id, amount: r.amount.toString(), orderRef: r.orderRef, date: r.date.toISOString() }));
  const linkedPos = reconCase.recordLinks
    .map((l) => l.posRecord)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({ id: r.id, amount: r.amount.toString(), orderRef: r.orderRef, date: r.date.toISOString() }));
  const linkedBank = reconCase.recordLinks
    .map((l) => l.bankRecord)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({ id: r.id, amount: r.amount.toString(), date: r.date.toISOString() }));

  return {
    ok: true,
    detail: {
      id: reconCase.id,
      restaurantId: reconCase.restaurantId,
      aggregatorId: reconCase.aggregatorId,
      scope: reconCase.scope,
      orderRef: reconCase.orderRef,
      periodStart: reconCase.periodStart?.toISOString() ?? null,
      periodEnd: reconCase.periodEnd?.toISOString() ?? null,
      expectedAmount: reconCase.expectedAmount?.toString() ?? null,
      actualAmount: reconCase.actualAmount?.toString() ?? null,
      difference: reconCase.difference?.toString() ?? null,
      calculationStatus: reconCase.calculationStatus,
      calculationFormulaVersion: reconCase.calculationFormulaVersion,
      calculationBreakdown: reconCase.calculationBreakdown as Record<string, unknown>,
      status: reconCase.status,
      cancellationOverrideApplied: reconCase.cancellationOverrideApplied,
      supersedesCaseId: reconCase.supersedesCaseId,
      isSuperseded: reconCase.isSuperseded,
      createdAt: reconCase.createdAt.toISOString(),
      linkedSettlements,
      linkedPos,
      linkedBank,
      evidence: reconCase.evidence.map((e) => ({
        id: e.id,
        kind: e.kind,
        description: e.description,
        value: e.value?.toString() ?? null,
        sourceReference: e.sourceReference,
        verified: e.verified,
        createdAt: e.createdAt.toISOString(),
      })),
      classificationHistory: reconCase.classificationEvents.map((ev) => ({
        id: ev.id,
        fromStatus: ev.fromStatus,
        toStatus: ev.toStatus,
        rationale: ev.rationale,
        actorName: ev.actor.name,
        createdAt: ev.createdAt.toISOString(),
      })),
    },
  };
}

const classifySchema = z.object({
  caseId: z.string().uuid(),
  toStatus: z.enum([
    ClassificationStatus.VALID_DEDUCTION,
    ClassificationStatus.TIMING_DIFFERENCE,
    ClassificationStatus.MISSING_DATA_UNMATCHED_ORDER,
    ClassificationStatus.COMMERCIAL_RULE_DIFFERENCE,
    ClassificationStatus.CONFIRMED_DISCREPANCY,
    ClassificationStatus.REQUIRES_HUMAN_REVIEW,
  ]),
  rationale: z.string(),
  confirmedEvidenceReviewed: z.boolean().optional(),
  confirmedSupportable: z.boolean().optional(),
});

export async function classifyCaseAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = classifySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid classification request." };
  const actorId = await getSystemActorId();
  const result = await classifyCase({ ...parsed.data, actorId });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true };
}

const cancellationOverrideSchema = z.object({
  caseId: z.string().uuid(),
  cancellationFeeAmount: decimalString,
  sourceReference: z.string().min(1),
});

export async function applyCancellationOverrideAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = cancellationOverrideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid cancellation override request." };
  const actorId = await getSystemActorId();
  const result = await applyCancellationOverride({ ...parsed.data, actorId });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true };
}

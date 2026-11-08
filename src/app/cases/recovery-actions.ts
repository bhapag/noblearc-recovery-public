"use server";

import { z } from "zod";
import { RecoveryMethod } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { subtractMoney, sumMoney, toMoney } from "@/lib/money";
import { createRecoveryEvent } from "@/lib/recovery-events/create-event";
import { voidRecoveryEvent } from "@/lib/recovery-events/void-event";
import { declareRecoveryClosedPartial } from "@/lib/recovery-events/close-partial";
import { computeRecoveryPosition } from "@/lib/recovery-events/position";
import type { RecoveryEventDetail, RecoveryPositionResult } from "@/lib/recovery-events/types";

/** Same known, documented no-authentication limitation as Phase 1-4. */
async function getSystemActorId(): Promise<string> {
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return systemActor.id;
}

const METHOD_VALUES = [RecoveryMethod.DIRECT_BANK_CREDIT, RecoveryMethod.FUTURE_SETTLEMENT_OFFSET, RecoveryMethod.OTHER_EVIDENCED_METHOD] as const;
const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

export interface BankRecordOption {
  id: string;
  date: string;
  amount: string;
  reference: string | null;
  alreadyClaimed: boolean;
}

export async function searchBankRecordsAction(input: unknown): Promise<{ ok: true; options: BankRecordOption[] } | { ok: false; message: string }> {
  const parsed = z.object({ restaurantId: z.string().uuid(), query: z.string().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid search request." };

  const records = await prisma.bankRecord.findMany({
    where: {
      restaurantId: parsed.data.restaurantId,
      ...(parsed.data.query ? { reference: { contains: parsed.data.query, mode: "insensitive" } } : {}),
    },
    include: { recoveryEvents: { where: { status: "ACTIVE" }, select: { id: true } } },
    orderBy: { date: "desc" },
    take: 50,
  });

  return {
    ok: true,
    options: records.map((r) => ({
      id: r.id,
      date: r.date.toISOString(),
      amount: r.amount.toString(),
      reference: r.reference,
      alreadyClaimed: r.recoveryEvents.length > 0,
    })),
  };
}

export interface SettlementRecordOption {
  id: string;
  date: string;
  amount: string;
  orderRef: string | null;
  alreadyClaimed: boolean;
}

export async function searchSettlementRecordsAction(input: unknown): Promise<{ ok: true; options: SettlementRecordOption[] } | { ok: false; message: string }> {
  const parsed = z.object({ restaurantId: z.string().uuid(), aggregatorId: z.string().uuid(), query: z.string().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid search request." };

  const records = await prisma.settlementRecord.findMany({
    where: {
      restaurantId: parsed.data.restaurantId,
      aggregatorId: parsed.data.aggregatorId,
      ...(parsed.data.query ? { orderRef: { contains: parsed.data.query, mode: "insensitive" } } : {}),
    },
    include: { recoveryEvents: { where: { status: "ACTIVE" }, select: { id: true } } },
    orderBy: { date: "desc" },
    take: 50,
  });

  return {
    ok: true,
    options: records.map((r) => ({
      id: r.id,
      date: r.date.toISOString(),
      amount: r.amount.toString(),
      orderRef: r.orderRef,
      alreadyClaimed: r.recoveryEvents.length > 0,
    })),
  };
}

const allocationSchema = z.object({ reconciliationCaseId: z.string().uuid(), allocatedAmount: z.string().regex(DECIMAL_STRING_RE, "Must be a plain decimal number.") });

const createRecoveryEventSchema = z.object({
  recoveryCaseId: z.string().uuid(),
  method: z.enum(METHOD_VALUES),
  amount: z.string().regex(DECIMAL_STRING_RE, "Amount must be a plain decimal number."),
  occurredAt: z.string(),
  evidenceReference: z.string().min(1),
  operatorNote: z.string().optional(),
  bankRecordId: z.string().uuid().optional(),
  settlementRecordId: z.string().uuid().optional(),
  supersedesEventId: z.string().uuid().optional(),
  verifiedAt: z.string(),
  allocations: z.array(allocationSchema).min(1),
});

export async function createRecoveryEventAction(input: unknown): Promise<{ ok: true; recoveryEventId: string } | { ok: false; message: string }> {
  const parsed = createRecoveryEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid recovery event request." };
  const occurredAt = new Date(parsed.data.occurredAt);
  const verifiedAt = new Date(parsed.data.verifiedAt);
  if (Number.isNaN(occurredAt.getTime()) || Number.isNaN(verifiedAt.getTime())) {
    return { ok: false, message: "Invalid date." };
  }

  const actorId = await getSystemActorId();
  return createRecoveryEvent({ ...parsed.data, occurredAt, verifiedAt, actorId });
}

const voidRecoveryEventSchema = z.object({ recoveryEventId: z.string().uuid(), voidReason: z.string().min(1) });

export async function voidRecoveryEventAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = voidRecoveryEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid void request." };
  const actorId = await getSystemActorId();
  return voidRecoveryEvent({ ...parsed.data, actorId });
}

const closePartialSchema = z.object({ recoveryCaseId: z.string().uuid(), note: z.string().min(1) });

export async function declareRecoveryClosedPartialAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = closePartialSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const actorId = await getSystemActorId();
  return declareRecoveryClosedPartial({ ...parsed.data, actorId });
}

export interface RecoverySectionView {
  position: RecoveryPositionResult;
  events: RecoveryEventDetail[];
  eligibleForNewRecovery: boolean;
  ineligibleReason: string | null;
}

export async function getRecoveryPositionAction(input: unknown): Promise<{ ok: true; view: RecoverySectionView } | { ok: false; message: string }> {
  const parsed = z.object({ recoveryCaseId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid case id." };

  const recoveryCase = await prisma.recoveryCase.findUnique({ where: { id: parsed.data.recoveryCaseId } });
  if (!recoveryCase) return { ok: false, message: "Recovery case not found." };

  const position = await computeRecoveryPosition(parsed.data.recoveryCaseId);

  const events = await prisma.recoveryEvent.findMany({
    where: { recoveryCaseId: parsed.data.recoveryCaseId },
    orderBy: { createdAt: "desc" },
    include: {
      verifiedByActor: true,
      voidedByActor: true,
      bankRecord: true,
      settlementRecord: true,
      supersededBy: true,
      allocations: { include: { reconciliationCase: true } },
    },
  });

  const eventDetails: RecoveryEventDetail[] = events.map((e) => {
    const allocatedTotal = sumMoney(e.allocations.map((a) => toMoney(a.allocatedAmount.toString())));
    return {
      id: e.id,
      method: e.method,
      amount: e.amount.toString(),
      occurredAt: e.occurredAt.toISOString(),
      evidenceReference: e.evidenceReference,
      operatorNote: e.operatorNote,
      verifiedByActorName: e.verifiedByActor.name,
      verifiedAt: e.verifiedAt.toISOString(),
      status: e.status,
      bankRecordId: e.bankRecordId,
      bankRecordSummary: e.bankRecord ? `${e.bankRecord.date.toISOString().slice(0, 10)} — ${e.bankRecord.amount.toString()}${e.bankRecord.reference ? ` (${e.bankRecord.reference})` : ""}` : null,
      settlementRecordId: e.settlementRecordId,
      settlementRecordSummary: e.settlementRecord ? `${e.settlementRecord.date.toISOString().slice(0, 10)} — ${e.settlementRecord.amount.toString()}${e.settlementRecord.orderRef ? ` (${e.settlementRecord.orderRef})` : ""}` : null,
      supersedesEventId: e.supersedesEventId,
      supersededByEventId: e.supersededBy?.id ?? null,
      voidedAt: e.voidedAt?.toISOString() ?? null,
      voidedByActorName: e.voidedByActor?.name ?? null,
      voidReason: e.voidReason,
      allocations: e.allocations.map((a) => ({
        reconciliationCaseId: a.reconciliationCaseId,
        orderRef: a.reconciliationCase.orderRef,
        allocatedAmount: a.allocatedAmount.toString(),
      })),
      allocatedTotal: allocatedTotal.toFixed(2),
      unallocatedRemainder: subtractMoney(toMoney(e.amount.toString()), allocatedTotal).toFixed(2),
      createdAt: e.createdAt.toISOString(),
    };
  });

  let ineligibleReason: string | null = null;
  if (recoveryCase.status !== "AWAITING_RECOVERY" && recoveryCase.status !== "PARTIALLY_RECOVERED") {
    ineligibleReason =
      recoveryCase.status === "RECOVERY_VERIFIED"
        ? "This case's confirmed amount has been fully verified recovered."
        : recoveryCase.status === "RECOVERY_CLOSED_PARTIAL"
          ? "This case has been closed as partial — no further recovery is expected. Void a recovery event to reopen it."
          : "This case is not currently eligible for recovery recording.";
  }

  return {
    ok: true,
    view: { position, events: eventDetails, eligibleForNewRecovery: ineligibleReason === null, ineligibleReason },
  };
}

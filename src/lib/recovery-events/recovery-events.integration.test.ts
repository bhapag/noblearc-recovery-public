// Integration tests against the real Postgres database (DATABASE_URL).
// Every row created here is deleted in an afterEach block, verified with a
// zero-residue check at the end of the suite. All fixtures are clearly
// synthetic — never real client data, and this suite is a synthetic
// regression, never a claim of real aggregator/bank validation.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ClassificationStatus,
  ClientResponseStatus,
  DisputeOutcome,
  ReconciliationScope,
  RecoveryCaseStatus,
  RecoveryEventStatus,
  RecoveryMethod,
  SubmissionChannel,
} from "@/generated/prisma/enums";
import type { Aggregator, Actor } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { roundMoney, sumMoney, toMoney } from "@/lib/money";
import { createRecoveryCase } from "@/lib/recovery/create-recovery-case";
import { generateFindingsReport, markReportSent } from "@/lib/recovery/findings-report";
import { recordClientResponse } from "@/lib/recovery/client-response";
import { createDisputeSubmission } from "@/lib/dispute/create-submission";
import { recordDisposition } from "@/lib/dispute/disposition";
import { createRecoveryEvent } from "./create-event";
import { voidRecoveryEvent } from "./void-event";
import { declareRecoveryClosedPartial } from "./close-partial";
import { computeRecoveryPosition } from "./position";
import { normalizeEvidenceReference } from "./normalize";

// Live-Neon latency budget for this file only — NOT a product-logic workaround
// and NOT a global default. Every test here drives the full Phase 3→4→5 fixture
// chain (recovery case → evidence pack → findings report → send → client
// approval → dispute submission → disposition) before its own assertions run,
// which measures at 15-18s per test against pooled Neon from this region — i.e.
// most of the project-wide 15s default, with no headroom for ordinary jitter.
// Scoped here with vi.setConfig so ordinary/unit tests keep the unchanged
// project default. See CLAUDE.md for the full rationale.
vi.setConfig({ testTimeout: 45_000 });

const createdRestaurantIds: string[] = [];
function trackRestaurant(id: string): string {
  createdRestaurantIds.push(id);
  return id;
}

afterEach(async () => {
  if (createdRestaurantIds.length === 0) return;
  const ids = [...createdRestaurantIds];
  createdRestaurantIds.length = 0;

  const recoveryCases = await prisma.recoveryCase.findMany({ where: { restaurantId: { in: ids } }, select: { id: true } });
  const recoveryCaseIds = recoveryCases.map((r) => r.id);

  if (recoveryCaseIds.length > 0) {
    const events = await prisma.recoveryEvent.findMany({ where: { recoveryCaseId: { in: recoveryCaseIds } }, select: { id: true } });
    const eventIds = events.map((e) => e.id);
    if (eventIds.length > 0) {
      await prisma.recoveryAllocation.deleteMany({ where: { recoveryEventId: { in: eventIds } } });
      await prisma.recoveryEvent.updateMany({ where: { id: { in: eventIds } }, data: { supersedesEventId: null } });
      await prisma.recoveryEvent.deleteMany({ where: { id: { in: eventIds } } });
    }

    const submissions = await prisma.disputeSubmission.findMany({ where: { recoveryCaseId: { in: recoveryCaseIds } }, select: { id: true } });
    const submissionIds = submissions.map((s) => s.id);
    if (submissionIds.length > 0) {
      await prisma.disputeDisposition.deleteMany({ where: { disputeSubmissionId: { in: submissionIds } } });
      await prisma.followUpEntry.deleteMany({ where: { disputeSubmissionId: { in: submissionIds } } });
      await prisma.disputeSubmission.deleteMany({ where: { id: { in: submissionIds } } });
    }
  }

  await prisma.recoveryCase.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.reconciliationCase.updateMany({ where: { restaurantId: { in: ids } }, data: { supersedesCaseId: null } });
  await prisma.reconciliationCase.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.settlementRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.bankRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.restaurant.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  const residualCount = await prisma.restaurant.count({ where: { code: { startsWith: "TEST__P5_" } } });
  expect(residualCount).toBe(0);
});

let restaurantCounter = 0;
async function createTestRestaurant() {
  restaurantCounter += 1;
  return prisma.restaurant.create({
    data: {
      name: `TEST__Phase5 Fixture ${restaurantCounter}`,
      code: `TEST__P5_${Date.now()}_${restaurantCounter}_${Math.random().toString(36).slice(2, 8)}`,
      notes: "Synthetic fixture for automated Phase 5 integration tests only — not a real client.",
    },
  });
}

interface Fixtures {
  swiggy: Aggregator;
  zomato: Aggregator;
  systemActor: Actor;
}
async function getFixtures(): Promise<Fixtures> {
  const [swiggy, zomato, systemActor] = await Promise.all([
    prisma.aggregator.findUniqueOrThrow({ where: { slug: "swiggy" } }),
    prisma.aggregator.findUniqueOrThrow({ where: { slug: "zomato" } }),
    prisma.actor.findFirstOrThrow({ where: { isSystem: true } }),
  ]);
  return { swiggy, zomato, systemActor };
}

function sumAllocations(rows: { allocatedAmount: { toString(): string } }[]): string {
  return sumMoney(rows.map((r) => toMoney(r.allocatedAmount.toString()))).toFixed(2);
}

function amountTriple(amount: string): { expectedAmount: string; actualAmount: string; difference: string } {
  return { expectedAmount: "1000.00", actualAmount: (1000 - Number(amount)).toFixed(2), difference: amount };
}

async function createConfirmedOrderCase(restaurantId: string, aggregatorId: string, actorId: string, orderRef: string, amount: string) {
  const { expectedAmount, actualAmount, difference } = amountTriple(amount);
  return prisma.reconciliationCase.create({
    data: {
      restaurantId,
      aggregatorId,
      scope: ReconciliationScope.ORDER_LEVEL,
      orderRef,
      expectedAmount,
      actualAmount,
      difference,
      calculationStatus: "CALCULATED",
      calculationFormulaVersion: "v1",
      calculationBreakdown: {},
      status: ClassificationStatus.CONFIRMED_DISCREPANCY,
      createdByActorId: actorId,
    },
  });
}

/**
 * Builds a RecoveryCase all the way to AWAITING_RECOVERY — the exact Phase 5
 * starting point. `existingRestaurantId` reuses an already-created restaurant so
 * two recovery cases can share one restaurant/aggregator: the duplicate-source
 * tests below need their second attempt to be valid in every respect EXCEPT the
 * duplicate, so that the ownership check can never be what does the rejecting.
 */
async function createAwaitingRecoveryCase(
  aggregator: Aggregator,
  systemActor: Actor,
  items: { orderRef: string; amount: string }[],
  outcome: DisputeOutcome = DisputeOutcome.ACCEPTED,
  aggregatorStatedAmount?: string,
  existingRestaurantId?: string,
  existingReconciliationCaseIds?: string[],
): Promise<{ recoveryCaseId: string; restaurantId: string; reconciliationCaseIds: string[] }> {
  const restaurant = existingRestaurantId ?? trackRestaurant((await createTestRestaurant()).id);
  const orderIds =
    existingReconciliationCaseIds ??
    (await Promise.all(items.map((i) => createConfirmedOrderCase(restaurant, aggregator.id, systemActor.id, i.orderRef, i.amount)))).map((o) => o.id);
  const created = await createRecoveryCase({
    restaurantId: restaurant,
    aggregatorId: aggregator.id,
    reconciliationCaseIds: orderIds,
    actorId: systemActor.id,
  });
  if (!created.ok) throw new Error(`fixture setup failed: ${created.message}`);
  const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
  if (!report.ok) throw new Error(`fixture setup failed: ${report.message}`);
  await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
  const response = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.APPROVED });
  if (!response.ok) throw new Error(`fixture setup failed: ${response.message}`);
  const submitted = await createDisputeSubmission({ recoveryCaseId: created.recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
  if (!submitted.ok) throw new Error(`fixture setup failed: ${submitted.message}`);
  const disposition = await recordDisposition({
    disputeSubmissionId: submitted.disputeSubmissionId,
    outcome,
    decidedAt: new Date(),
    evidenceNote: "Fixture disposition for Phase 5 testing.",
    aggregatorStatedAmount,
    actorId: systemActor.id,
  });
  if (!disposition.ok) throw new Error(`fixture setup failed: ${disposition.message}`);
  return { recoveryCaseId: created.recoveryCaseId, restaurantId: restaurant, reconciliationCaseIds: orderIds };
}

async function createBankRecord(restaurantId: string, amount: string, reference = "BANK-REF") {
  return prisma.bankRecord.create({ data: { restaurantId, date: new Date(), amount, reference } });
}
async function createSettlementRecord(restaurantId: string, aggregatorId: string, amount: string, orderRef = "SETTLE-REF") {
  return prisma.settlementRecord.create({ data: { restaurantId, aggregatorId, date: new Date(), amount, orderRef } });
}

describe("A. zero recovery", () => {
  it("leaves Verified Recovered at zero and Outstanding unchanged when no recovery event exists", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-A", amount: "100.00" }]);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("0.00");
    expect(position.totalOutstanding).toBe("100.00");
    expect(position.derivedStatus).toBe(RecoveryCaseStatus.AWAITING_RECOVERY);

    const updated = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updated.status).toBe(RecoveryCaseStatus.AWAITING_RECOVERY);
  });
});

describe("B/C/D. full, partial, and multiple partial recoveries", () => {
  it("moves to Partially Recovered on a partial allocation, then to Recovery Verified once fully allocated", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-BCD", amount: "100.00" }]);

    const first = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "40.00",
      occurredAt: new Date(),
      evidenceReference: "First partial payment confirmation",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "40.00" }],
    });
    expect(first.ok).toBe(true);

    const afterFirst = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(afterFirst.status).toBe(RecoveryCaseStatus.PARTIALLY_RECOVERED);
    const positionAfterFirst = await computeRecoveryPosition(recoveryCaseId);
    expect(positionAfterFirst.totalVerifiedRecovered).toBe("40.00");
    expect(positionAfterFirst.totalOutstanding).toBe("60.00");

    const second = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "60.00",
      occurredAt: new Date(),
      evidenceReference: "Second and final payment confirmation",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "60.00" }],
    });
    expect(second.ok).toBe(true);

    const afterSecond = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(afterSecond.status).toBe(RecoveryCaseStatus.RECOVERY_VERIFIED);
    const positionAfterSecond = await computeRecoveryPosition(recoveryCaseId);
    expect(positionAfterSecond.totalVerifiedRecovered).toBe("100.00");
    expect(positionAfterSecond.totalOutstanding).toBe("0.00");
  });
});

describe("E. direct bank credit", () => {
  it("records recovery against an imported BankRecord", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, restaurantId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-E", amount: "100.00" }]);
    const bankRecord = await createBankRecord(restaurantId, "100.00");

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.DIRECT_BANK_CREDIT,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Matched to imported bank record",
      bankRecordId: bankRecord.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const event = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: result.recoveryEventId } });
    expect(event.bankRecordId).toBe(bankRecord.id);
  });
});

describe("F/G. future settlement offset safety", () => {
  it("F: accepts a future settlement offset backed by an actual proving settlement record", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, restaurantId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-F", amount: "100.00" }]);
    const settlement = await createSettlementRecord(restaurantId, swiggy.id, "100.00");

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.FUTURE_SETTLEMENT_OFFSET,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Adjustment appeared in the following cycle's settlement",
      settlementRecordId: settlement.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(result.ok).toBe(true);
  });

  it("G: rejects a future settlement offset with only a promise/evidence-reference and no proving settlement record", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-G", amount: "100.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.FUTURE_SETTLEMENT_OFFSET,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Aggregator support said it will be adjusted next cycle",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("H. other evidenced method fallback", () => {
  it("accepts Other Evidenced Method with no imported record, evidence reference as sole provenance", async () => {
    const { zomato, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(zomato, systemActor, [{ orderRef: "P5-H", amount: "50.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: "Credit note applied against next invoice, confirmed via email attachment",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "50.00" }],
    });
    expect(result.ok).toBe(true);
  });
});

describe("I/J. hard allocation cap and over-credit", () => {
  it("I: rejects an allocation exceeding the confirmed discrepancy amount, with no override", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-I", amount: "100.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "150.00",
      occurredAt: new Date(),
      evidenceReference: "Attempted over-allocation",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "150.00" }],
    });
    expect(result.ok).toBe(false);
  });

  it("J: caps allocation at the confirmed amount and derives the remainder as unallocated, never recovered", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-J", amount: "100.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "105.00",
      occurredAt: new Date(),
      evidenceReference: "Bank credit of 105 against a 100 confirmed discrepancy",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const event = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: result.recoveryEventId }, include: { allocations: true } });
    expect(event.allocations).toHaveLength(1);
    expect(event.allocations[0].allocatedAmount.toString()).toBe("100");

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalOutstanding).toBe("0.00");
    expect(position.totalVerifiedRecovered).toBe("100.00");
    expect(position.derivedStatus).toBe(RecoveryCaseStatus.RECOVERY_VERIFIED);
  });
});

describe("K. multiple discrepancy allocation", () => {
  it("splits one recovery event's allocation across two linked reconciliation cases", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [
      { orderRef: "P5-K1", amount: "60.00" },
      { orderRef: "P5-K2", amount: "40.00" },
    ]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Single payment covering both discrepancies",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [
        { reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "60.00" },
        { reconciliationCaseId: reconciliationCaseIds[1], allocatedAmount: "40.00" },
      ],
    });
    expect(result.ok).toBe(true);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("100.00");
    expect(position.totalOutstanding).toBe("0.00");
    expect(position.derivedStatus).toBe(RecoveryCaseStatus.RECOVERY_VERIFIED);
  });
});

describe("L/M/N. duplicate prevention", () => {
  it("L: rejects a second active recovery event claiming the same BankRecord", async () => {
    const { swiggy, systemActor } = await getFixtures();
    // Both recovery cases deliberately share ONE restaurant and aggregator, so
    // the second attempt is valid in every respect except the duplicate bank
    // record — the restaurant/aggregator ownership check can never be what
    // rejects it, which is what makes this a real proof of the invariant.
    const { recoveryCaseId: caseA, restaurantId, reconciliationCaseIds: idsA } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-L-A", amount: "50.00" }]);
    const { recoveryCaseId: caseB, reconciliationCaseIds: idsB } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [{ orderRef: "P5-L-B", amount: "50.00" }],
      DisputeOutcome.ACCEPTED,
      undefined,
      restaurantId,
    );
    const bankRecord = await createBankRecord(restaurantId, "50.00");

    const first = await createRecoveryEvent({
      recoveryCaseId: caseA,
      method: RecoveryMethod.DIRECT_BANK_CREDIT,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: "First claim",
      bankRecordId: bankRecord.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsA[0], allocatedAmount: "50.00" }],
    });
    expect(first.ok).toBe(true);

    const second = await createRecoveryEvent({
      recoveryCaseId: caseB,
      method: RecoveryMethod.DIRECT_BANK_CREDIT,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: "Second claim on the same bank record",
      bankRecordId: bankRecord.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsB[0], allocatedAmount: "50.00" }],
    });
    expect(second.ok).toBe(false);
    // The rejection must be the duplicate-provenance one specifically.
    if (!second.ok) expect(second.message).toBe("This bank record is already claimed by another active recovery event.");
  });

  it("M: rejects a second active recovery event claiming the same SettlementRecord", async () => {
    const { swiggy, systemActor } = await getFixtures();
    // Same shared-restaurant construction as L, for the same reason.
    const { recoveryCaseId: caseA, restaurantId, reconciliationCaseIds: idsA } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-M-A", amount: "50.00" }]);
    const { recoveryCaseId: caseB, reconciliationCaseIds: idsB } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [{ orderRef: "P5-M-B", amount: "50.00" }],
      DisputeOutcome.ACCEPTED,
      undefined,
      restaurantId,
    );
    const settlement = await createSettlementRecord(restaurantId, swiggy.id, "50.00");

    const first = await createRecoveryEvent({
      recoveryCaseId: caseA,
      method: RecoveryMethod.FUTURE_SETTLEMENT_OFFSET,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: "First claim",
      settlementRecordId: settlement.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsA[0], allocatedAmount: "50.00" }],
    });
    expect(first.ok).toBe(true);

    const second = await createRecoveryEvent({
      recoveryCaseId: caseB,
      method: RecoveryMethod.FUTURE_SETTLEMENT_OFFSET,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: "Second claim on the same settlement record",
      settlementRecordId: settlement.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsB[0], allocatedAmount: "50.00" }],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toBe("This settlement record is already claimed by another active recovery event.");
  });

  it("N: rejects a second active recovery event with the same method and normalized evidence reference", async () => {
    const { swiggy, systemActor } = await getFixtures();
    // Same shared-restaurant construction as L/M, so the ONLY thing that can
    // reject the second attempt is the duplicate normalized evidence reference.
    const { recoveryCaseId: caseA, restaurantId, reconciliationCaseIds: idsA } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-N-A", amount: "50.00" }]);
    const { recoveryCaseId: caseB, reconciliationCaseIds: idsB } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [{ orderRef: "P5-N-B", amount: "50.00" }],
      DisputeOutcome.ACCEPTED,
      undefined,
      restaurantId,
    );
    const reference = `UNIQUE-REF-${Date.now()}`;

    const first = await createRecoveryEvent({
      recoveryCaseId: caseA,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: reference,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsA[0], allocatedAmount: "50.00" }],
    });
    expect(first.ok).toBe(true);

    const second = await createRecoveryEvent({
      recoveryCaseId: caseB,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: `  ${reference.toLowerCase()}  `,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: idsB[0], allocatedAmount: "50.00" }],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toBe("An active recovery event already exists with this same method and evidence reference.");
    expect(normalizeEvidenceReference(reference)).toBe(normalizeEvidenceReference(`  ${reference.toLowerCase()}  `));
  });
});

describe("O/P. concurrency", () => {
  it("O: serializes two concurrent attempts to claim the same bank record so only one succeeds", async () => {
    const { swiggy, systemActor } = await getFixtures();
    // Shared restaurant/aggregator, as in L/M/N: both racers are otherwise
    // valid, so the loser can only be rejected by duplicate-source prevention
    // (either the service-layer check or its partial-unique-index backstop).
    const { recoveryCaseId: caseA, restaurantId, reconciliationCaseIds: idsA } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-O-A", amount: "50.00" }]);
    const { recoveryCaseId: caseB, reconciliationCaseIds: idsB } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [{ orderRef: "P5-O-B", amount: "50.00" }],
      DisputeOutcome.ACCEPTED,
      undefined,
      restaurantId,
    );
    const bankRecord = await createBankRecord(restaurantId, "50.00");

    const [a, b] = await Promise.all([
      createRecoveryEvent({
        recoveryCaseId: caseA,
        method: RecoveryMethod.DIRECT_BANK_CREDIT,
        amount: "50.00",
        occurredAt: new Date(),
        evidenceReference: "Race attempt A",
        bankRecordId: bankRecord.id,
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId: idsA[0], allocatedAmount: "50.00" }],
      }),
      createRecoveryEvent({
        recoveryCaseId: caseB,
        method: RecoveryMethod.DIRECT_BANK_CREDIT,
        amount: "50.00",
        occurredAt: new Date(),
        evidenceReference: "Race attempt B",
        bankRecordId: bankRecord.id,
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId: idsB[0], allocatedAmount: "50.00" }],
      }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    // The loser must have been stopped by duplicate-source prevention itself —
    // either the service-layer check or its partial-unique-index backstop.
    const loser = [a, b].find((r) => !r.ok);
    expect(loser).toBeDefined();
    if (loser && !loser.ok) {
      expect([
        "This bank record is already claimed by another active recovery event.",
        "This bank record, settlement record, or evidence reference is already claimed by another active recovery event.",
      ]).toContain(loser.message);
    }

    const activeCount = await prisma.recoveryEvent.count({ where: { bankRecordId: bankRecord.id, status: RecoveryEventStatus.ACTIVE } });
    expect(activeCount).toBe(1);
  });

  it("P: serializes two concurrent allocations against the same reconciliation case so the cap is never exceeded", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-P", amount: "100.00" }]);

    const [a, b] = await Promise.all([
      createRecoveryEvent({
        recoveryCaseId,
        method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
        amount: "70.00",
        occurredAt: new Date(),
        evidenceReference: "Race allocation A",
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "70.00" }],
      }),
      createRecoveryEvent({
        recoveryCaseId,
        method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
        amount: "70.00",
        occurredAt: new Date(),
        evidenceReference: "Race allocation B",
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "70.00" }],
      }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("70.00");
    expect(position.totalOutstanding).toBe("30.00");
  });

  it("serializes two concurrent void attempts on the same event so only the first's reason/actor survives", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-VOID-RACE", amount: "100.00" }]);
    const created = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Event targeted by a concurrent double-void",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    if (!created.ok) throw new Error(created.message);

    const [a, b] = await Promise.all([
      voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "First void reason.", actorId: systemActor.id }),
      voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "Second, conflicting void reason.", actorId: systemActor.id }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    const eventRow = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: created.recoveryEventId } });
    expect(eventRow.status).toBe(RecoveryEventStatus.VOIDED);
    expect(["First void reason.", "Second, conflicting void reason."]).toContain(eventRow.voidReason);

    const voidedEvents = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId, kind: "RECOVERY_VOIDED" } });
    expect(voidedEvents).toHaveLength(1);
  });
});

describe("Q/R/S/T/U. void, correction, and status reopening", () => {
  it("R: voiding an event excludes its allocations and reopens the case status", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-R", amount: "100.00" }]);
    const created = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "To be voided",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    if (!created.ok) throw new Error(created.message);

    const rejected = await voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "", actorId: systemActor.id });
    expect(rejected.ok).toBe(false);

    const voided = await voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "Recorded in error — duplicate entry.", actorId: systemActor.id });
    expect(voided.ok).toBe(true);

    const eventRow = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: created.recoveryEventId } });
    expect(eventRow.status).toBe(RecoveryEventStatus.VOIDED);
    expect(eventRow.voidedAt).not.toBeNull();
    expect(eventRow.voidedByActorId).toBe(systemActor.id);
    expect(eventRow.voidReason).toBe("Recorded in error — duplicate entry.");

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("0.00");
    expect(position.totalOutstanding).toBe("100.00");

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updatedCase.status).toBe(RecoveryCaseStatus.AWAITING_RECOVERY);
  });

  it("S: a correction supersedes the voided event, and a second correction attempt on the same voided event is rejected", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-S", amount: "100.00" }]);
    const original = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "80.00",
      occurredAt: new Date(),
      evidenceReference: "Original entry with wrong amount",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "80.00" }],
    });
    if (!original.ok) throw new Error(original.message);

    const cannotCorrectActive = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Attempted correction of a still-active event",
      supersedesEventId: original.recoveryEventId,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(cannotCorrectActive.ok).toBe(false);

    const voided = await voidRecoveryEvent({ recoveryEventId: original.recoveryEventId, voidReason: "Wrong amount recorded.", actorId: systemActor.id });
    expect(voided.ok).toBe(true);

    const correction = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Corrected entry with right amount",
      supersedesEventId: original.recoveryEventId,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;

    const originalRow = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: original.recoveryEventId } });
    expect(originalRow.status).toBe(RecoveryEventStatus.VOIDED);

    const secondCorrectionAttempt = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Second correction attempt on the already-superseded event",
      supersedesEventId: original.recoveryEventId,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "0.01" }],
    });
    expect(secondCorrectionAttempt.ok).toBe(false);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("100.00");
  });

  it("T: fully-recovered status reopens correctly after the underlying event is voided", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-T", amount: "100.00" }]);
    const created = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Full recovery",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });
    if (!created.ok) throw new Error(created.message);

    const verifiedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(verifiedCase.status).toBe(RecoveryCaseStatus.RECOVERY_VERIFIED);

    await voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "Bank reversed the credit.", actorId: systemActor.id });

    const reopenedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(reopenedCase.status).toBe(RecoveryCaseStatus.AWAITING_RECOVERY);
  });

  it("U: a Recovery Closed Partial declaration is invalidated and reopened once its underlying event is voided", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-U", amount: "100.00" }]);
    const created = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "40.00",
      occurredAt: new Date(),
      evidenceReference: "Partial recovery before giving up",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "40.00" }],
    });
    if (!created.ok) throw new Error(created.message);

    const closedPartial = await declareRecoveryClosedPartial({ recoveryCaseId, note: "Aggregator support exhausted; remaining 60 considered uncollectible.", actorId: systemActor.id });
    expect(closedPartial.ok).toBe(true);
    const closedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(closedCase.status).toBe(RecoveryCaseStatus.RECOVERY_CLOSED_PARTIAL);

    // While closed-partial, no new recovery event may be recorded.
    const blocked = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "10.00",
      occurredAt: new Date(),
      evidenceReference: "Should be blocked while closed partial",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "10.00" }],
    });
    expect(blocked.ok).toBe(false);

    await voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "Payment was reversed by the bank.", actorId: systemActor.id });

    const reopenedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(reopenedCase.status).toBe(RecoveryCaseStatus.AWAITING_RECOVERY);
  });
});

describe("V/W. financial boundaries between findings, disposition, and recovery", () => {
  it("V: the findings report's confirmed total is unaffected by later recovery activity", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-V", amount: "100.00" }]);
    const reportBefore = await prisma.findingsReport.findFirstOrThrow({ where: { recoveryCaseId } });
    const contentBefore = reportBefore.content as { confirmedDiscrepancyTotal: string };
    expect(contentBefore.confirmedDiscrepancyTotal).toBe("100.00");

    await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Full recovery after report generation",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });

    const reportAfter = await prisma.findingsReport.findUniqueOrThrow({ where: { id: reportBefore.id } });
    expect(reportAfter.content).toEqual(reportBefore.content);
  });

  it("W: the aggregator-stated disposition amount never equals or drives the recovered amount", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [{ orderRef: "P5-W", amount: "100.00" }],
      DisputeOutcome.PARTIALLY_ACCEPTED,
      "90.00",
    );

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "65.00",
      occurredAt: new Date(),
      evidenceReference: "Actual amount that arrived, independent of the aggregator's stated 90",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "65.00" }],
    });
    expect(result.ok).toBe(true);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("65.00");

    const submission = await prisma.disputeSubmission.findFirstOrThrow({ where: { recoveryCaseId }, include: { disposition: true } });
    expect(submission.disposition?.aggregatorStatedAmount?.toString()).toBe("90");

    expect((prisma as unknown as Record<string, unknown>).invoice).toBeUndefined();
    expect((prisma as unknown as Record<string, unknown>).successFee).toBeUndefined();
  });
});

describe("X. audit history", () => {
  it("records an accurate append-only event for every material recovery action", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-X", amount: "100.00" }]);

    const created = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "40.00",
      occurredAt: new Date(),
      evidenceReference: "First",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "40.00" }],
    });
    if (!created.ok) throw new Error(created.message);

    await voidRecoveryEvent({ recoveryEventId: created.recoveryEventId, voidReason: "Correcting the amount.", actorId: systemActor.id });
    await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Corrected",
      supersedesEventId: created.recoveryEventId,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.00" }],
    });

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId }, orderBy: { createdAt: "asc" } });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("RECOVERY_RECORDED");
    expect(kinds).toContain("RECOVERY_VOIDED");
    expect(kinds.filter((k) => k === "RECOVERY_RECORDED")).toHaveLength(2);
    expect(kinds).toContain("STATUS_CHANGED");
    for (const event of events) {
      expect(event.actorId).toBe(systemActor.id);
    }
  });
});

describe("Synthetic end-to-end regression (not real bank/aggregator validation)", () => {
  it("reproduces Awaiting Recovery -> partial -> correction -> full verification with known-correct expected state", async () => {
    const { zomato, systemActor } = await getFixtures();
    const { recoveryCaseId, restaurantId, reconciliationCaseIds } = await createAwaitingRecoveryCase(zomato, systemActor, [
      { orderRef: "REG-P5-1", amount: "300.00" },
      { orderRef: "REG-P5-2", amount: "150.00" },
    ]);
    const bankRecord = await createBankRecord(restaurantId, "300.00", "REG-BANK-1");

    const bankEvent = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.DIRECT_BANK_CREDIT,
      amount: "300.00",
      occurredAt: new Date(),
      evidenceReference: "Bank credit matching the first discrepancy",
      bankRecordId: bankRecord.id,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "300.00" }],
    });
    expect(bankEvent.ok).toBe(true);

    const positionAfterFirst = await computeRecoveryPosition(recoveryCaseId);
    expect(positionAfterFirst.totalVerifiedRecovered).toBe("300.00");
    expect(positionAfterFirst.totalOutstanding).toBe("150.00");
    const caseAfterFirst = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(caseAfterFirst.status).toBe(RecoveryCaseStatus.PARTIALLY_RECOVERED);

    const wrongEvent = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: "Wrong amount recorded for the second discrepancy",
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[1], allocatedAmount: "100.00" }],
    });
    expect(wrongEvent.ok).toBe(true);
    if (!wrongEvent.ok) return;

    await voidRecoveryEvent({ recoveryEventId: wrongEvent.recoveryEventId, voidReason: "Wrong amount — should have been 150.", actorId: systemActor.id });
    const correctedEvent = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "150.00",
      occurredAt: new Date(),
      evidenceReference: "Corrected amount for the second discrepancy",
      supersedesEventId: wrongEvent.recoveryEventId,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[1], allocatedAmount: "150.00" }],
    });
    expect(correctedEvent.ok).toBe(true);

    const finalPosition = await computeRecoveryPosition(recoveryCaseId);
    expect(finalPosition.totalVerifiedRecovered).toBe("450.00");
    expect(finalPosition.totalOutstanding).toBe("0.00");
    const finalCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(finalCase.status).toBe(RecoveryCaseStatus.RECOVERY_VERIFIED);

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId } });
    expect(events.length).toBeGreaterThanOrEqual(8);
  });
});

describe("global allocation cap across RecoveryCases", () => {
  /**
   * Puts a discrepancy into the state the cap must defend against: it already
   * carries an ACTIVE allocation from an earlier RecoveryCase, and is now
   * actively linked to a second one.
   *
   * The link is released directly here rather than through recordClientResponse,
   * because that route is now correctly blocked once a DisputeSubmission exists.
   * The point of the cap fix is defence in depth — whatever route ever produces
   * this state, the cap must still hold — so the test constructs the state at the
   * data layer instead of weakening any product constraint to reach it.
   */
  async function setUpDischargedThenRelinked(
    swiggy: Aggregator,
    systemActor: Actor,
    confirmedAmount: string,
    firstAllocation: string,
  ): Promise<{ caseB: string; reconciliationCaseId: string; restaurantId: string }> {
    const { recoveryCaseId: caseA, restaurantId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [
      { orderRef: `P5-GLOBALCAP-${Date.now()}`, amount: confirmedAmount },
    ]);
    const reconciliationCaseId = reconciliationCaseIds[0];

    const firstEvent = await createRecoveryEvent({
      recoveryCaseId: caseA,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: firstAllocation,
      occurredAt: new Date(),
      evidenceReference: `Recovery under the first recovery case ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId, allocatedAmount: firstAllocation }],
    });
    if (!firstEvent.ok) throw new Error(`fixture setup failed: ${firstEvent.message}`);

    await prisma.recoveryCaseReconciliationLink.updateMany({
      where: { recoveryCaseId: caseA, reconciliationCaseId, releasedAt: null },
      data: { releasedAt: new Date(), releasedByActorId: systemActor.id },
    });

    const { recoveryCaseId: caseB } = await createAwaitingRecoveryCase(
      swiggy,
      systemActor,
      [],
      DisputeOutcome.ACCEPTED,
      undefined,
      restaurantId,
      [reconciliationCaseId],
    );

    return { caseB, reconciliationCaseId, restaurantId };
  }

  it("A: counts an earlier RecoveryCase's ACTIVE allocation against the cap when allocating under a second one", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { caseB, reconciliationCaseId } = await setUpDischargedThenRelinked(swiggy, systemActor, "100.00", "100.00");

    const attempt = await createRecoveryEvent({
      recoveryCaseId: caseB,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.00",
      occurredAt: new Date(),
      evidenceReference: `Second claim on an already fully recovered discrepancy ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId, allocatedAmount: "100.00" }],
    });

    expect(attempt.ok).toBe(false);
    // Must be rejected by the cap specifically — not ownership, eligibility, or provenance.
    if (!attempt.ok) {
      expect(attempt.message).toContain("would exceed the confirmed discrepancy amount");
      expect(attempt.message).toContain("already allocated 100.00");
      expect(attempt.message).toContain("no override exists");
    }

    const globalActive = await prisma.recoveryAllocation.findMany({
      where: { reconciliationCaseId, recoveryEvent: { status: RecoveryEventStatus.ACTIVE } },
    });
    expect(sumAllocations(globalActive)).toBe("100.00");
  });

  it("B: two concurrent allocations under a second RecoveryCase can never push the global total past the cap", async () => {
    const { swiggy, systemActor } = await getFixtures();
    // Cap 100, already 60 ACTIVE from the earlier case. Two concurrent 30s would
    // be 120 in total — only one can be allowed through.
    const { caseB, reconciliationCaseId } = await setUpDischargedThenRelinked(swiggy, systemActor, "100.00", "60.00");

    const [a, b] = await Promise.all([
      createRecoveryEvent({
        recoveryCaseId: caseB,
        method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
        amount: "30.00",
        occurredAt: new Date(),
        evidenceReference: `Cross-case race A ${Date.now()}`,
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId, allocatedAmount: "30.00" }],
      }),
      createRecoveryEvent({
        recoveryCaseId: caseB,
        method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
        amount: "30.00",
        occurredAt: new Date(),
        evidenceReference: `Cross-case race B ${Date.now()}`,
        verifiedAt: new Date(),
        actorId: systemActor.id,
        allocations: [{ reconciliationCaseId, allocatedAmount: "30.00" }],
      }),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);

    const globalActive = await prisma.recoveryAllocation.findMany({
      where: { reconciliationCaseId, recoveryEvent: { status: RecoveryEventStatus.ACTIVE } },
    });
    // 60 carried over + exactly one 30 — never 120, and never above the 100 cap.
    expect(sumAllocations(globalActive)).toBe("90.00");
    expect(toMoney(sumAllocations(globalActive)).lessThanOrEqualTo(toMoney("100.00"))).toBe(true);
  });
});

describe("client response immutability once a dispute exists", () => {
  it("E: rejects a client-response change as soon as a DisputeSubmission exists, before any disposition", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, "P5-CLIENTLOCK-E", "100.00");
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    if (!created.ok) throw new Error(created.message);
    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) throw new Error(report.message);
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    const approval = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.APPROVED, note: "Owner approved." });
    expect(approval.ok).toBe(true);

    const submitted = await createDisputeSubmission({ recoveryCaseId: created.recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const before = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    const attempt = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED, note: "Trying to retract after filing." });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.message).toContain("dispute has already been submitted");

    const after = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    expect(after.clientResponseStatus).toBe(before.clientResponseStatus);
    expect(after.clientResponseNote).toBe(before.clientResponseNote);
    expect(after.status).toBe(before.status);
    expect(after.closedAt).toBeNull();

    const links = await prisma.recoveryCaseReconciliationLink.findMany({ where: { recoveryCaseId: created.recoveryCaseId } });
    expect(links.every((l) => l.releasedAt === null)).toBe(true);
    const submissions = await prisma.disputeSubmission.findMany({ where: { recoveryCaseId: created.recoveryCaseId } });
    expect(submissions).toHaveLength(1);
  });

  it("serializes a client-response change racing a dispute submission, so the guard cannot be stepped over", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, "P5-CLIENTLOCK-RACE", "100.00");
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    if (!created.ok) throw new Error(created.message);
    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) throw new Error(report.message);
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    const approval = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.APPROVED });
    if (!approval.ok) throw new Error(approval.message);

    // Both take the same recovery_cases FOR UPDATE lock, so they serialize:
    // either the submission lands first and the DECLINE is refused, or the
    // DECLINE lands first and the submission is refused (its own eligibility
    // check rejects a CLOSED case). What must never happen is BOTH.
    const [decline, submission] = await Promise.all([
      recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED, note: "Racing the dispute filing." }),
      createDisputeSubmission({ recoveryCaseId: created.recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id }),
    ]);

    expect([decline.ok, submission.ok].filter(Boolean)).toHaveLength(1);

    const finalCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    const submissions = await prisma.disputeSubmission.findMany({ where: { recoveryCaseId: created.recoveryCaseId } });
    const links = await prisma.recoveryCaseReconciliationLink.findMany({ where: { recoveryCaseId: created.recoveryCaseId } });

    if (submission.ok) {
      // Submission won: the case must NOT have been closed or stripped.
      expect(submissions).toHaveLength(1);
      expect(finalCase.status).not.toBe(RecoveryCaseStatus.CLOSED);
      expect(finalCase.clientResponseStatus).toBe(ClientResponseStatus.APPROVED);
      expect(links.every((l) => l.releasedAt === null)).toBe(true);
    } else {
      // Decline won: no submission may exist against the now-closed case.
      expect(submissions).toHaveLength(0);
      expect(finalCase.status).toBe(RecoveryCaseStatus.CLOSED);
    }
  });

  it("C: rejects a client-response change once the case has entered the recovery lifecycle, leaving the ledger untouched", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-CLIENTLOCK-C", amount: "100.00" }]);
    const recorded = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "40.00",
      occurredAt: new Date(),
      evidenceReference: `Recovery before an attempted client-response change ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "40.00" }],
    });
    if (!recorded.ok) throw new Error(recorded.message);

    const before = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(before.status).toBe(RecoveryCaseStatus.PARTIALLY_RECOVERED);

    const attempt = await recordClientResponse({ recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED, note: "Retracting after recovery started." });
    expect(attempt.ok).toBe(false);

    const after = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(after.clientResponseStatus).toBe(before.clientResponseStatus);
    expect(after.status).toBe(RecoveryCaseStatus.PARTIALLY_RECOVERED);
    expect(after.closedAt).toBeNull();

    const links = await prisma.recoveryCaseReconciliationLink.findMany({ where: { recoveryCaseId } });
    expect(links.every((l) => l.releasedAt === null)).toBe(true);

    const position = await computeRecoveryPosition(recoveryCaseId);
    expect(position.totalVerifiedRecovered).toBe("40.00");
    expect(position.totalOutstanding).toBe("60.00");
    const activeEvents = await prisma.recoveryEvent.count({ where: { recoveryCaseId, status: RecoveryEventStatus.ACTIVE } });
    expect(activeEvents).toBe(1);
  });
});

describe("D. money normalization", () => {
  it("normalizes a sub-paisa amount through roundMoney before persisting, keeping allocations cent-consistent", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-MONEY-ROUND", amount: "200.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "100.005",
      occurredAt: new Date(),
      evidenceReference: `Sub-paisa amount normalization ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "100.005" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exactly what the project's existing roundMoney (ROUND_HALF_UP) produces.
    const expected = roundMoney(toMoney("100.005")).toFixed(2);
    expect(expected).toBe("100.01");

    const event = await prisma.recoveryEvent.findUniqueOrThrow({ where: { id: result.recoveryEventId }, include: { allocations: true } });
    expect(toMoney(event.amount.toString()).toFixed(2)).toBe(expected);
    expect(toMoney(event.allocations[0].allocatedAmount.toString()).toFixed(2)).toBe(expected);

    const allocatedTotal = sumMoney(event.allocations.map((a) => toMoney(a.allocatedAmount.toString())));
    expect(allocatedTotal.lessThanOrEqualTo(toMoney(event.amount.toString()))).toBe(true);
  });

  it("rejects an amount that normalizes to zero with a clean validation error and persists nothing", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-MONEY-ZERO", amount: "100.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "0.001",
      occurredAt: new Date(),
      evidenceReference: `Sub-paisa amount rejection ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "0.001" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("Amount must be greater than zero.");

    const events = await prisma.recoveryEvent.count({ where: { recoveryCaseId } });
    expect(events).toBe(0);
  });

  it("rejects an allocation that normalizes to zero without persisting a partial event", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId, reconciliationCaseIds } = await createAwaitingRecoveryCase(swiggy, systemActor, [{ orderRef: "P5-MONEY-ALLOC-ZERO", amount: "100.00" }]);

    const result = await createRecoveryEvent({
      recoveryCaseId,
      method: RecoveryMethod.OTHER_EVIDENCED_METHOD,
      amount: "50.00",
      occurredAt: new Date(),
      evidenceReference: `Sub-paisa allocation rejection ${Date.now()}`,
      verifiedAt: new Date(),
      actorId: systemActor.id,
      allocations: [{ reconciliationCaseId: reconciliationCaseIds[0], allocatedAmount: "0.001" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("Each allocation amount must be a valid, positive decimal number.");

    const events = await prisma.recoveryEvent.count({ where: { recoveryCaseId } });
    expect(events).toBe(0);
  });
});

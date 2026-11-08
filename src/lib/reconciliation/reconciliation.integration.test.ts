// Integration tests against the real Postgres database (DATABASE_URL).
// Phase 2 orchestrators (runOrderReconciliation, runBankReconciliation,
// classifyCase, applyCancellationOverride) each manage their own internal
// transaction, so — like commit-import.integration.test.ts — these tests
// cannot wrap calls in an outer transaction they roll back. Every row
// created is deleted in an afterEach block, verified with a zero-residue
// check at the end of the suite.
//
// All restaurants/records here are clearly-synthetic fixtures created for
// this test file only — never real client data, and never claimed to be a
// real case. The specific numbers are chosen to exercise the taxonomy and
// calculation rules, not copied from any real reconciliation.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ClassificationStatus, CalculationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import type { Aggregator, Actor } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { applyCancellationOverride } from "./apply-cancellation-override";
import { classifyCase } from "./classify";
import { runBankReconciliation } from "./run-bank-reconciliation";
import { runOrderReconciliation } from "./run-order-reconciliation";

const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";
const IN_PERIOD_DATE = new Date("2026-08-15T00:00:00.000Z");

const createdRestaurantIds: string[] = [];

function trackRestaurant(id: string): string {
  createdRestaurantIds.push(id);
  return id;
}

afterEach(async () => {
  if (createdRestaurantIds.length === 0) return;
  const ids = [...createdRestaurantIds];
  createdRestaurantIds.length = 0;

  // Break the self-referential supersession chain first so the bulk delete
  // below isn't blocked by the ON DELETE RESTRICT on supersedesCaseId.
  await prisma.reconciliationCase.updateMany({
    where: { restaurantId: { in: ids } },
    data: { supersedesCaseId: null },
  });
  // ClassificationEvent/CaseEvidence/CaseRecordLink all cascade from
  // ReconciliationCase (see schema.prisma onDelete: Cascade).
  await prisma.reconciliationCase.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.settlementRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.pOSRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.bankRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.restaurant.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  const residualCount = await prisma.restaurant.count({ where: { code: { startsWith: "TEST__RECON_" } } });
  expect(residualCount).toBe(0);
});

let restaurantCounter = 0;
async function createTestRestaurant() {
  restaurantCounter += 1;
  return prisma.restaurant.create({
    data: {
      name: `TEST__Reconciliation Fixture ${restaurantCounter}`,
      code: `TEST__RECON_${Date.now()}_${restaurantCounter}_${Math.random().toString(36).slice(2, 8)}`,
      notes: "Synthetic fixture for automated Phase 2 integration tests only — not a real client.",
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

async function createSettlement(restaurantId: string, aggregatorId: string, amount: string, orderRef: string | null, date = IN_PERIOD_DATE) {
  return prisma.settlementRecord.create({ data: { restaurantId, aggregatorId, amount, orderRef, date } });
}

async function createPos(restaurantId: string, amount: string, orderRef: string | null, date = IN_PERIOD_DATE) {
  return prisma.pOSRecord.create({ data: { restaurantId, amount, orderRef, date } });
}

async function createBank(restaurantId: string, amount: string, date = IN_PERIOD_DATE) {
  return prisma.bankRecord.create({ data: { restaurantId, amount, date } });
}

const RATES = { commissionRatePercent: "20", sourceReference: "TEST fixture rate assumption" };

describe("runOrderReconciliation", () => {
  it("creates a zero-difference case for a clean exact match", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-CLEAN");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-CLEAN"); // 1000 - 20% commission = 800

    const result = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    expect(result.matchedCount).toBe(1);
    expect(result.casesCreated).toBe(1);
    expect(result.casesSuperseded).toBe(0);

    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-CLEAN" } });
    expect(reconCase.calculationStatus).toBe(CalculationStatus.CALCULATED);
    expect(reconCase.expectedAmount?.toString()).toBe("800");
    expect(reconCase.actualAmount?.toString()).toBe("800");
    expect(reconCase.difference?.toString()).toBe("0");
    expect(reconCase.status).toBe(ClassificationStatus.UNCLASSIFIED);
    expect(reconCase.isSuperseded).toBe(false);

    const links = await prisma.caseRecordLink.findMany({ where: { caseId: reconCase.id } });
    expect(links).toHaveLength(2);
    expect(links.some((l) => l.settlementRecordId !== null)).toBe(true);
    expect(links.some((l) => l.posRecordId !== null)).toBe(true);

    const evidence = await prisma.caseEvidence.findMany({ where: { caseId: reconCase.id } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceReference).toBe("TEST fixture rate assumption");
  });

  it("computes a positive difference (restaurant owed money) for a settlement shortfall", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-SHORT");
    await createSettlement(restaurant, swiggy.id, "700.00", "ORD-SHORT"); // expected 800, paid 700

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-SHORT" } });
    expect(reconCase.difference?.toString()).toBe("100");
  });

  it("computes a negative difference for an overpayment", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-OVER");
    await createSettlement(restaurant, swiggy.id, "900.00", "ORD-OVER"); // expected 800, paid 900

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-OVER" } });
    expect(reconCase.difference?.toString()).toBe("-100");
  });

  it("creates an UNMATCHED case with no invented expected amount for a settlement with no POS counterpart", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createSettlement(restaurant, swiggy.id, "500.00", "ORD-NO-POS");

    const result = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    expect(result.unmatchedSettlementCount).toBe(1);
    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-NO-POS" } });
    expect(reconCase.calculationStatus).toBe(CalculationStatus.UNMATCHED);
    expect(reconCase.expectedAmount).toBeNull();
    expect(reconCase.actualAmount?.toString()).toBe("500");
    expect(reconCase.difference).toBeNull();
  });

  it("creates an UNMATCHED case with no invented amounts for a POS row with no settlement counterpart", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "500.00", "ORD-NO-SETTLEMENT");

    const result = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    expect(result.unmatchedPosCount).toBe(1);
    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-NO-SETTLEMENT" } });
    expect(reconCase.calculationStatus).toBe(CalculationStatus.UNMATCHED);
    expect(reconCase.expectedAmount).toBeNull();
    expect(reconCase.actualAmount).toBeNull();
  });

  it("marks a matched pair INSUFFICIENT_DATA rather than inventing a rate when no commission rate is supplied", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-NO-RATE");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-NO-RATE");

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: null,
      actorId: systemActor.id,
    });

    const reconCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-NO-RATE" } });
    expect(reconCase.calculationStatus).toBe(CalculationStatus.INSUFFICIENT_DATA);
    expect(reconCase.expectedAmount).toBeNull();
    expect(reconCase.actualAmount?.toString()).toBe("800");
    expect(reconCase.difference).toBeNull();
  });

  it("does not double-match one POS row when two aggregators' settlements collide on the same orderRef (ambiguous, left unmatched under both)", async () => {
    const { swiggy, zomato, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-COLLIDE");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-COLLIDE");
    await createSettlement(restaurant, zomato.id, "750.00", "ORD-COLLIDE");

    const swiggyResult = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });
    const zomatoResult = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: zomato.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    // Neither run may claim a clean match — the collision must surface as
    // ambiguous/unmatched rather than letting one aggregator's run silently
    // consume the POS row as if it were an uncontested match.
    expect(swiggyResult.matchedCount).toBe(0);
    expect(zomatoResult.matchedCount).toBe(0);
    expect(swiggyResult.ambiguousOrderRefCount).toBe(1);
    expect(zomatoResult.ambiguousOrderRefCount).toBe(1);

    const swiggyCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, aggregatorId: swiggy.id, orderRef: "ORD-COLLIDE" } });
    const zomatoCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, aggregatorId: zomato.id, orderRef: "ORD-COLLIDE" } });
    expect(swiggyCase.calculationStatus).toBe(CalculationStatus.UNMATCHED);
    expect(zomatoCase.calculationStatus).toBe(CalculationStatus.UNMATCHED);

    // The POS row itself must not spawn a THIRD, separate "unmatched POS" case —
    // it was claimed (ambiguously) by settlement-side matching, not orphaned.
    const posOnlyCases = await prisma.reconciliationCase.findMany({
      where: { restaurantId: restaurant, orderRef: "ORD-COLLIDE", calculationStatus: CalculationStatus.UNMATCHED },
    });
    expect(posOnlyCases).toHaveLength(2);
  });

  it("rerunning for the same key supersedes the old case, preserves it, and resets classification to blank", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-RERUN");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-RERUN");

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });
    const firstCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-RERUN" } });

    const classifyResult = await classifyCase({
      caseId: firstCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
      rationale: "Need to confirm with restaurant before deciding.",
    });
    expect(classifyResult.ok).toBe(true);

    // A new rate assumption changes the calculation — a legitimate rerun.
    const rerunResult = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: { commissionRatePercent: "25", sourceReference: "Corrected rate card" },
      actorId: systemActor.id,
    });
    expect(rerunResult.casesSuperseded).toBe(1);

    const oldCase = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: firstCase.id } });
    expect(oldCase.isSuperseded).toBe(true);
    expect(oldCase.status).toBe(ClassificationStatus.REQUIRES_HUMAN_REVIEW); // old classification history untouched

    const newCase = await prisma.reconciliationCase.findFirstOrThrow({
      where: { restaurantId: restaurant, orderRef: "ORD-RERUN", isSuperseded: false },
    });
    expect(newCase.id).not.toBe(firstCase.id);
    expect(newCase.status).toBe(ClassificationStatus.UNCLASSIFIED); // fresh calculation, blank classification again
    expect(newCase.expectedAmount?.toString()).toBe("750"); // 1000 - 25%
    expect(newCase.supersedesCaseId).toBe(firstCase.id);

    // The old case's classification event is still queryable — never overwritten.
    const oldEvents = await prisma.classificationEvent.findMany({ where: { caseId: firstCase.id } });
    expect(oldEvents).toHaveLength(1);
    expect(oldEvents[0].toStatus).toBe(ClassificationStatus.REQUIRES_HUMAN_REVIEW);
  });

  it("serializes concurrent reruns for the same key so only one case ends up live", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-RACE");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-RACE");

    const input = {
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    };

    await Promise.all([runOrderReconciliation(input), runOrderReconciliation(input)]);

    const liveCases = await prisma.reconciliationCase.findMany({
      where: { restaurantId: restaurant, orderRef: "ORD-RACE", isSuperseded: false },
    });
    expect(liveCases).toHaveLength(1);
  });
});

describe("runBankReconciliation", () => {
  it("creates a BANK_CYCLE case comparing the settlement total against the bank credit, kept separate from order-level cases", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-BANK-1");
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-BANK-1");
    await createPos(restaurant, "500.00", "ORD-BANK-2");
    await createSettlement(restaurant, swiggy.id, "400.00", "ORD-BANK-2");
    const bank = await createBank(restaurant, "1100.00"); // settlement total is 1200 -> shortfall of 100

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });

    const bankResult = await runBankReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bankRecordId: bank.id,
      actorId: systemActor.id,
    });

    expect(bankResult.settlementRecordCount).toBe(2);

    const bankCase = await prisma.reconciliationCase.findFirstOrThrow({
      where: { restaurantId: restaurant, scope: ReconciliationScope.BANK_CYCLE },
    });
    expect(bankCase.expectedAmount?.toString()).toBe("1200");
    expect(bankCase.actualAmount?.toString()).toBe("1100");
    expect(bankCase.difference?.toString()).toBe("100");
    expect(bankCase.status).toBe(ClassificationStatus.UNCLASSIFIED); // not automatically Confirmed Discrepancy

    // The two order-level cases still carry their own independent differences —
    // the bank-level shortfall must not have adjusted or absorbed them.
    const orderCases = await prisma.reconciliationCase.findMany({
      where: { restaurantId: restaurant, scope: ReconciliationScope.ORDER_LEVEL },
    });
    expect(orderCases).toHaveLength(2);
    for (const c of orderCases) {
      expect(c.difference?.toString()).toBe("0");
    }
  });

  it("marks INSUFFICIENT_DATA when no settlement records exist for the period, rather than inventing an expected total", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const bank = await createBank(restaurant, "500.00");

    await runBankReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bankRecordId: bank.id,
      actorId: systemActor.id,
    });

    const bankCase = await prisma.reconciliationCase.findFirstOrThrow({
      where: { restaurantId: restaurant, scope: ReconciliationScope.BANK_CYCLE },
    });
    expect(bankCase.calculationStatus).toBe(CalculationStatus.INSUFFICIENT_DATA);
    expect(bankCase.expectedAmount).toBeNull();
    expect(bankCase.difference).toBeNull();
  });

  it("rerunning for the same bank cycle supersedes the prior bank-cycle case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createSettlement(restaurant, swiggy.id, "800.00", "ORD-BANK-RERUN");
    const bank = await createBank(restaurant, "800.00");

    const first = await runBankReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bankRecordId: bank.id,
      actorId: systemActor.id,
    });
    expect(first.caseSuperseded).toBe(false);

    const second = await runBankReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bankRecordId: bank.id,
      actorId: systemActor.id,
    });
    expect(second.caseSuperseded).toBe(true);

    const liveCases = await prisma.reconciliationCase.findMany({
      where: { restaurantId: restaurant, scope: ReconciliationScope.BANK_CYCLE, isSuperseded: false },
    });
    expect(liveCases).toHaveLength(1);
  });
});

describe("classifyCase", () => {
  async function createSimpleCase(restaurantId: string, aggregatorId: string, actorId: string, orderRef: string) {
    return prisma.reconciliationCase.create({
      data: {
        restaurantId,
        aggregatorId,
        scope: ReconciliationScope.ORDER_LEVEL,
        orderRef,
        expectedAmount: "800.00",
        actualAmount: "700.00",
        difference: "100.00",
        calculationStatus: CalculationStatus.CALCULATED,
        calculationFormulaVersion: "v1",
        calculationBreakdown: { note: "test fixture" },
        createdByActorId: actorId,
      },
    });
  }

  it("starts every new case at UNCLASSIFIED with no classification history", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-BLANK");

    expect(reconCase.status).toBe(ClassificationStatus.UNCLASSIFIED);
    const events = await prisma.classificationEvent.findMany({ where: { caseId: reconCase.id } });
    expect(events).toHaveLength(0);
  });

  it("rejects an empty rationale", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-NO-RATIONALE");

    const result = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.VALID_DEDUCTION,
      rationale: "   ",
    });

    expect(result.ok).toBe(false);
    const unchanged = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: reconCase.id } });
    expect(unchanged.status).toBe(ClassificationStatus.UNCLASSIFIED);
  });

  it("rejects explicitly (re-)selecting UNCLASSIFIED", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-UNCLASSIFIED-TARGET");

    const result = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.UNCLASSIFIED,
      rationale: "Trying to reset it back to blank.",
    });

    expect(result.ok).toBe(false);
  });

  it("writes a ClassificationEvent and updates status atomically for a normal classification", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-TIMING");

    const result = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.TIMING_DIFFERENCE,
      rationale: "Settlement posted after cutoff; will appear in the next cycle.",
    });

    expect(result.ok).toBe(true);
    const updated = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: reconCase.id } });
    expect(updated.status).toBe(ClassificationStatus.TIMING_DIFFERENCE);

    const events = await prisma.classificationEvent.findMany({ where: { caseId: reconCase.id } });
    expect(events).toHaveLength(1);
    expect(events[0].fromStatus).toBe(ClassificationStatus.UNCLASSIFIED);
    expect(events[0].toStatus).toBe(ClassificationStatus.TIMING_DIFFERENCE);
    expect(events[0].actorId).toBe(systemActor.id);
  });

  it("rejects CONFIRMED_DISCREPANCY without both required confirmations", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-CONFIRM-GATE-1");

    const noneConfirmed = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.CONFIRMED_DISCREPANCY,
      rationale: "This looks like a real shortfall.",
    });
    expect(noneConfirmed.ok).toBe(false);

    const onlyOneConfirmed = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.CONFIRMED_DISCREPANCY,
      rationale: "This looks like a real shortfall.",
      confirmedEvidenceReviewed: true,
      confirmedSupportable: false,
    });
    expect(onlyOneConfirmed.ok).toBe(false);

    const unchanged = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: reconCase.id } });
    expect(unchanged.status).toBe(ClassificationStatus.UNCLASSIFIED);
    const events = await prisma.classificationEvent.findMany({ where: { caseId: reconCase.id } });
    expect(events).toHaveLength(0);
  });

  it("accepts CONFIRMED_DISCREPANCY when both confirmations are explicitly true", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-CONFIRM-GATE-2");

    const result = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.CONFIRMED_DISCREPANCY,
      rationale: "Reviewed the rate card and the settlement report; the shortfall has no valid basis.",
      confirmedEvidenceReviewed: true,
      confirmedSupportable: true,
    });

    expect(result.ok).toBe(true);
    const updated = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: reconCase.id } });
    expect(updated.status).toBe(ClassificationStatus.CONFIRMED_DISCREPANCY);
  });

  it("rejects classifying a case that has already been superseded", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-SUPERSEDED-CLASSIFY");
    await prisma.reconciliationCase.update({ where: { id: reconCase.id }, data: { isSuperseded: true } });

    const result = await classifyCase({
      caseId: reconCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
      rationale: "Trying to classify a stale case.",
    });

    expect(result.ok).toBe(false);
    const events = await prisma.classificationEvent.findMany({ where: { caseId: reconCase.id } });
    expect(events).toHaveLength(0);
  });

  it("serializes concurrent classifications of the same case so the audit trail's fromStatus chain stays accurate", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const reconCase = await createSimpleCase(restaurant, swiggy.id, systemActor.id, "ORD-CONCURRENT-CLASSIFY");

    const [first, second] = await Promise.all([
      classifyCase({
        caseId: reconCase.id,
        actorId: systemActor.id,
        toStatus: ClassificationStatus.TIMING_DIFFERENCE,
        rationale: "First concurrent classification attempt.",
      }),
      classifyCase({
        caseId: reconCase.id,
        actorId: systemActor.id,
        toStatus: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
        rationale: "Second concurrent classification attempt.",
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Without row locking, both concurrent transactions could read the same
    // pre-update UNCLASSIFIED status and both log fromStatus: UNCLASSIFIED —
    // corrupting the "what it used to be" chain for whichever event actually
    // committed second. With the FOR UPDATE lock in classify.ts, the two
    // calls serialize: exactly one event has fromStatus UNCLASSIFIED, and
    // the other has fromStatus equal to whatever the first one wrote.
    const events = await prisma.classificationEvent.findMany({ where: { caseId: reconCase.id }, orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(2);
    expect(events[0].fromStatus).toBe(ClassificationStatus.UNCLASSIFIED);
    expect(events[1].fromStatus).toBe(events[0].toStatus);

    const finalCase = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: reconCase.id } });
    expect(finalCase.status).toBe(events[1].toStatus);
  });
});

describe("applyCancellationOverride", () => {
  it("supersedes the case with the evidenced flat fee as the new expected amount, carrying evidence forward", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-CANCEL");
    await createSettlement(restaurant, swiggy.id, "50.00", "ORD-CANCEL"); // only the cancellation fee was paid out

    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });
    const originalCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-CANCEL" } });
    expect(originalCase.difference?.toString()).toBe("750"); // formula assumed a live order, not a cancellation

    const overrideResult = await applyCancellationOverride({
      caseId: originalCase.id,
      actorId: systemActor.id,
      cancellationFeeAmount: "50.00",
      sourceReference: "Contract clause 7.1 — cancellation fee schedule",
    });

    expect(overrideResult.ok).toBe(true);
    if (!overrideResult.ok) return;

    expect(overrideResult.case.expectedAmount?.toString()).toBe("50");
    expect(overrideResult.case.actualAmount?.toString()).toBe("50");
    expect(overrideResult.case.difference?.toString()).toBe("0");
    expect(overrideResult.case.cancellationOverrideApplied).toBe(true);
    expect(overrideResult.case.status).toBe(ClassificationStatus.UNCLASSIFIED);

    const oldCase = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: originalCase.id } });
    expect(oldCase.isSuperseded).toBe(true);

    const newLinks = await prisma.caseRecordLink.findMany({ where: { caseId: overrideResult.case.id } });
    expect(newLinks).toHaveLength(2); // settlement + POS carried forward

    const newEvidence = await prisma.caseEvidence.findMany({ where: { caseId: overrideResult.case.id } });
    // 1 copied-forward rate-assumption entry + 1 new cancellation-override entry
    expect(newEvidence).toHaveLength(2);
    expect(newEvidence.some((e) => e.description.includes("Cancelled/voided"))).toBe(true);
  });

  it("requires a source reference and rejects applying to an already-superseded case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    await createPos(restaurant, "1000.00", "ORD-CANCEL-2");
    await createSettlement(restaurant, swiggy.id, "50.00", "ORD-CANCEL-2");
    await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });
    const originalCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef: "ORD-CANCEL-2" } });

    const noSource = await applyCancellationOverride({
      caseId: originalCase.id,
      actorId: systemActor.id,
      cancellationFeeAmount: "50.00",
      sourceReference: "  ",
    });
    expect(noSource.ok).toBe(false);

    await prisma.reconciliationCase.update({ where: { id: originalCase.id }, data: { isSuperseded: true } });
    const onSuperseded = await applyCancellationOverride({
      caseId: originalCase.id,
      actorId: systemActor.id,
      cancellationFeeAmount: "50.00",
      sourceReference: "Contract clause 7.1",
    });
    expect(onSuperseded.ok).toBe(false);
  });
});

describe("synthetic regression scenario (Action 14-inspired, not real customer data)", () => {
  // This scenario runs many sequential round-trips against live Neon (6
  // record pairs, 2 reconciliation runs, 6 classify attempts) — the default
  // 5s Vitest timeout is too tight for that over a real network connection,
  // so it's raised here rather than raising the global default.
  it("reproduces a coherent set of reconciliation outcomes across the approved taxonomy", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);

    // 1. Clean match — no discrepancy.
    await createPos(restaurant, "2000.00", "A14-CLEAN");
    await createSettlement(restaurant, swiggy.id, "1600.00", "A14-CLEAN"); // 2000 - 20%

    // 2. A shortfall the operator will later classify as a timing difference.
    await createPos(restaurant, "1500.00", "A14-TIMING");
    await createSettlement(restaurant, swiggy.id, "1100.00", "A14-TIMING"); // expected 1200, paid 1100

    // 3. An unmatched settlement — missing data / unmatched order material.
    await createSettlement(restaurant, swiggy.id, "300.00", "A14-UNMATCHED");

    // 4. A shortfall the operator will classify as a commercial rule difference
    //    (e.g. a promo/discount deduction the restaurant had agreed to).
    await createPos(restaurant, "1000.00", "A14-COMMERCIAL");
    await createSettlement(restaurant, swiggy.id, "750.00", "A14-COMMERCIAL"); // expected 800, paid 750

    // 5. A shortfall that needs more digging before anyone decides anything.
    await createPos(restaurant, "600.00", "A14-REVIEW");
    await createSettlement(restaurant, swiggy.id, "400.00", "A14-REVIEW"); // expected 480, paid 400

    // 6. A shortfall the operator will confirm as a real discrepancy.
    await createPos(restaurant, "2500.00", "A14-CONFIRMED");
    await createSettlement(restaurant, swiggy.id, "1000.00", "A14-CONFIRMED"); // expected 2000, paid 1000

    const bank = await createBank(restaurant, "6000.00"); // settlement total below, deliberately short

    const orderResult = await runOrderReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rates: RATES,
      actorId: systemActor.id,
    });
    expect(orderResult.matchedCount).toBe(5);
    expect(orderResult.unmatchedSettlementCount).toBe(1);

    const bankResult = await runBankReconciliation({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bankRecordId: bank.id,
      actorId: systemActor.id,
    });
    // Settlement total: 1600 + 1100 + 300 + 750 + 400 + 1000 = 5150; bank credited 6000 -> overpayment at bank level.
    expect(bankResult.settlementRecordCount).toBe(6);

    async function findCase(orderRef: string) {
      return prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, orderRef } });
    }

    const timingCase = await findCase("A14-TIMING");
    const timingResult = await classifyCase({
      caseId: timingCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.TIMING_DIFFERENCE,
      rationale: "Settlement for this order posted just after the payout cutoff and cleared in the next cycle's bank credit.",
    });
    expect(timingResult.ok).toBe(true);

    const unmatchedCase = await findCase("A14-UNMATCHED");
    const unmatchedResult = await classifyCase({
      caseId: unmatchedCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.MISSING_DATA_UNMATCHED_ORDER,
      rationale: "No POS record found for this settlement row in the exported period — likely a POS export gap.",
    });
    expect(unmatchedResult.ok).toBe(true);

    const commercialCase = await findCase("A14-COMMERCIAL");
    const commercialResult = await classifyCase({
      caseId: commercialCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.COMMERCIAL_RULE_DIFFERENCE,
      rationale: "Restaurant had an agreed promotional discount for this order per the partnership addendum.",
    });
    expect(commercialResult.ok).toBe(true);

    const reviewCase = await findCase("A14-REVIEW");
    const reviewResult = await classifyCase({
      caseId: reviewCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
      rationale: "Shortfall doesn't match any known deduction pattern yet — needs a follow-up with the restaurant.",
    });
    expect(reviewResult.ok).toBe(true);

    const confirmedCase = await findCase("A14-CONFIRMED");
    const rejectedFirst = await classifyCase({
      caseId: confirmedCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.CONFIRMED_DISCREPANCY,
      rationale: "Large shortfall with no matching deduction anywhere in the statement.",
    });
    expect(rejectedFirst.ok).toBe(false); // the extra confirmation gate is not optional
    const confirmedResult = await classifyCase({
      caseId: confirmedCase.id,
      actorId: systemActor.id,
      toStatus: ClassificationStatus.CONFIRMED_DISCREPANCY,
      rationale: "Large shortfall with no matching deduction anywhere in the statement or rate card.",
      confirmedEvidenceReviewed: true,
      confirmedSupportable: true,
    });
    expect(confirmedResult.ok).toBe(true);

    // The clean match stays UNCLASSIFIED — nothing classifies itself.
    const cleanCase = await findCase("A14-CLEAN");
    expect(cleanCase.status).toBe(ClassificationStatus.UNCLASSIFIED);
    expect(cleanCase.difference?.toString()).toBe("0");

    // The bank-cycle signal stays independent — an operator has not classified
    // it in this scenario, and it must never be auto-set to Confirmed Discrepancy
    // just because order-level cases were confirmed.
    const bankCase = await prisma.reconciliationCase.findFirstOrThrow({ where: { restaurantId: restaurant, scope: ReconciliationScope.BANK_CYCLE } });
    expect(bankCase.status).toBe(ClassificationStatus.UNCLASSIFIED);
    expect(bankCase.difference?.toString()).toBe("-850"); // 5150 expected - 6000 actual

    // Full audit trail: every classified case has exactly one event recording who/when/why.
    const allEvents = await prisma.classificationEvent.findMany({ where: { case: { restaurantId: restaurant } } });
    // timing, unmatched, commercial, review, confirmed (accepted) — the rejected
    // confirmed-discrepancy attempt above wrote no event at all.
    expect(allEvents).toHaveLength(5);
    const confirmedEvents = await prisma.classificationEvent.findMany({ where: { caseId: confirmedCase.id } });
    expect(confirmedEvents).toHaveLength(1);
  }, 20000);
});

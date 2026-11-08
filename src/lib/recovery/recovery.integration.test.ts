// Integration tests against the real Postgres database (DATABASE_URL).
// Phase 3 orchestrators each manage their own internal transaction, so —
// like Phase 1/2's integration suites — these tests cannot wrap calls in an
// outer transaction they roll back. Every row created is deleted in an
// afterEach block, verified with a zero-residue check at the end of the
// suite. All restaurants/records here are clearly-synthetic fixtures
// created for this test file only — never real client data, and never
// claimed to be a real case.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ClassificationStatus, ClientResponseStatus, ReconciliationScope, RecoveryCaseStatus } from "@/generated/prisma/enums";
import type { Aggregator, Actor } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createRecoveryCase } from "./create-recovery-case";
import { linkDiscrepancyToOpenCase, unlinkDiscrepancy } from "./link";
import { computeEvidenceReadiness, setEvidenceItem } from "./evidence";
import { computeConfirmedTotal } from "./confirmed-total";
import { recordOverlapReview } from "./overlap-review";
import { generateFindingsReport, markReportSent } from "./findings-report";
import { recordClientResponse } from "./client-response";

const createdRestaurantIds: string[] = [];
function trackRestaurant(id: string): string {
  createdRestaurantIds.push(id);
  return id;
}

afterEach(async () => {
  if (createdRestaurantIds.length === 0) return;
  const ids = [...createdRestaurantIds];
  createdRestaurantIds.length = 0;

  // RecoveryCase cascades RecoveryCaseEvent/EvidenceItem/FindingsReport/
  // RecoveryCaseReconciliationLink; must be deleted before ReconciliationCase
  // (which the links reference with onDelete: Restrict).
  await prisma.recoveryCase.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.reconciliationCase.updateMany({ where: { restaurantId: { in: ids } }, data: { supersedesCaseId: null } });
  await prisma.reconciliationCase.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.settlementRecord.deleteMany({ where: { restaurantId: { in: ids } } });
  await prisma.restaurant.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  const residualCount = await prisma.restaurant.count({ where: { code: { startsWith: "TEST__P3_" } } });
  expect(residualCount).toBe(0);
});

let restaurantCounter = 0;
async function createTestRestaurant() {
  restaurantCounter += 1;
  return prisma.restaurant.create({
    data: {
      name: `TEST__Phase3 Fixture ${restaurantCounter}`,
      code: `TEST__P3_${Date.now()}_${restaurantCounter}_${Math.random().toString(36).slice(2, 8)}`,
      notes: "Synthetic fixture for automated Phase 3 integration tests only — not a real client.",
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

function amountTriple(amount: string): { expectedAmount: string; actualAmount: string; difference: string } {
  return { expectedAmount: "1000.00", actualAmount: (1000 - Number(amount)).toFixed(2), difference: amount };
}

async function createConfirmedOrderCase(
  restaurantId: string,
  aggregatorId: string,
  actorId: string,
  opts: { orderRef: string; amount: string; settlementDate?: Date; status?: ClassificationStatus; isSuperseded?: boolean },
) {
  const { expectedAmount, actualAmount, difference } = amountTriple(opts.amount);
  const reconciliationCase = await prisma.reconciliationCase.create({
    data: {
      restaurantId,
      aggregatorId,
      scope: ReconciliationScope.ORDER_LEVEL,
      orderRef: opts.orderRef,
      expectedAmount,
      actualAmount,
      difference,
      calculationStatus: "CALCULATED",
      calculationFormulaVersion: "v1",
      calculationBreakdown: {},
      status: opts.status ?? ClassificationStatus.CONFIRMED_DISCREPANCY,
      isSuperseded: opts.isSuperseded ?? false,
      createdByActorId: actorId,
    },
  });
  if (opts.settlementDate) {
    const settlement = await prisma.settlementRecord.create({
      data: { restaurantId, aggregatorId, date: opts.settlementDate, amount: "0.00", orderRef: opts.orderRef },
    });
    await prisma.caseRecordLink.create({ data: { caseId: reconciliationCase.id, settlementRecordId: settlement.id } });
  }
  return reconciliationCase;
}

async function createConfirmedBankCase(
  restaurantId: string,
  aggregatorId: string,
  actorId: string,
  opts: { periodStart: Date; periodEnd: Date; amount: string },
) {
  const { expectedAmount, actualAmount, difference } = amountTriple(opts.amount);
  return prisma.reconciliationCase.create({
    data: {
      restaurantId,
      aggregatorId,
      scope: ReconciliationScope.BANK_CYCLE,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
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

const AUG_START = new Date("2026-08-01T00:00:00.000Z");
const AUG_END = new Date("2026-08-31T23:59:59.999Z");
const AUG_MID = new Date("2026-08-15T00:00:00.000Z");
const SEP_MID = new Date("2026-09-15T00:00:00.000Z");

describe("case eligibility", () => {
  it("links an ORDER_LEVEL Confirmed Discrepancy item", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-1", amount: "100.00" });

    const result = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const links = await prisma.recoveryCaseReconciliationLink.findMany({ where: { recoveryCaseId: result.recoveryCaseId } });
    expect(links).toHaveLength(1);
    expect(links[0].reconciliationCaseId).toBe(order.id);
  });

  it("links a BANK_CYCLE Confirmed Discrepancy item", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });

    const result = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [bank.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a non-Confirmed-Discrepancy item", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, {
      orderRef: "ORD-2",
      amount: "100.00",
      status: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
    });

    const result = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(false);
    const links = await prisma.recoveryCaseReconciliationLink.findMany({ where: { reconciliationCaseId: order.id } });
    expect(links).toHaveLength(0);
  });

  it("rejects a superseded item", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-3", amount: "100.00", isSuperseded: true });

    const result = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a restaurant mismatch", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurantA = trackRestaurant((await createTestRestaurant()).id);
    const restaurantB = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurantA, swiggy.id, systemActor.id, { orderRef: "ORD-MISMATCH", amount: "100.00" });

    const result = await createRecoveryCase({
      restaurantId: restaurantB,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an aggregator mismatch", async () => {
    const { swiggy, zomato, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-AGGMISMATCH", amount: "100.00" });

    const result = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: zomato.id,
      reconciliationCaseIds: [order.id],
      actorId: systemActor.id,
    });

    expect(result.ok).toBe(false);
  });
});

describe("one-open-case constraint", () => {
  it("rejects linking a discrepancy already in another open recovery case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-4", amount: "100.00" });

    const first = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(first.ok).toBe(true);

    const second = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(second.ok).toBe(false);
  });

  it("allows re-linking a discrepancy once its prior recovery case is closed", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-RELINK", amount: "100.00" });

    const first = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Force the case through its lifecycle to CLOSED: generate + send a report, then record a response.
    const report = await generateFindingsReport({ recoveryCaseId: first.recoveryCaseId, actorId: systemActor.id });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    await recordClientResponse({ recoveryCaseId: first.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED });

    const closedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: first.recoveryCaseId } });
    expect(closedCase.status).toBe(RecoveryCaseStatus.CLOSED);

    const second = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(second.ok).toBe(true);
  }, 15000);

  it("serializes a concurrent attachment race so only one recovery case wins the discrepancy", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-RACE", amount: "100.00" });

    const [a, b] = await Promise.all([
      createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id }),
      createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    // Track whichever recovery case(s) actually got created so cleanup catches them.
    for (const r of [a, b]) {
      if (r.ok) {
        const rc = await prisma.recoveryCase.findUnique({ where: { id: r.recoveryCaseId } });
        if (rc) trackRestaurant(rc.restaurantId);
      }
    }

    const activeLinks = await prisma.recoveryCaseReconciliationLink.findMany({ where: { reconciliationCaseId: order.id, releasedAt: null } });
    expect(activeLinks).toHaveLength(1);
  });
});

describe("evidence pack readiness", () => {
  it("is not required for an order-only recovery case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-5", amount: "100.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const readiness = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(readiness.bankCreditEvidenceApplicable).toBe(false);
    expect(readiness.missingCategoryCodes).not.toContain("BankCreditEvidence");
  });

  it("is required once >=1 BANK_CYCLE item is linked, and readiness reflects presence", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [bank.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const beforeAny = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(beforeAny.bankCreditEvidenceApplicable).toBe(true);
    expect(beforeAny.missingCategoryCodes).toContain("BankCreditEvidence");
    expect(beforeAny.ready).toBe(false);

    const categories = await prisma.evidenceCategory.findMany({ where: { active: true } });
    for (const category of categories) {
      await setEvidenceItem({ recoveryCaseId: created.recoveryCaseId, categoryCode: category.code, reference: "doc", actorId: systemActor.id });
    }

    const afterAll = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(afterAll.ready).toBe(true);
    expect(afterAll.missingCategoryCodes).toHaveLength(0);
  }, 15000);

  it("never presents automatic quality judgment — presence alone is sufficient", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-QUALITY", amount: "100.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A single-character, clearly non-persuasive note still counts as "present" — the gate is deterministic presence only.
    await setEvidenceItem({ recoveryCaseId: created.recoveryCaseId, categoryCode: "FactualNarrative", note: "x", actorId: systemActor.id });
    const readiness = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(readiness.missingCategoryCodes).not.toContain("FactualNarrative");
  });
});

describe("confirmed total and overlap guard", () => {
  it("blocks the total pending overlap review, then includes it once reviewed with a note", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-OVERLAP", amount: "150.00", settlementDate: AUG_MID });
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });

    const created = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id, bank.id],
      actorId: systemActor.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const beforeReview = await computeConfirmedTotal(created.recoveryCaseId);
    expect(beforeReview.hasUnresolvedOverlap).toBe(true);
    expect(beforeReview.includedTotal).toBe("0.00");
    expect(beforeReview.blockedAmount).toBe("650.00");

    const rejectedReview = await recordOverlapReview({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, reviewed: true, note: "" });
    expect(rejectedReview.ok).toBe(false);

    const accepted = await recordOverlapReview({
      recoveryCaseId: created.recoveryCaseId,
      actorId: systemActor.id,
      reviewed: true,
      note: "Confirmed both amounts are independent — the order shortfall is a separate deduction not reflected in the bank credit.",
    });
    expect(accepted.ok).toBe(true);

    const afterReview = await computeConfirmedTotal(created.recoveryCaseId);
    expect(afterReview.hasUnresolvedOverlap).toBe(false);
    expect(afterReview.includedTotal).toBe("650.00");
    expect(afterReview.blockedAmount).toBe("0.00");

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId: created.recoveryCaseId, kind: "OVERLAP_REVIEWED" } });
    expect(events).toHaveLength(1);
  });

  it("does not block when items don't actually overlap by period", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-NOOVERLAP", amount: "150.00", settlementDate: SEP_MID });
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });

    const created = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id, bank.id],
      actorId: systemActor.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const total = await computeConfirmedTotal(created.recoveryCaseId);
    expect(total.hasUnresolvedOverlap).toBe(false);
    expect(total.includedTotal).toBe("650.00");
  });

  it("detects overlap against another concurrently open recovery case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-CROSS", amount: "150.00", settlementDate: AUG_MID });
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });

    const orderCase = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    const bankCase = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [bank.id], actorId: systemActor.id });
    expect(orderCase.ok).toBe(true);
    expect(bankCase.ok).toBe(true);
    if (!orderCase.ok || !bankCase.ok) return;

    const orderTotal = await computeConfirmedTotal(orderCase.recoveryCaseId);
    const bankTotal = await computeConfirmedTotal(bankCase.recoveryCaseId);

    expect(orderTotal.hasUnresolvedOverlap).toBe(true);
    expect(orderTotal.includedTotal).toBe("0.00");
    expect(orderTotal.lineItems[0].overlapsWithRecoveryCaseId).toBe(bankCase.recoveryCaseId);

    expect(bankTotal.hasUnresolvedOverlap).toBe(true);
    expect(bankTotal.includedTotal).toBe("0.00");
    expect(bankTotal.lineItems[0].overlapsWithRecoveryCaseId).toBe(orderCase.recoveryCaseId);
  });

  it("excludes a linked item that was reclassified away from Confirmed Discrepancy after linking", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-RECLASS", amount: "150.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await prisma.reconciliationCase.update({ where: { id: order.id }, data: { status: ClassificationStatus.REQUIRES_HUMAN_REVIEW } });

    const total = await computeConfirmedTotal(created.recoveryCaseId);
    expect(total.includedTotal).toBe("0.00");
    expect(total.lineItems[0].currentlyEligible).toBe(false);
    expect(total.lineItems[0].ineligibleReason).toMatch(/Reclassified/);
  });
});

describe("findings report", () => {
  it("versions reports without ever overwriting a prior version", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-VERSION", amount: "200.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const v1 = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.version).toBe(1);

    const v2 = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.version).toBe(2);

    const reports = await prisma.findingsReport.findMany({ where: { recoveryCaseId: created.recoveryCaseId }, orderBy: { version: "asc" } });
    expect(reports).toHaveLength(2);
    expect(reports[0].id).not.toBe(reports[1].id);
    // The original v1 row is untouched — its own generatedAt/content still exists as its own row.
    expect(reports[0].version).toBe(1);
    expect(reports[1].version).toBe(2);
  }, 15000);

  it("never presents a blocked/unreviewed overlap amount as part of the confirmed total in generated content", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-REPORT-OVERLAP", amount: "150.00", settlementDate: AUG_MID });
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });
    const created = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [order.id, bank.id],
      actorId: systemActor.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const stored = await prisma.findingsReport.findUniqueOrThrow({ where: { id: report.reportId } });
    const content = stored.content as { confirmedDiscrepancyTotal: string; unresolvedPendingAmount: string; hasUnresolvedOverlap: boolean };
    expect(content.confirmedDiscrepancyTotal).toBe("0.00");
    expect(content.unresolvedPendingAmount).toBe("650.00");
    expect(content.hasUnresolvedOverlap).toBe(true);
  });

  it("requires a channel note to mark a report as sent, and moves an OPEN case to REPORT_SENT on first send", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-SEND", amount: "200.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const rejected = await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "" });
    expect(rejected.ok).toBe(false);

    const sent = await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "Emailed to owner" });
    expect(sent.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    expect(updatedCase.status).toBe(RecoveryCaseStatus.REPORT_SENT);
    expect(updatedCase.reportSentAt).not.toBeNull();
  });
});

describe("client response", () => {
  it("persists status/date/reference and closes the case on a Declined response", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-CLIENTRESP", amount: "200.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const beforeReport = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED });
    expect(beforeReport.ok).toBe(false); // no report sent yet

    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) return;
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });

    const result = await recordClientResponse({
      recoveryCaseId: created.recoveryCaseId,
      actorId: systemActor.id,
      status: ClientResponseStatus.DECLINED,
      note: "Owner declined via phone call on 6 Sep.",
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    expect(updatedCase.clientResponseStatus).toBe(ClientResponseStatus.DECLINED);
    expect(updatedCase.clientResponseDate).not.toBeNull();
    expect(updatedCase.clientResponseNote).toBe("Owner declined via phone call on 6 Sep.");
    expect(updatedCase.status).toBe(RecoveryCaseStatus.CLOSED);
    expect(updatedCase.closedAt).not.toBeNull();

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId: created.recoveryCaseId, kind: "CLIENT_RESPONSE_RECORDED" } });
    expect(events).toHaveLength(1);
  });

  it("records an Approved response but deliberately leaves the case open for Phase 4 dispute submission", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-APPROVED-STAYS-OPEN", amount: "200.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) return;
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });

    const result = await recordClientResponse({
      recoveryCaseId: created.recoveryCaseId,
      actorId: systemActor.id,
      status: ClientResponseStatus.APPROVED,
      note: "Owner confirmed via phone call on 6 Sep.",
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: created.recoveryCaseId } });
    expect(updatedCase.clientResponseStatus).toBe(ClientResponseStatus.APPROVED);
    expect(updatedCase.status).not.toBe(RecoveryCaseStatus.CLOSED);
    expect(updatedCase.closedAt).toBeNull();
  });

  it("keeps a closed case's own confirmed total, linked items, and bank-evidence applicability intact even though its links are released for reuse elsewhere", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const bank = await createConfirmedBankCase(restaurant, swiggy.id, systemActor.id, { periodStart: AUG_START, periodEnd: AUG_END, amount: "500.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [bank.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const readinessBeforeClose = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(readinessBeforeClose.bankCreditEvidenceApplicable).toBe(true);

    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) return;
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED });

    // The discrepancy's link is now released (releasedAt set) so it can join
    // a future recovery case — but THIS case's own view of what it included
    // must not change just because the underlying lock was released.
    const totalAfterClose = await computeConfirmedTotal(created.recoveryCaseId);
    expect(totalAfterClose.lineItems).toHaveLength(1);
    expect(totalAfterClose.includedTotal).toBe("500.00");

    const readinessAfterClose = await computeEvidenceReadiness(created.recoveryCaseId);
    expect(readinessAfterClose.bankCreditEvidenceApplicable).toBe(true);
    expect(readinessAfterClose.missingCategoryCodes).toContain("BankCreditEvidence");

    // And the discrepancy really is free again for a brand new case.
    const relinked = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [bank.id], actorId: systemActor.id });
    expect(relinked.ok).toBe(true);
  }, 20000);
});

describe("lifecycle and audit history", () => {
  it("records an accurate append-only event for every case-affecting action", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-AUDIT", amount: "200.00" });
    const order2 = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-AUDIT-2", amount: "100.00" });
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await prisma.$transaction((tx) => linkDiscrepancyToOpenCase(tx, { recoveryCaseId: created.recoveryCaseId, reconciliationCaseId: order2.id, actorId: systemActor.id }));
    await prisma.$transaction((tx) => unlinkDiscrepancy(tx, { recoveryCaseId: created.recoveryCaseId, reconciliationCaseId: order2.id, actorId: systemActor.id }));
    await setEvidenceItem({ recoveryCaseId: created.recoveryCaseId, categoryCode: "FactualNarrative", note: "Clean narrative, no accusations.", actorId: systemActor.id });
    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) return;
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED });

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId: created.recoveryCaseId }, orderBy: { createdAt: "asc" } });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "CASE_CREATED",
      "DISCREPANCY_LINKED",
      "DISCREPANCY_UNLINKED",
      "EVIDENCE_ITEM_ADDED",
      "REPORT_GENERATED",
      "STATUS_CHANGED",
      "REPORT_MARKED_SENT",
      "CLIENT_RESPONSE_RECORDED",
      "STATUS_CHANGED",
    ]);
    for (const event of events) {
      expect(event.actorId).toBe(systemActor.id);
      expect(event.createdAt).toBeInstanceOf(Date);
    }
  }, 15000);

  it("removes an unlinked item from the case's own confirmed total immediately, unlike a close-time release", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const orderKeep = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-KEEP", amount: "200.00" });
    const orderRemove = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "ORD-REMOVE", amount: "100.00" });
    const created = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [orderKeep.id, orderRemove.id],
      actorId: systemActor.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const beforeUnlink = await computeConfirmedTotal(created.recoveryCaseId);
    expect(beforeUnlink.includedTotal).toBe("300.00");

    const unlinkResult = await prisma.$transaction((tx) =>
      unlinkDiscrepancy(tx, { recoveryCaseId: created.recoveryCaseId, reconciliationCaseId: orderRemove.id, actorId: systemActor.id }),
    );
    expect(unlinkResult.ok).toBe(true);

    const afterUnlink = await computeConfirmedTotal(created.recoveryCaseId);
    expect(afterUnlink.includedTotal).toBe("200.00");
    expect(afterUnlink.lineItems.map((i) => i.reconciliationCaseId)).not.toContain(orderRemove.id);

    // Unlike a close-time release, the unlinked item is immediately free —
    // no need to wait for this case to close.
    const otherCase = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [orderRemove.id], actorId: systemActor.id });
    expect(otherCase.ok).toBe(true);
  });
});

describe("synthetic regression fixture (Case -> Evidence -> Findings -> Client Response, not real customer data)", () => {
  it("reproduces a complete recovery-case workflow with known-correct expected values", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);

    const orderA = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "REG-ORDER-A", amount: "300.00", settlementDate: SEP_MID });
    const orderB = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, { orderRef: "REG-ORDER-B", amount: "150.00", settlementDate: SEP_MID });

    const created = await createRecoveryCase({
      restaurantId: restaurant,
      aggregatorId: swiggy.id,
      reconciliationCaseIds: [orderA.id, orderB.id],
      actorId: systemActor.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const recoveryCaseId = created.recoveryCaseId;

    // 300 + 150 = 450, no overlap (no bank-cycle item linked).
    const totalAfterCreate = await computeConfirmedTotal(recoveryCaseId);
    expect(totalAfterCreate.includedTotal).toBe("450.00");
    expect(totalAfterCreate.hasUnresolvedOverlap).toBe(false);

    const readinessBeforeEvidence = await computeEvidenceReadiness(recoveryCaseId);
    expect(readinessBeforeEvidence.ready).toBe(false);
    expect(readinessBeforeEvidence.bankCreditEvidenceApplicable).toBe(false);

    const nonBankCategories = ["ExpectedVsActualCalculation", "ContractOrRateCardReference", "SettlementReportLineCopy", "PosRecordCopy", "FactualNarrative"];
    for (const code of nonBankCategories) {
      const result = await setEvidenceItem({ recoveryCaseId, categoryCode: code, reference: "REG-DOC", note: "Synthetic regression evidence.", actorId: systemActor.id });
      expect(result.ok).toBe(true);
    }

    const readinessAfterEvidence = await computeEvidenceReadiness(recoveryCaseId);
    expect(readinessAfterEvidence.ready).toBe(true);

    const report = await generateFindingsReport({ recoveryCaseId, actorId: systemActor.id });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.version).toBe(1);

    const storedReport = await prisma.findingsReport.findUniqueOrThrow({ where: { id: report.reportId } });
    const content = storedReport.content as { confirmedDiscrepancyTotal: string; evidenceReady: boolean };
    expect(content.confirmedDiscrepancyTotal).toBe("450.00");
    expect(content.evidenceReady).toBe(true);

    const sendResult = await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "Emailed to restaurant owner, 6 Sep 2026" });
    expect(sendResult.ok).toBe(true);

    const afterSend = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(afterSend.status).toBe(RecoveryCaseStatus.REPORT_SENT);

    const responseResult = await recordClientResponse({
      recoveryCaseId,
      actorId: systemActor.id,
      status: ClientResponseStatus.APPROVED,
      note: "Restaurant owner approved both line items over a call.",
    });
    expect(responseResult.ok).toBe(true);

    const finalCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    // An Approved response deliberately does NOT close the case (Phase 4
    // extension) — it stays open so a dispute can be submitted against it.
    expect(finalCase.status).not.toBe(RecoveryCaseStatus.CLOSED);
    expect(finalCase.clientResponseStatus).toBe(ClientResponseStatus.APPROVED);
    expect(finalCase.closedAt).toBeNull();

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId } });
    expect(events.length).toBeGreaterThanOrEqual(7); // created, 2x evidence-neutral... at least created+5 evidence+generated+sent+status+response
  }, 20000);
});

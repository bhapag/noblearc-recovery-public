// Integration tests against the real Postgres database (DATABASE_URL).
// Every row created here is deleted in an afterEach block, verified with a
// zero-residue check at the end of the suite. All restaurants/records are
// clearly-synthetic fixtures created for this test file only — never real
// client data, and this suite is a synthetic regression, never a claim of
// real aggregator validation.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ClassificationStatus,
  ClientResponseStatus,
  DeadlineConfidence,
  DisputeOutcome,
  ReconciliationScope,
  RecoveryCaseStatus,
  SubmissionChannel,
} from "@/generated/prisma/enums";
import type { Aggregator, Actor } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createRecoveryCase } from "@/lib/recovery/create-recovery-case";
import { generateFindingsReport, markReportSent } from "@/lib/recovery/findings-report";
import { recordClientResponse } from "@/lib/recovery/client-response";
import { setEvidenceItem } from "@/lib/recovery/evidence";
import { computeConfirmedTotal } from "@/lib/recovery/confirmed-total";
import { createDisputeSubmission } from "./create-submission";
import { setVerifiedDeadline } from "./set-verified-deadline";
import { addFollowUp } from "./follow-up";
import { recordDisposition } from "./disposition";
import { buildDeadlineView, computeDaysRemaining, computeIsOverdue } from "./deadline";

const createdRestaurantIds: string[] = [];
function trackRestaurant(id: string): string {
  createdRestaurantIds.push(id);
  return id;
}

const createdPolicyIds: string[] = [];
function trackPolicy(id: string): string {
  createdPolicyIds.push(id);
  return id;
}

afterEach(async () => {
  if (createdRestaurantIds.length > 0) {
    const ids = [...createdRestaurantIds];
    createdRestaurantIds.length = 0;

    const recoveryCases = await prisma.recoveryCase.findMany({ where: { restaurantId: { in: ids } }, select: { id: true } });
    const recoveryCaseIds = recoveryCases.map((r) => r.id);
    if (recoveryCaseIds.length > 0) {
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
    await prisma.restaurant.deleteMany({ where: { id: { in: ids } } });
  }

  if (createdPolicyIds.length > 0) {
    const ids = [...createdPolicyIds];
    createdPolicyIds.length = 0;
    await prisma.disputeSubmission.updateMany({ where: { assumptionPolicyId: { in: ids } }, data: { assumptionPolicyId: null } });
    await prisma.deadlineAssumptionPolicy.deleteMany({ where: { id: { in: ids } } });
  }
});

afterAll(async () => {
  const residualCount = await prisma.restaurant.count({ where: { code: { startsWith: "TEST__P4_" } } });
  expect(residualCount).toBe(0);
  const residualPolicies = await prisma.deadlineAssumptionPolicy.count({ where: { sourceNote: { startsWith: "TEST__P4_" } } });
  expect(residualPolicies).toBe(0);
});

let restaurantCounter = 0;
async function createTestRestaurant() {
  restaurantCounter += 1;
  return prisma.restaurant.create({
    data: {
      name: `TEST__Phase4 Fixture ${restaurantCounter}`,
      code: `TEST__P4_${Date.now()}_${restaurantCounter}_${Math.random().toString(36).slice(2, 8)}`,
      notes: "Synthetic fixture for automated Phase 4 integration tests only — not a real client.",
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

/** Builds a fully client-approved RecoveryCase — the exact starting point Phase 4 operates on. */
async function createApprovedCase(
  aggregator: Aggregator,
  systemActor: Actor,
  orderRef: string,
  amount: string,
): Promise<{ recoveryCaseId: string; restaurantId: string }> {
  const restaurant = trackRestaurant((await createTestRestaurant()).id);
  const order = await createConfirmedOrderCase(restaurant, aggregator.id, systemActor.id, orderRef, amount);
  const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: aggregator.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
  if (!created.ok) throw new Error(`fixture setup failed: ${created.message}`);
  const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
  if (!report.ok) throw new Error(`fixture setup failed: ${report.message}`);
  await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
  const response = await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.APPROVED });
  if (!response.ok) throw new Error(`fixture setup failed: ${response.message}`);
  return { recoveryCaseId: created.recoveryCaseId, restaurantId: restaurant };
}

async function createTestPolicy(aggregatorId: string, defaultDays: number): Promise<string> {
  const policy = await prisma.deadlineAssumptionPolicy.create({
    data: {
      aggregatorId,
      category: "TEST__synthetic category",
      defaultDays,
      sourceNote: "TEST__P4_synthetic-only assumption, not a real platform deadline",
    },
  });
  return trackPolicy(policy.id);
}

describe("A. submission eligibility", () => {
  it("accepts a submission for an approved, client-approved RecoveryCase", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-A-OK", "100.00");

    const result = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.AGGREGATOR_PORTAL,
      submittedAt: new Date(),
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);
  }, 20000);

  it("rejects a submission for a case still Awaiting client response", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, "ORD-A-AWAITING", "100.00");
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    if (!created.ok) throw new Error(created.message);

    const result = await createDisputeSubmission({
      recoveryCaseId: created.recoveryCaseId,
      channel: SubmissionChannel.EMAIL,
      submittedAt: new Date(),
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a submission for a closed (Declined) case", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const restaurant = trackRestaurant((await createTestRestaurant()).id);
    const order = await createConfirmedOrderCase(restaurant, swiggy.id, systemActor.id, "ORD-A-DECLINED", "100.00");
    const created = await createRecoveryCase({ restaurantId: restaurant, aggregatorId: swiggy.id, reconciliationCaseIds: [order.id], actorId: systemActor.id });
    if (!created.ok) throw new Error(created.message);
    const report = await generateFindingsReport({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id });
    if (!report.ok) throw new Error(report.message);
    await markReportSent({ reportId: report.reportId, actorId: systemActor.id, sentVia: "test" });
    await recordClientResponse({ recoveryCaseId: created.recoveryCaseId, actorId: systemActor.id, status: ClientResponseStatus.DECLINED });

    const result = await createDisputeSubmission({
      recoveryCaseId: created.recoveryCaseId,
      channel: SubmissionChannel.EMAIL,
      submittedAt: new Date(),
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(false);
  });
});

describe("B. one-active-submission invariant", () => {
  it("rejects a second directly-inserted active row at the database constraint level", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-B-DBCONSTRAINT", "100.00");

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "dispute_submissions"
            ("id","recoveryCaseId","channel","submittedAt","evidenceSnapshot","isActive","createdByActorId","updatedAt")
          VALUES
            (${randomUUID()}::uuid, ${recoveryCaseId}::uuid, 'EMAIL'::"SubmissionChannel", now(), '{}'::jsonb, true, ${systemActor.id}::uuid, now())
        `;
        await tx.$executeRaw`
          INSERT INTO "dispute_submissions"
            ("id","recoveryCaseId","channel","submittedAt","evidenceSnapshot","isActive","createdByActorId","updatedAt")
          VALUES
            (${randomUUID()}::uuid, ${recoveryCaseId}::uuid, 'EMAIL'::"SubmissionChannel", now(), '{}'::jsonb, true, ${systemActor.id}::uuid, now())
        `;
      }),
    ).rejects.toThrow();
  });

  it("serializes two concurrent submission attempts so exactly one active row survives", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-B-RACE", "100.00");

    const [a, b] = await Promise.all([
      createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id }),
      createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.EMAIL, submittedAt: new Date(), actorId: systemActor.id }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const submissions = await prisma.disputeSubmission.findMany({ where: { recoveryCaseId } });
    expect(submissions).toHaveLength(2);
    expect(submissions.filter((s) => s.isActive)).toHaveLength(1);
    expect(submissions.filter((s) => !s.isActive)).toHaveLength(1);
  }, 20000);
});

describe("C. resubmission", () => {
  it("preserves history: the prior attempt is superseded (not mutated), and its follow-ups stay attached to it", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-C-RESUBMIT", "100.00");

    const first = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!first.ok) throw new Error(first.message);

    const followUp = await addFollowUp({
      disputeSubmissionId: first.disputeSubmissionId,
      occurredAt: new Date(),
      channel: SubmissionChannel.OFFICIAL_SUPPORT,
      summary: "First attempt follow-up",
      actorId: systemActor.id,
    });
    expect(followUp.ok).toBe(true);

    const second = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.EMAIL,
      ticketOrReferenceNumber: "REF-2",
      submittedAt: new Date(),
      actorId: systemActor.id,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.disputeSubmissionId).not.toBe(first.disputeSubmissionId);

    const firstAfter = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: first.disputeSubmissionId }, include: { followUps: true } });
    expect(firstAfter.isActive).toBe(false);
    expect(firstAfter.supersededAt).not.toBeNull();
    expect(firstAfter.supersededByActorId).toBe(systemActor.id);
    expect(firstAfter.followUps).toHaveLength(1);
    expect(firstAfter.followUps[0].summary).toBe("First attempt follow-up");

    const secondAfter = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: second.disputeSubmissionId }, include: { followUps: true } });
    expect(secondAfter.isActive).toBe(true);
    expect(secondAfter.followUps).toHaveLength(0);
  }, 20000);

  it("rejects resubmission once the active attempt already has a recorded disposition", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-C-TERMINAL", "100.00");
    const first = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!first.ok) throw new Error(first.message);
    await recordDisposition({
      disputeSubmissionId: first.disputeSubmissionId,
      outcome: DisputeOutcome.ACCEPTED,
      decidedAt: new Date(),
      evidenceNote: "Aggregator accepted in full.",
      actorId: systemActor.id,
    });

    const second = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.EMAIL, submittedAt: new Date(), actorId: systemActor.id });
    expect(second.ok).toBe(false);
  }, 20000);
});

describe("D. deadline model", () => {
  it("is honest with no applicable policy: no working assumption, no effective deadline", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-D-NOPOLICY", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const row = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: submitted.disputeSubmissionId } });
    const view = buildDeadlineView(row);
    expect(view.workingAssumptionDeadline).toBeNull();
    expect(view.verifiedDeadline).toBeNull();
    expect(view.effectiveDeadline).toBeNull();
    expect(view.daysRemaining).toBeNull();
    expect(view.isOverdue).toBe(false);
    expect(view.deadlineConfidence).toBe(DeadlineConfidence.UNKNOWN);
  }, 20000);

  it("applies a working assumption at ASSUMED_DEFAULT confidence and never auto-upgrades it", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-D-ASSUMED", "100.00");
    const policyId = await createTestPolicy(swiggy.id, 21);
    const submittedAt = new Date("2026-09-01T00:00:00.000Z");

    const submitted = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.AGGREGATOR_PORTAL,
      submittedAt,
      assumptionPolicyId: policyId,
      actorId: systemActor.id,
    });
    if (!submitted.ok) throw new Error(submitted.message);

    const row = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: submitted.disputeSubmissionId } });
    expect(row.deadlineConfidence).toBe(DeadlineConfidence.ASSUMED_DEFAULT);
    expect(row.workingAssumptionDeadline?.toISOString()).toBe(new Date("2026-09-22T00:00:00.000Z").toISOString());
    expect(row.verifiedDeadline).toBeNull();

    const view = buildDeadlineView(row);
    expect(view.effectiveDeadline).toBe(view.workingAssumptionDeadline);
  }, 20000);

  it("lets a verified deadline override the assumption, requires a source, and restricts confidence to VERIFIED_* values", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-D-VERIFIED", "100.00");
    const policyId = await createTestPolicy(swiggy.id, 21);
    const submitted = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.AGGREGATOR_PORTAL,
      submittedAt: new Date("2026-09-01T00:00:00.000Z"),
      assumptionPolicyId: policyId,
      actorId: systemActor.id,
    });
    if (!submitted.ok) throw new Error(submitted.message);

    const rejectedNoSource = await setVerifiedDeadline({
      disputeSubmissionId: submitted.disputeSubmissionId,
      verifiedDeadline: new Date("2026-09-15T00:00:00.000Z"),
      deadlineSourceEvidence: "",
      deadlineConfidence: DeadlineConfidence.VERIFIED_PLATFORM_POLICY,
      actorId: systemActor.id,
    });
    expect(rejectedNoSource.ok).toBe(false);

    const rejectedBadConfidence = await setVerifiedDeadline({
      disputeSubmissionId: submitted.disputeSubmissionId,
      verifiedDeadline: new Date("2026-09-15T00:00:00.000Z"),
      deadlineSourceEvidence: "Signed vendor agreement clause 4.2",
      deadlineConfidence: DeadlineConfidence.ASSUMED_DEFAULT,
      actorId: systemActor.id,
    });
    expect(rejectedBadConfidence.ok).toBe(false);

    const verified = await setVerifiedDeadline({
      disputeSubmissionId: submitted.disputeSubmissionId,
      verifiedDeadline: new Date("2026-09-15T00:00:00.000Z"),
      deadlineSourceEvidence: "Signed vendor agreement clause 4.2",
      deadlineConfidence: DeadlineConfidence.VERIFIED_CONTRACT,
      actorId: systemActor.id,
    });
    expect(verified.ok).toBe(true);

    const row = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: submitted.disputeSubmissionId } });
    expect(row.deadlineConfidence).toBe(DeadlineConfidence.VERIFIED_CONTRACT);
    const view = buildDeadlineView(row);
    // The verified deadline (Sep 15) overrides the working assumption (Sep 22).
    expect(view.effectiveDeadline).toBe(new Date("2026-09-15T00:00:00.000Z").toISOString());
  }, 20000);

  it("computes days-remaining and overdue purely as arithmetic on the effective deadline", () => {
    const asOf = new Date("2026-09-10T00:00:00.000Z");
    const future = new Date("2026-09-15T00:00:00.000Z");
    const past = new Date("2026-09-01T00:00:00.000Z");

    expect(computeDaysRemaining(future, asOf)).toBe(5);
    expect(computeIsOverdue(future, asOf)).toBe(false);
    expect(computeDaysRemaining(past, asOf)).toBe(-9);
    expect(computeIsOverdue(past, asOf)).toBe(true);
    expect(computeDaysRemaining(null, asOf)).toBeNull();
    expect(computeIsOverdue(null, asOf)).toBe(false);
  });
});

describe("E. evidence snapshot immutability", () => {
  it("freezes the findings report version, content, and evidence items at submission time", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-E-SNAPSHOT", "100.00");

    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const before = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: submitted.disputeSubmissionId } });
    const snapshotBefore = before.evidenceSnapshot as { findingsReportVersion: number; evidenceItemsAtSubmission: unknown[]; findingsReportContent: Record<string, unknown> };
    expect(snapshotBefore.findingsReportVersion).toBe(1);
    expect(snapshotBefore.evidenceItemsAtSubmission).toHaveLength(0);

    // Mutate the live evidence pack after submission.
    await setEvidenceItem({ recoveryCaseId, categoryCode: "FactualNarrative", note: "Added after submission — must not leak into the frozen snapshot.", actorId: systemActor.id });

    // Generate a brand-new findings report version after submission.
    const newReport = await generateFindingsReport({ recoveryCaseId, actorId: systemActor.id });
    expect(newReport.ok).toBe(true);
    if (newReport.ok) expect(newReport.version).toBe(2);

    // Also touch other case-level data after submission.
    await prisma.recoveryCase.update({ where: { id: recoveryCaseId }, data: { clientResponseNote: "Mutated after submission." } });

    const after = await prisma.disputeSubmission.findUniqueOrThrow({ where: { id: submitted.disputeSubmissionId } });
    const snapshotAfter = after.evidenceSnapshot as typeof snapshotBefore;
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(snapshotAfter.findingsReportVersion).toBe(1);
    expect(snapshotAfter.evidenceItemsAtSubmission).toHaveLength(0);
  }, 20000);
});

describe("F. follow-ups", () => {
  it("attaches follow-ups only to the currently-active submission and preserves them append-only", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-F-FOLLOWUPS", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const rejectedEmpty = await addFollowUp({
      disputeSubmissionId: submitted.disputeSubmissionId,
      occurredAt: new Date(),
      channel: SubmissionChannel.EMAIL,
      summary: "   ",
      actorId: systemActor.id,
    });
    expect(rejectedEmpty.ok).toBe(false);

    const first = await addFollowUp({
      disputeSubmissionId: submitted.disputeSubmissionId,
      occurredAt: new Date("2026-09-05T00:00:00.000Z"),
      channel: SubmissionChannel.EMAIL,
      summary: "Sent proof of delivery.",
      actorId: systemActor.id,
    });
    expect(first.ok).toBe(true);
    const second = await addFollowUp({
      disputeSubmissionId: submitted.disputeSubmissionId,
      occurredAt: new Date("2026-09-08T00:00:00.000Z"),
      channel: SubmissionChannel.OFFICIAL_SUPPORT,
      summary: "Called support, asked for update.",
      aggregatorResponse: "Escalated to specialist team.",
      actorId: systemActor.id,
    });
    expect(second.ok).toBe(true);

    const entries = await prisma.followUpEntry.findMany({ where: { disputeSubmissionId: submitted.disputeSubmissionId }, orderBy: { occurredAt: "asc" } });
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe("Sent proof of delivery.");
    expect(entries[1].aggregatorResponse).toBe("Escalated to specialist team.");
  }, 20000);

  it("rejects a follow-up on a superseded submission and on one that already has a disposition", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-F-BLOCKED", "100.00");
    const first = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!first.ok) throw new Error(first.message);
    const second = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.EMAIL, submittedAt: new Date(), actorId: systemActor.id });
    if (!second.ok) throw new Error(second.message);

    const onSuperseded = await addFollowUp({
      disputeSubmissionId: first.disputeSubmissionId,
      occurredAt: new Date(),
      channel: SubmissionChannel.EMAIL,
      summary: "Should not be allowed.",
      actorId: systemActor.id,
    });
    expect(onSuperseded.ok).toBe(false);

    await recordDisposition({
      disputeSubmissionId: second.disputeSubmissionId,
      outcome: DisputeOutcome.UNRESOLVED,
      decidedAt: new Date(),
      evidenceNote: "No response after repeated attempts; exhausted.",
      actorId: systemActor.id,
    });

    const onDecided = await addFollowUp({
      disputeSubmissionId: second.disputeSubmissionId,
      occurredAt: new Date(),
      channel: SubmissionChannel.EMAIL,
      summary: "Should not be allowed either.",
      actorId: systemActor.id,
    });
    expect(onDecided.ok).toBe(false);
  }, 20000);
});

describe("G. disposition", () => {
  it("keeps the RecoveryCase open on Accepted and requires a human evidence note", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-G-ACCEPTED", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const rejected = await recordDisposition({ disputeSubmissionId: submitted.disputeSubmissionId, outcome: DisputeOutcome.ACCEPTED, decidedAt: new Date(), evidenceNote: "", actorId: systemActor.id });
    expect(rejected.ok).toBe(false);

    const result = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.ACCEPTED,
      decidedAt: new Date(),
      evidenceNote: "Aggregator portal shows claim accepted in full, screenshot on file.",
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updatedCase.status).not.toBe(RecoveryCaseStatus.CLOSED);
    expect(updatedCase.closedAt).toBeNull();
  }, 20000);

  it("keeps the RecoveryCase open on Partially Accepted", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-G-PARTIAL", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const result = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.PARTIALLY_ACCEPTED,
      decidedAt: new Date(),
      evidenceNote: "Aggregator accepted 60 of the claim per their portal.",
      aggregatorStatedAmount: "60.00",
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updatedCase.status).not.toBe(RecoveryCaseStatus.CLOSED);
  }, 20000);

  it("closes the RecoveryCase on Rejected", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-G-REJECTED", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const result = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.REJECTED,
      decidedAt: new Date(),
      evidenceNote: "Aggregator rejected the claim citing policy 4.1.",
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updatedCase.status).toBe(RecoveryCaseStatus.CLOSED);
    expect(updatedCase.closedAt).not.toBeNull();
  }, 20000);

  it("closes the RecoveryCase on an explicitly human-recorded Unresolved outcome, never automatically", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-G-UNRESOLVED", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    // Time passing alone must never produce a disposition — only an explicit call does.
    const stillNoDisposition = await prisma.disputeDisposition.findUnique({ where: { disputeSubmissionId: submitted.disputeSubmissionId } });
    expect(stillNoDisposition).toBeNull();

    const result = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.UNRESOLVED,
      decidedAt: new Date(),
      evidenceNote: "No response after 3 follow-ups over 6 weeks; treating as exhausted.",
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);

    const updatedCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(updatedCase.status).toBe(RecoveryCaseStatus.CLOSED);
  }, 20000);

  it("rejects a second disposition on the same submission", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-G-DOUBLE", "100.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const first = await recordDisposition({ disputeSubmissionId: submitted.disputeSubmissionId, outcome: DisputeOutcome.ACCEPTED, decidedAt: new Date(), evidenceNote: "Accepted.", actorId: systemActor.id });
    expect(first.ok).toBe(true);

    const second = await recordDisposition({ disputeSubmissionId: submitted.disputeSubmissionId, outcome: DisputeOutcome.REJECTED, decidedAt: new Date(), evidenceNote: "Trying to overwrite.", actorId: systemActor.id });
    expect(second.ok).toBe(false);
  }, 20000);
});

describe("H. financial boundary — disposition is never recovery", () => {
  it("never creates any recovered-amount, success-fee, or invoice record, and never affects the confirmed total", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-H-BOUNDARY", "250.00");
    const submitted = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.AGGREGATOR_PORTAL, submittedAt: new Date(), actorId: systemActor.id });
    if (!submitted.ok) throw new Error(submitted.message);

    const totalBefore = await computeConfirmedTotal(recoveryCaseId);

    const result = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.PARTIALLY_ACCEPTED,
      decidedAt: new Date(),
      evidenceNote: "Aggregator states 150 accepted.",
      aggregatorStatedAmount: "150.00",
      actorId: systemActor.id,
    });
    expect(result.ok).toBe(true);

    const disposition = await prisma.disputeDisposition.findUniqueOrThrow({ where: { disputeSubmissionId: submitted.disputeSubmissionId } });
    const fieldNames = Object.keys(disposition);
    for (const forbidden of ["recoveredAmount", "amountRecovered", "successFee", "invoiceId", "invoiceAmount", "paymentReceived"]) {
      expect(fieldNames).not.toContain(forbidden);
    }
    expect(disposition.aggregatorStatedAmount?.toString()).toBe("150");

    // No Phase 4 code path recomputes the confirmed total from a disposition —
    // it must be exactly what it was before disposition was recorded.
    const totalAfter = await computeConfirmedTotal(recoveryCaseId);
    expect(totalAfter.includedTotal).toBe(totalBefore.includedTotal);

    // No recovery/success-fee/invoice model exists in the schema at all —
    // these delegates are `undefined` on the Prisma client, not empty tables.
    expect((prisma as unknown as Record<string, unknown>).invoice).toBeUndefined();
    expect((prisma as unknown as Record<string, unknown>).successFee).toBeUndefined();
    expect((prisma as unknown as Record<string, unknown>).recoveredAmount).toBeUndefined();
  }, 20000);
});

describe("I. audit", () => {
  it("records an accurate append-only event for every material dispute action", async () => {
    const { swiggy, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(swiggy, systemActor, "ORD-I-AUDIT", "100.00");
    const policyId = await createTestPolicy(swiggy.id, 14);

    const first = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.AGGREGATOR_PORTAL,
      submittedAt: new Date(),
      assumptionPolicyId: policyId,
      actorId: systemActor.id,
    });
    if (!first.ok) throw new Error(first.message);

    await setVerifiedDeadline({
      disputeSubmissionId: first.disputeSubmissionId,
      verifiedDeadline: new Date("2026-10-01T00:00:00.000Z"),
      deadlineSourceEvidence: "Platform policy doc v3",
      deadlineConfidence: DeadlineConfidence.VERIFIED_PLATFORM_POLICY,
      actorId: systemActor.id,
    });

    await addFollowUp({
      disputeSubmissionId: first.disputeSubmissionId,
      occurredAt: new Date(),
      channel: SubmissionChannel.EMAIL,
      summary: "Chased for update.",
      actorId: systemActor.id,
    });

    const second = await createDisputeSubmission({ recoveryCaseId, channel: SubmissionChannel.EMAIL, submittedAt: new Date(), actorId: systemActor.id });
    if (!second.ok) throw new Error(second.message);

    await recordDisposition({
      disputeSubmissionId: second.disputeSubmissionId,
      outcome: DisputeOutcome.REJECTED,
      decidedAt: new Date(),
      evidenceNote: "Final rejection received.",
      actorId: systemActor.id,
    });

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId }, orderBy: { createdAt: "asc" } });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("DISPUTE_SUBMISSION_CREATED");
    expect(kinds).toContain("VERIFIED_DEADLINE_SET");
    expect(kinds).toContain("FOLLOW_UP_ADDED");
    expect(kinds).toContain("DISPUTE_SUBMISSION_SUPERSEDED");
    expect(kinds).toContain("DISPOSITION_RECORDED");
    expect(kinds).toContain("STATUS_CHANGED");
    expect(kinds.filter((k) => k === "DISPUTE_SUBMISSION_CREATED")).toHaveLength(2);
    for (const event of events) {
      expect(event.actorId).toBe(systemActor.id);
    }
  }, 20000);
});

describe("J. synthetic end-to-end regression (not real aggregator validation)", () => {
  it("reproduces Approved RecoveryCase -> Submission -> Follow-up(s) -> Disposition with known-correct expected state", async () => {
    const { zomato, systemActor } = await getFixtures();
    const { recoveryCaseId } = await createApprovedCase(zomato, systemActor, "REG-P4-E2E", "180.00");

    const submitted = await createDisputeSubmission({
      recoveryCaseId,
      channel: SubmissionChannel.AGGREGATOR_PORTAL,
      ticketOrReferenceNumber: "ZM-TICKET-001",
      submittedAt: new Date("2026-09-06T10:00:00.000Z"),
      actorId: systemActor.id,
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const followUp1 = await addFollowUp({
      disputeSubmissionId: submitted.disputeSubmissionId,
      occurredAt: new Date("2026-09-13T10:00:00.000Z"),
      channel: SubmissionChannel.OFFICIAL_SUPPORT,
      summary: "First check-in, no update yet.",
      nextAction: "Follow up again in a week.",
      actorId: systemActor.id,
    });
    expect(followUp1.ok).toBe(true);

    const followUp2 = await addFollowUp({
      disputeSubmissionId: submitted.disputeSubmissionId,
      occurredAt: new Date("2026-09-20T10:00:00.000Z"),
      channel: SubmissionChannel.OFFICIAL_SUPPORT,
      summary: "Aggregator says under review by finance team.",
      aggregatorResponse: "Under review, 5-7 more business days.",
      actorId: systemActor.id,
    });
    expect(followUp2.ok).toBe(true);

    const disposition = await recordDisposition({
      disputeSubmissionId: submitted.disputeSubmissionId,
      outcome: DisputeOutcome.ACCEPTED,
      decidedAt: new Date("2026-09-27T10:00:00.000Z"),
      evidenceNote: "Aggregator portal marked claim as accepted in full; confirmation screenshot on file.",
      actorId: systemActor.id,
    });
    expect(disposition.ok).toBe(true);

    const finalCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } });
    expect(finalCase.status).not.toBe(RecoveryCaseStatus.CLOSED);

    const finalSubmission = await prisma.disputeSubmission.findUniqueOrThrow({
      where: { id: submitted.disputeSubmissionId },
      include: { followUps: { orderBy: { occurredAt: "asc" } }, disposition: true },
    });
    expect(finalSubmission.isActive).toBe(true);
    expect(finalSubmission.followUps).toHaveLength(2);
    expect(finalSubmission.disposition?.outcome).toBe(DisputeOutcome.ACCEPTED);

    const events = await prisma.recoveryCaseEvent.findMany({ where: { recoveryCaseId } });
    expect(events.length).toBeGreaterThanOrEqual(5);
  }, 20000);
});

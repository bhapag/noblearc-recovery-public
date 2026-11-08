// Integration test against the real Postgres database (DATABASE_URL). Every
// write happens inside a transaction that is deliberately rolled back at the
// end, so this test leaves zero residue in what may become the real
// operating database. Requires `prisma db seed` to have run first (needs the
// system Actor and Aggregator reference rows).
import { describe, expect, it } from "vitest";
import { CalculationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { prisma } from "./prisma";
import { computeDifference, toMoney } from "./money";

class IntentionalRollback extends Error {}

// Phase 2 added several required, non-defaulted columns to ReconciliationCase
// (scope, calculationStatus, calculationFormulaVersion, calculationBreakdown).
// These tests predate that and only care about the Phase 0 CHECK constraints
// below, so the values here are minimal placeholders, not real calculations.
const MINIMAL_CASE_FIELDS = {
  scope: ReconciliationScope.ORDER_LEVEL,
  calculationStatus: CalculationStatus.CALCULATED,
  calculationFormulaVersion: "v1",
  calculationBreakdown: { note: "Phase 0 CHECK-constraint test fixture, not a real calculation." },
};

describe("database round-trip (rolled back)", () => {
  it("creates a ReconciliationCase with the correct default status and difference", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const aggregator = await tx.aggregator.findUniqueOrThrow({
          where: { slug: "swiggy" },
        });
        const systemActor = await tx.actor.findFirstOrThrow({
          where: { isSystem: true },
        });

        const restaurant = await tx.restaurant.create({
          data: {
            name: "TEST__Verification Restaurant",
            code: `TEST__${Date.now()}`,
          },
        });

        const expected = toMoney("1000.00");
        const actual = toMoney("850.00");
        const difference = computeDifference(expected, actual);

        const reconciliationCase = await tx.reconciliationCase.create({
          data: {
            ...MINIMAL_CASE_FIELDS,
            restaurantId: restaurant.id,
            aggregatorId: aggregator.id,
            expectedAmount: expected.toString(),
            actualAmount: actual.toString(),
            difference: difference.toString(),
            createdByActorId: systemActor.id,
          },
        });

        expect(reconciliationCase.status).toBe("UNCLASSIFIED");
        expect(reconciliationCase.difference?.toString()).toBe("150");

        throw new IntentionalRollback();
      }),
    ).rejects.toThrow(IntentionalRollback);
  });

  it("rejects a ReconciliationCase whose difference does not equal expected - actual", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const aggregator = await tx.aggregator.findUniqueOrThrow({
          where: { slug: "zomato" },
        });
        const systemActor = await tx.actor.findFirstOrThrow({
          where: { isSystem: true },
        });
        const restaurant = await tx.restaurant.create({
          data: {
            name: "TEST__Bad Difference Restaurant",
            code: `TEST__${Date.now()}_bad`,
          },
        });

        // Wrong on purpose: difference should be 150, not 999.
        await tx.reconciliationCase.create({
          data: {
            ...MINIMAL_CASE_FIELDS,
            restaurantId: restaurant.id,
            aggregatorId: aggregator.id,
            expectedAmount: "1000.00",
            actualAmount: "850.00",
            difference: "999.00",
            createdByActorId: systemActor.id,
          },
        });
      }),
    ).rejects.toThrow(/reconciliation_cases_difference_check/);
  });

  it("rejects a ReconciliationCase with a non-null difference but a null expected/actual amount", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const aggregator = await tx.aggregator.findUniqueOrThrow({
          where: { slug: "other" },
        });
        const systemActor = await tx.actor.findFirstOrThrow({
          where: { isSystem: true },
        });
        const restaurant = await tx.restaurant.create({
          data: {
            name: "TEST__Independent Nullability Restaurant",
            code: `TEST__${Date.now()}_nullability`,
          },
        });

        // Wrong on purpose: expectedAmount is null (Phase 2's UNMATCHED/
        // INSUFFICIENT_DATA shape) but difference is set anyway — Postgres
        // CHECK constraints pass on NULL, so the Phase 0-era constraint
        // would have silently accepted this; the Phase 2 replacement must not.
        await tx.reconciliationCase.create({
          data: {
            ...MINIMAL_CASE_FIELDS,
            calculationStatus: CalculationStatus.UNMATCHED,
            restaurantId: restaurant.id,
            aggregatorId: aggregator.id,
            expectedAmount: null,
            actualAmount: "850.00",
            difference: "150.00",
            createdByActorId: systemActor.id,
          },
        });
      }),
    ).rejects.toThrow(/reconciliation_cases_difference_check/);
  });

  it("rejects a CaseRecordLink with zero or multiple record FKs set", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const aggregator = await tx.aggregator.findUniqueOrThrow({
          where: { slug: "other" },
        });
        const systemActor = await tx.actor.findFirstOrThrow({
          where: { isSystem: true },
        });
        const restaurant = await tx.restaurant.create({
          data: {
            name: "TEST__CaseRecordLink Restaurant",
            code: `TEST__${Date.now()}_link`,
          },
        });
        const reconciliationCase = await tx.reconciliationCase.create({
          data: {
            ...MINIMAL_CASE_FIELDS,
            restaurantId: restaurant.id,
            aggregatorId: aggregator.id,
            expectedAmount: "100.00",
            actualAmount: "100.00",
            difference: "0.00",
            createdByActorId: systemActor.id,
          },
        });

        // Wrong on purpose: no record FK set at all.
        await tx.caseRecordLink.create({
          data: { caseId: reconciliationCase.id },
        });
      }),
    ).rejects.toThrow(/case_record_links_exactly_one_record_check/);
  });
});

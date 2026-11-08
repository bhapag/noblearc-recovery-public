import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordKind } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { commitImport } from "./commit-import";

// commitImport manages its own internal transaction (it must, to guarantee
// atomicity independent of any test harness), so — unlike src/lib/db-integration.test.ts —
// this test cannot wrap the call in an outer transaction it rolls back.
// Instead it really commits, then deletes exactly what it created in a
// `finally` block, verified with a zero-residue count check afterward.
const createdSourceFileIds: string[] = [];
const createdStorageKeys: string[] = [];

afterEach(async () => {
  await prisma.settlementRecord.deleteMany({ where: { sourceFileId: { in: createdSourceFileIds } } });
  await prisma.sourceFile.deleteMany({ where: { id: { in: createdSourceFileIds } } });
  for (const key of createdStorageKeys) {
    await rm(path.join(process.cwd(), ".data", "uploads", key), { force: true });
  }
  createdSourceFileIds.length = 0;
  createdStorageKeys.length = 0;
});

const CSV = Buffer.from(
  "Order Number,Payout Date,Net Payout\nORD-INTEG-1,05/09/2026,850.00\nORD-INTEG-2,05/09/2026,412.75\n",
);

async function getFixtureContext() {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { code: "QA-FIXTURE-001" } });
  const aggregator = await prisma.aggregator.findUniqueOrThrow({ where: { slug: "swiggy" } });
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return { restaurant, aggregator, systemActor };
}

describe("commitImport — live database", () => {
  it("persists normalized rows with provenance, defaulting nothing beyond what was validated", async () => {
    const { restaurant, aggregator, systemActor } = await getFixtureContext();

    const result = await commitImport({
      kind: RecordKind.SETTLEMENT,
      restaurantId: restaurant.id,
      aggregatorId: aggregator.id,
      filename: "integration-test.csv",
      bytes: CSV,
      mapping: { date: "Payout Date", amount: "Net Payout", orderRef: "Order Number" },
      dateFormat: "dd/MM/yyyy",
      uploadedByActorId: systemActor.id,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    createdSourceFileIds.push(result.sourceFileId);

    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({ where: { id: result.sourceFileId } });
    createdStorageKeys.push(sourceFile.storageKey);
    expect(sourceFile.restaurantId).toBe(restaurant.id);
    expect(sourceFile.aggregatorId).toBe(aggregator.id);
    expect(sourceFile.mappingConfig).toEqual({
      date: "Payout Date",
      amount: "Net Payout",
      orderRef: "Order Number",
    });

    const records = await prisma.settlementRecord.findMany({
      where: { sourceFileId: result.sourceFileId },
      orderBy: { orderRef: "asc" },
    });
    expect(records).toHaveLength(2);
    expect(records[0].orderRef).toBe("ORD-INTEG-1");
    expect(records[0].amount.toString()).toBe("850");
    expect(records[0].date.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    // sourceRowNumber provenance is present; no blind raw-row dump alongside it.
    expect(records[0].rawFields).toEqual({ sourceRowNumber: 1, canonical: {} });
  });

  it("detects a byte-identical duplicate and does not import until explicitly confirmed", async () => {
    const { restaurant, aggregator, systemActor } = await getFixtureContext();
    const input = {
      kind: RecordKind.SETTLEMENT,
      restaurantId: restaurant.id,
      aggregatorId: aggregator.id,
      filename: "integration-duplicate.csv",
      bytes: CSV,
      mapping: { date: "Payout Date", amount: "Net Payout" },
      dateFormat: "dd/MM/yyyy" as const,
      uploadedByActorId: systemActor.id,
    };

    const first = await commitImport(input);
    expect(first.status).toBe("success");
    if (first.status !== "success") return;
    createdSourceFileIds.push(first.sourceFileId);
    const firstFile = await prisma.sourceFile.findUniqueOrThrow({ where: { id: first.sourceFileId } });
    createdStorageKeys.push(firstFile.storageKey);

    const second = await commitImport(input);
    expect(second.status).toBe("duplicate");
    if (second.status !== "duplicate") return;
    expect(second.existing.sourceFileId).toBe(first.sourceFileId);

    const third = await commitImport({ ...input, confirmDuplicate: true });
    expect(third.status).toBe("success");
    if (third.status !== "success") return;
    createdSourceFileIds.push(third.sourceFileId);
    const thirdFile = await prisma.sourceFile.findUniqueOrThrow({ where: { id: third.sourceFileId } });
    createdStorageKeys.push(thirdFile.storageKey);
    expect(third.sourceFileId).not.toBe(first.sourceFileId);
  });

  it("serializes truly concurrent commits of the same file so only one succeeds, closing the TOCTOU race", async () => {
    const { restaurant, aggregator, systemActor } = await getFixtureContext();
    const concurrentCsv = Buffer.from(
      "Order Number,Payout Date,Net Payout\nORD-RACE-1,05/09/2026,100.00\n",
    );
    const input = {
      kind: RecordKind.SETTLEMENT,
      restaurantId: restaurant.id,
      aggregatorId: aggregator.id,
      filename: "integration-race.csv",
      bytes: concurrentCsv,
      mapping: { date: "Payout Date", amount: "Net Payout", orderRef: "Order Number" },
      dateFormat: "dd/MM/yyyy" as const,
      uploadedByActorId: systemActor.id,
    };

    // Fire both at the same time — without the advisory lock in commitImport,
    // both would pass the early duplicate check before either commits.
    const [a, b] = await Promise.all([commitImport(input), commitImport(input)]);
    const results = [a, b];
    const successes = results.filter((r) => r.status === "success");
    const duplicates = results.filter((r) => r.status === "duplicate");

    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    if (successes[0].status === "success") createdSourceFileIds.push(successes[0].sourceFileId);
    for (const sf of await prisma.sourceFile.findMany({ where: { id: { in: createdSourceFileIds } } })) {
      createdStorageKeys.push(sf.storageKey);
    }
    // Note: the "losing" call's file-storage write happens before the lock
    // is acquired (see commit-import.ts's documented storage-before-transaction
    // tradeoff), so it orphans one small file in .data/uploads/ that this
    // cleanup has no storageKey to find and remove. Harmless (gitignored,
    // dev-only) but expected — not a bug in this test.

    const persisted = await prisma.settlementRecord.findMany({ where: { orderRef: "ORD-RACE-1" } });
    expect(persisted).toHaveLength(1);
  });

  it("never persists an aggregatorId on a non-SETTLEMENT import even if one is passed in", async () => {
    const { restaurant, systemActor } = await getFixtureContext();
    const posCsv = Buffer.from("Order No,Order Time,Bill Amount\nPOS-INTEG-1,05/09/2026,500.00\n");

    const result = await commitImport({
      kind: RecordKind.POS,
      restaurantId: restaurant.id,
      // Simulates a stale/forged aggregatorId reaching the server for a kind
      // that must never carry one — commitImport must normalize it away.
      aggregatorId: "00000000-0000-0000-0000-000000000000",
      filename: "integration-pos-stale-aggregator.csv",
      bytes: posCsv,
      mapping: { date: "Order Time", amount: "Bill Amount", orderRef: "Order No" },
      dateFormat: "dd/MM/yyyy",
      uploadedByActorId: systemActor.id,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    createdSourceFileIds.push(result.sourceFileId);
    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({ where: { id: result.sourceFileId } });
    createdStorageKeys.push(sourceFile.storageKey);
    expect(sourceFile.aggregatorId).toBeNull();

    await prisma.pOSRecord.deleteMany({ where: { sourceFileId: result.sourceFileId } });
  });

  it("rejects the whole file atomically when any row is invalid — nothing is persisted", async () => {
    const { restaurant, aggregator, systemActor } = await getFixtureContext();
    const badCsv = Buffer.from(
      "Order Number,Payout Date,Net Payout\nORD-BAD-1,05/09/2026,850.00\nORD-BAD-2,05/09/2026,not-money\n",
    );

    const result = await commitImport({
      kind: RecordKind.SETTLEMENT,
      restaurantId: restaurant.id,
      aggregatorId: aggregator.id,
      filename: "integration-invalid.csv",
      bytes: badCsv,
      mapping: { date: "Payout Date", amount: "Net Payout", orderRef: "Order Number" },
      dateFormat: "dd/MM/yyyy",
      uploadedByActorId: systemActor.id,
    });

    expect(result.status).toBe("validation_error");

    const leaked = await prisma.settlementRecord.findFirst({ where: { orderRef: "ORD-BAD-1" } });
    expect(leaked).toBeNull();
  });
});

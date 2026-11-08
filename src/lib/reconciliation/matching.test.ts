import { describe, expect, it } from "vitest";
import type { POSRecord, SettlementRecord } from "@/generated/prisma/client";
import { matchSettlementsToPos } from "./matching";

// matchSettlementsToPos only reads orderRef/aggregatorId off these records —
// these fixtures fill in just enough shape to stand in for the real Prisma
// types in a pure unit test (no database involved).
let counter = 0;
function settlement(orderRef: string | null, aggregatorId = "agg-swiggy"): SettlementRecord {
  counter += 1;
  return { id: `settlement-${counter}`, orderRef, aggregatorId } as unknown as SettlementRecord;
}
function pos(orderRef: string | null): POSRecord {
  counter += 1;
  return { id: `pos-${counter}`, orderRef } as unknown as POSRecord;
}

describe("matchSettlementsToPos", () => {
  it("matches a settlement and POS record sharing an exact orderRef", () => {
    const s = settlement("ORD-1");
    const p = pos("ORD-1");

    const result = matchSettlementsToPos([s], [p]);

    expect(result.matched).toEqual([{ settlement: s, pos: p }]);
    expect(result.unmatchedSettlements).toHaveLength(0);
    expect(result.unmatchedPos).toHaveLength(0);
    expect(result.ambiguousOrderRefs).toHaveLength(0);
  });

  it("trims whitespace before comparing orderRefs", () => {
    const s = settlement("  ORD-2  ");
    const p = pos("ORD-2");

    const result = matchSettlementsToPos([s], [p]);

    expect(result.matched).toHaveLength(1);
  });

  it("leaves a settlement with no POS counterpart unmatched", () => {
    const s = settlement("ORD-3");

    const result = matchSettlementsToPos([s], []);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedSettlements).toEqual([s]);
  });

  it("leaves a POS record with no settlement counterpart unmatched", () => {
    const p = pos("ORD-4");

    const result = matchSettlementsToPos([], [p]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedPos).toEqual([p]);
  });

  it("treats records with no orderRef at all as permanently unmatched, never grouped together", () => {
    const s1 = settlement(null);
    const s2 = settlement("");
    const p1 = pos(null);

    const result = matchSettlementsToPos([s1, s2], [p1]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedSettlements).toEqual(expect.arrayContaining([s1, s2]));
    expect(result.unmatchedPos).toEqual([p1]);
    expect(result.ambiguousOrderRefs).toHaveLength(0);
  });

  it("treats a POS orderRef claimed by settlements from more than one aggregator as ambiguous, not guessed", () => {
    const swiggySettlement = settlement("ORD-5", "agg-swiggy");
    const zomatoSettlement = settlement("ORD-5", "agg-zomato");
    const p = pos("ORD-5");

    const result = matchSettlementsToPos([swiggySettlement, zomatoSettlement], [p]);

    expect(result.matched).toHaveLength(0);
    expect(result.ambiguousOrderRefs).toEqual(["ORD-5"]);
    expect(result.unmatchedSettlements).toEqual(expect.arrayContaining([swiggySettlement, zomatoSettlement]));
    expect(result.unmatchedPos).toEqual([p]);
  });

  it("treats duplicate settlement rows sharing one orderRef (e.g. correction lines) as ambiguous, not paired off", () => {
    const s1 = settlement("ORD-6");
    const s2 = settlement("ORD-6");
    const p = pos("ORD-6");

    const result = matchSettlementsToPos([s1, s2], [p]);

    expect(result.matched).toHaveLength(0);
    expect(result.ambiguousOrderRefs).toEqual(["ORD-6"]);
  });

  it("treats duplicate POS rows sharing one orderRef as ambiguous, not paired off", () => {
    const s = settlement("ORD-7");
    const p1 = pos("ORD-7");
    const p2 = pos("ORD-7");

    const result = matchSettlementsToPos([s], [p1, p2]);

    expect(result.matched).toHaveLength(0);
    expect(result.ambiguousOrderRefs).toEqual(["ORD-7"]);
  });

  it("resolves multiple independent orderRefs correctly in the same run", () => {
    const s1 = settlement("ORD-8");
    const p1 = pos("ORD-8");
    const s2 = settlement("ORD-9");

    const result = matchSettlementsToPos([s1, s2], [p1]);

    expect(result.matched).toEqual([{ settlement: s1, pos: p1 }]);
    expect(result.unmatchedSettlements).toEqual([s2]);
  });
});

import { describe, expect, it } from "vitest";
import { toMoney } from "@/lib/money";
import { calculateCancellationOverrideAmount, calculateExpectedAmount } from "./calculation";

describe("calculateExpectedAmount", () => {
  it("computes commission, GST-on-commission, TDS, fixed fee, and adjustment together", () => {
    const outcome = calculateExpectedAmount(toMoney("1000.00"), {
      commissionRatePercent: "20",
      gstRatePercent: "18",
      fixedFeeAmount: "5.00",
      tdsRatePercent: "1",
      adjustmentAmount: "10.00",
      sourceReference: "Contract rate card v3, clause 4.2",
    });

    // commission = 1000 * 20% = 200
    // gst = 200 * 18% = 36
    // tds = 1000 * 1% = 10
    // expected = 1000 - 200 - 36 - 5 - 10 + 10 = 759
    expect(outcome.isCalculated).toBe(true);
    expect(outcome.expectedAmount?.toFixed(2)).toBe("759.00");
    expect(outcome.breakdown.commissionAmount).toBe("200.00");
    expect(outcome.breakdown.gstAmount).toBe("36.00");
    expect(outcome.breakdown.tdsAmount).toBe("10.00");
    expect(outcome.breakdown.sourceReference).toBe("Contract rate card v3, clause 4.2");
  });

  it("omits GST and TDS entirely when their rates are not provided (no invented defaults)", () => {
    const outcome = calculateExpectedAmount(toMoney("1000.00"), {
      commissionRatePercent: "20",
      sourceReference: "Operator-entered assumption for this run",
    });

    expect(outcome.isCalculated).toBe(true);
    expect(outcome.expectedAmount?.toFixed(2)).toBe("800.00");
    expect(outcome.breakdown.gstRatePercent).toBeNull();
    expect(outcome.breakdown.gstAmount).toBeNull();
    expect(outcome.breakdown.tdsRatePercent).toBeNull();
    expect(outcome.breakdown.tdsAmount).toBeNull();
  });

  it("rounds every intermediate component to 2 decimal places using ROUND_HALF_UP", () => {
    const outcome = calculateExpectedAmount(toMoney("100.00"), {
      commissionRatePercent: "33.333",
      sourceReference: "Rate card fixture",
    });

    // 100 * 33.333% = 33.333 -> rounds to 33.33
    expect(outcome.breakdown.commissionAmount).toBe("33.33");
    expect(outcome.expectedAmount?.toFixed(2)).toBe("66.67");
  });

  it("returns isCalculated: false with no invented expectedAmount when no commission rate is provided", () => {
    const outcome = calculateExpectedAmount(toMoney("1000.00"), null);

    expect(outcome.isCalculated).toBe(false);
    expect(outcome.expectedAmount).toBeNull();
    expect(outcome.breakdown.notes).toMatch(/missing commission rate/i);
  });

  it("returns isCalculated: false when rates are provided but commissionRatePercent is absent", () => {
    const outcome = calculateExpectedAmount(toMoney("1000.00"), {
      gstRatePercent: "18",
      sourceReference: "Partial assumption",
    });

    expect(outcome.isCalculated).toBe(false);
    expect(outcome.expectedAmount).toBeNull();
  });

  it("applies a signed negative adjustment as a reduction", () => {
    const outcome = calculateExpectedAmount(toMoney("500.00"), {
      commissionRatePercent: "10",
      adjustmentAmount: "-25.00",
      sourceReference: "Manual correction, evidenced by ticket #42",
    });

    // 500 - 50 (commission) - 25 (adjustment) = 425
    expect(outcome.expectedAmount?.toFixed(2)).toBe("425.00");
  });
});

describe("calculateCancellationOverrideAmount", () => {
  it("sets expectedAmount to exactly the evidenced cancellation fee, bypassing the normal formula", () => {
    const outcome = calculateCancellationOverrideAmount(toMoney("50.00"), "Contract clause 7.1 — cancellation fee schedule");

    expect(outcome.isCalculated).toBe(true);
    expect(outcome.expectedAmount?.toFixed(2)).toBe("50.00");
    expect(outcome.breakdown.cancellationOverrideApplied).toBe(true);
    expect(outcome.breakdown.cancellationFeeAmount).toBe("50.00");
    expect(outcome.breakdown.sourceReference).toBe("Contract clause 7.1 — cancellation fee schedule");
    expect(outcome.breakdown.grossAmount).toBeNull();
    expect(outcome.breakdown.commissionAmount).toBeNull();
  });
});

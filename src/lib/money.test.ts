import { describe, expect, it } from "vitest";
import {
  addMoney,
  computeDifference,
  divideMoney,
  formatINR,
  isZero,
  multiplyMoney,
  percentageOf,
  roundMoney,
  sumMoney,
  subtractMoney,
  toMoney,
} from "./money";

describe("toMoney", () => {
  it("parses strings, numbers, and Decimals", () => {
    expect(toMoney("123.45").toString()).toBe("123.45");
    expect(toMoney(123.45).toString()).toBe("123.45");
    expect(toMoney(toMoney("1")).toString()).toBe("1");
  });

  it("rejects non-finite values", () => {
    expect(() => toMoney(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMoney(Number.NaN)).toThrow(RangeError);
  });
});

describe("addMoney / subtractMoney", () => {
  it("avoids native floating-point precision traps", () => {
    // 0.1 + 0.2 !== 0.3 under native JS number math — Decimal must not repeat this.
    const result = addMoney(toMoney("0.1"), toMoney("0.2"));
    expect(result.toString()).toBe("0.3");
    expect(result.toNumber()).toBe(0.3);
  });

  it("subtracts exactly", () => {
    expect(subtractMoney(toMoney("100.00"), toMoney("33.33")).toString()).toBe(
      "66.67",
    );
  });
});

describe("multiplyMoney / divideMoney / percentageOf", () => {
  it("multiplies and divides exactly", () => {
    expect(multiplyMoney(toMoney("10.50"), toMoney("3")).toString()).toBe("31.5");
    expect(divideMoney(toMoney("100"), toMoney("4")).toString()).toBe("25");
  });

  it("computes a percentage of an amount", () => {
    expect(percentageOf(toMoney("1000.00"), toMoney("18")).toString()).toBe("180");
    expect(roundMoney(percentageOf(toMoney("485.00"), toMoney("18"))).toString()).toBe("87.3");
  });
});

describe("sumMoney", () => {
  it("sums a list exactly, including an empty list", () => {
    expect(sumMoney([]).toString()).toBe("0");
    expect(
      sumMoney([toMoney("10.10"), toMoney("20.20"), toMoney("0.01")]).toString(),
    ).toBe("30.31");
  });
});

describe("roundMoney", () => {
  it("rounds half up (away from zero on an exact half) at the 2-decimal boundary", () => {
    // A native-float implementation of "round half up" often gets this wrong
    // because 2.005 cannot be represented exactly in binary floating point.
    expect(roundMoney(toMoney("2.005")).toString()).toBe("2.01");
    expect(roundMoney(toMoney("2.004")).toString()).toBe("2");
    // ROUND_HALF_UP rounds an exact half away from zero, so this is -2.01, not -2.
    expect(roundMoney(toMoney("-2.005")).toString()).toBe("-2.01");
  });
});

describe("computeDifference (expected - actual sign convention)", () => {
  it("is positive when the restaurant was underpaid (owed money)", () => {
    const diff = computeDifference(toMoney("1000.00"), toMoney("850.00"));
    expect(diff.toString()).toBe("150");
    expect(diff.isPositive()).toBe(true);
  });

  it("is negative when the restaurant was overpaid", () => {
    const diff = computeDifference(toMoney("800.00"), toMoney("950.00"));
    expect(diff.toString()).toBe("-150");
    expect(diff.isNegative()).toBe(true);
  });

  it("is zero when expected equals actual", () => {
    const diff = computeDifference(toMoney("500.00"), toMoney("500.00"));
    expect(isZero(diff)).toBe(true);
  });
});

describe("formatINR", () => {
  it("formats as a rupee currency string", () => {
    // en-IN groups with the Indian numbering system (lakh/crore separators).
    expect(formatINR(toMoney("123456.78"))).toBe("₹1,23,456.78");
    expect(formatINR(toMoney("0"))).toBe("₹0.00");
  });

  it("rounds an unrounded value before formatting", () => {
    expect(formatINR(toMoney("99.995"))).toBe("₹100.00");
  });

  it("refuses to format a magnitude beyond exact double precision", () => {
    expect(() => formatINR(toMoney("100000000000000.00"))).toThrow(RangeError);
  });
});

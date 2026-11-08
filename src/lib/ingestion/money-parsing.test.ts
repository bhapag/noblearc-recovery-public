import { describe, expect, it } from "vitest";
import { parseStrictMoney } from "./money-parsing";

describe("parseStrictMoney", () => {
  it("parses plain decimal amounts", () => {
    expect(parseStrictMoney("850.00")?.toString()).toBe("850");
    expect(parseStrictMoney("12.34")?.toString()).toBe("12.34");
    expect(parseStrictMoney("0")?.toString()).toBe("0");
  });

  it("normalizes comma thousands separators", () => {
    expect(parseStrictMoney("1,234.56")?.toString()).toBe("1234.56");
    expect(parseStrictMoney("12,34,567.89")?.toString()).toBe("1234567.89");
  });

  it("normalizes a leading currency symbol/code", () => {
    expect(parseStrictMoney("₹850.00")?.toString()).toBe("850");
    expect(parseStrictMoney("Rs. 850.00")?.toString()).toBe("850");
    expect(parseStrictMoney("INR 850.00")?.toString()).toBe("850");
  });

  it("treats accounting-style parentheses as negative", () => {
    expect(parseStrictMoney("(150.00)")?.toString()).toBe("-150");
  });

  it("treats a minus sign adjacent to a currency symbol as negative, in either order", () => {
    expect(parseStrictMoney("-₹1,234.00")?.toString()).toBe("-1234");
    expect(parseStrictMoney("₹-1,234.00")?.toString()).toBe("-1234");
    expect(parseStrictMoney("Rs. -500")?.toString()).toBe("-500");
    expect(parseStrictMoney("-500")?.toString()).toBe("-500");
  });

  it("rejects malformed or ambiguous values rather than guessing", () => {
    expect(parseStrictMoney("N/A")).toBeNull();
    expect(parseStrictMoney("")).toBeNull();
    expect(parseStrictMoney("12.34.56")).toBeNull();
    expect(parseStrictMoney("twelve")).toBeNull();
    expect(parseStrictMoney("1e10")).toBeNull();
    expect(parseStrictMoney("(-5)")).toBeNull();
    expect(parseStrictMoney("-₹-5")).toBeNull();
  });
});

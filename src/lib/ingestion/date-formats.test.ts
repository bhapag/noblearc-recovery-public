import { describe, expect, it } from "vitest";
import { parseStrictDate } from "./date-formats";

describe("parseStrictDate", () => {
  it("parses each supported format correctly to ISO", () => {
    expect(parseStrictDate("2026-09-05", "yyyy-MM-dd")).toBe("2026-09-05");
    expect(parseStrictDate("05/09/2026", "dd/MM/yyyy")).toBe("2026-09-05");
    expect(parseStrictDate("09/05/2026", "MM/dd/yyyy")).toBe("2026-09-05");
    expect(parseStrictDate("05-09-2026", "dd-MM-yyyy")).toBe("2026-09-05");
    expect(parseStrictDate("05 Sep 2026", "dd MMM yyyy")).toBe("2026-09-05");
  });

  it("rejects a value that is not date-shaped at all", () => {
    expect(parseStrictDate("not-a-date", "yyyy-MM-dd")).toBeNull();
    expect(parseStrictDate("", "yyyy-MM-dd")).toBeNull();
    expect(parseStrictDate("   ", "yyyy-MM-dd")).toBeNull();
  });

  it("rejects an out-of-range calendar date rather than guessing", () => {
    expect(parseStrictDate("45/13/2026", "dd/MM/yyyy")).toBeNull();
  });

  it("accepts an already-ISO-shaped value regardless of the chosen text format", () => {
    // parse-xlsx.ts converts genuine Excel date-typed cells to ISO strings
    // before this function ever sees them — an ISO value must not be forced
    // through the user's chosen text-date format (which describes the shape
    // of TEXT dates in the file, not native Excel date cells).
    expect(parseStrictDate("2026-09-05", "dd/MM/yyyy")).toBe("2026-09-05");
    expect(parseStrictDate("2026-09-05", "MM/dd/yyyy")).toBe("2026-09-05");
    expect(parseStrictDate("2026-09-05", "dd MMM yyyy")).toBe("2026-09-05");
  });

  it("never falls back to a different interpretation across formats", () => {
    // 05/09/2026 is a valid date under either dd/MM or MM/dd, but the two
    // formats must disagree on which calendar day it means.
    const asDayMonth = parseStrictDate("05/09/2026", "dd/MM/yyyy");
    const asMonthDay = parseStrictDate("05/09/2026", "MM/dd/yyyy");
    expect(asDayMonth).toBe("2026-09-05");
    expect(asMonthDay).toBe("2026-05-09");
    expect(asDayMonth).not.toBe(asMonthDay);
  });
});

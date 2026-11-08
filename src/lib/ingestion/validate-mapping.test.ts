import { describe, expect, it } from "vitest";
import { RecordKind } from "@/generated/prisma/enums";
import { validateMapping } from "./validate-mapping";

const HEADERS = ["Order Number", "Payout Date", "Net Payout", "Extra Column"];

describe("validateMapping", () => {
  it("passes when every required field is mapped to a real column", () => {
    const errors = validateMapping(RecordKind.SETTLEMENT, HEADERS, {
      date: "Payout Date",
      amount: "Net Payout",
    });
    expect(errors).toEqual([]);
  });

  it("reports a missing required field", () => {
    const errors = validateMapping(RecordKind.SETTLEMENT, HEADERS, { date: "Payout Date" });
    expect(errors).toContainEqual(expect.objectContaining({ type: "missing_required", fieldKey: "amount" }));
  });

  it("reports a column mapped to more than one canonical field", () => {
    const errors = validateMapping(RecordKind.SETTLEMENT, HEADERS, {
      date: "Payout Date",
      amount: "Net Payout",
      orderRef: "Net Payout",
    });
    expect(errors).toContainEqual(expect.objectContaining({ type: "duplicate_column", column: "Net Payout" }));
  });

  it("reports a mapped column that does not exist in the file's headers", () => {
    const errors = validateMapping(RecordKind.SETTLEMENT, HEADERS, {
      date: "Payout Date",
      amount: "Column That Does Not Exist",
    });
    expect(errors).toContainEqual(expect.objectContaining({ type: "unknown_column" }));
  });

  it("reports an unknown canonical field key", () => {
    const errors = validateMapping(RecordKind.SETTLEMENT, HEADERS, {
      date: "Payout Date",
      amount: "Net Payout",
      notARealField: "Extra Column",
    });
    expect(errors).toContainEqual(expect.objectContaining({ type: "unknown_field", fieldKey: "notARealField" }));
  });

  it("requires only date and amount for POS and Bank kinds", () => {
    expect(validateMapping(RecordKind.POS, HEADERS, { date: "Payout Date", amount: "Net Payout" })).toEqual([]);
    expect(validateMapping(RecordKind.BANK, HEADERS, { date: "Payout Date", amount: "Net Payout" })).toEqual([]);
  });
});

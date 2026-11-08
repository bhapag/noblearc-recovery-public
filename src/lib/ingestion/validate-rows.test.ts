import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RecordKind } from "@/generated/prisma/enums";
import { parseCsv } from "./parse-csv";
import { validateRows } from "./validate-rows";
import type { ColumnMapping } from "./types";
import { MAX_STRING_FIELD_LENGTH } from "./types";

function fixture(name: string) {
  return parseCsv(readFileSync(path.join(__dirname, "__fixtures__", name)));
}

const FULL_SETTLEMENT_MAPPING: ColumnMapping = {
  date: "Payout Date",
  amount: "Net Payout",
  orderRef: "Order Number",
  grossAmount: "Gross Order Value",
  commission: "Platform Commission",
  gstOnCommission: "GST on Commission",
  fixedFee: "Fixed Fee",
  tds: "TDS Amount",
  discounts: "Promo Discount",
  refundAmount: "Refund Amount",
  settlementCycle: "Cycle Ref",
  orderStatus: "Status",
};

describe("validateRows — settlement, happy path", () => {
  it("normalizes every row with required columns in dedicated fields and optional ones in canonical", () => {
    const parsed = fixture("settlement-standard.csv");
    const { rows, errors } = validateRows(RecordKind.SETTLEMENT, parsed, FULL_SETTLEMENT_MAPPING, "dd/MM/yyyy");

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      sourceRowNumber: 1,
      date: "2026-09-05",
      amount: "850.00",
      orderRef: "ORD-1001",
    });
    expect(rows[0].canonical.commission).toBe("120.00");
    expect(rows[0].canonical.orderStatus).toBe("DELIVERED");
  });

  it("only collects canonical fields that were actually mapped (data minimization)", () => {
    const parsed = fixture("settlement-standard.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows[0].canonical).toEqual({});
    expect(rows[0].orderRef).toBeUndefined();
  });
});

describe("validateRows — reordered and extra columns", () => {
  it("maps correctly regardless of column order", () => {
    const parsed = fixture("settlement-reordered-columns.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout", orderRef: "Order Number" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows[0].orderRef).toBe("ORD-2001");
  });

  it("ignores extra columns that were not mapped to anything", () => {
    const parsed = fixture("settlement-extra-columns.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].canonical).toEqual({});
  });
});

describe("validateRows — malformed money", () => {
  it("reports every unparseable amount with its row number and rejects those rows", () => {
    const parsed = fixture("settlement-malformed-money.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout" },
      "dd/MM/yyyy",
    );
    // Row 1 (ORD-5001) is valid; rows 2-4 have bad/blank amounts.
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.rowNumber).sort()).toEqual([2, 3, 4]);
    expect(errors[0].field).toBe("Net settlement amount");
  });
});

describe("validateRows — ambiguous / invalid dates", () => {
  it("rejects rows whose date cannot be parsed in the chosen format", () => {
    const parsed = fixture("settlement-ambiguous-date.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout" },
      "dd/MM/yyyy",
    );
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.reason.includes("date"))).toBe(true);
  });
});

describe("validateRows — missing required column entirely", () => {
  it("produces no normalized rows and a clear error when a required field's column is absent", () => {
    // validateMapping would already catch this before validateRows runs in
    // commitImport — but validateRows itself must degrade safely rather than
    // crash if called with a mapping pointing at a nonexistent column.
    const parsed = fixture("settlement-missing-required.csv");
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Nonexistent Date Column", amount: "Nonexistent Amount Column" },
      "dd/MM/yyyy",
    );
    expect(rows).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateRows — blank row counting", () => {
  it("counts rows blank across every mapped column instead of silently dropping them", () => {
    const parsed = parseCsv(
      Buffer.from("Order Number,Payout Date,Net Payout\nORD-8001,05/09/2026,850.00\n,,\nORD-8002,05/09/2026,412.75\n"),
    );
    const { rows, errors, skippedBlankRowCount } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout", orderRef: "Order Number" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(skippedBlankRowCount).toBe(1);
  });
});

describe("validateRows — string field length cap", () => {
  it("rejects an optional string field value beyond the max length instead of accepting it into rawFields unbounded", () => {
    const overlong = "x".repeat(MAX_STRING_FIELD_LENGTH + 1);
    const parsed = parseCsv(Buffer.from(`Order Number,Payout Date,Net Payout,Status\nORD-9001,05/09/2026,850.00,${overlong}\n`));
    const { rows, errors } = validateRows(
      RecordKind.SETTLEMENT,
      parsed,
      { date: "Payout Date", amount: "Net Payout", orderStatus: "Status" },
      "dd/MM/yyyy",
    );
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("character limit");
  });
});

describe("validateRows — POS and Bank kinds", () => {
  it("normalizes a POS file", () => {
    const parsed = fixture("pos-standard.csv");
    const { rows, errors } = validateRows(
      RecordKind.POS,
      parsed,
      { date: "Order Time", amount: "Bill Amount", orderRef: "Order No", orderStatus: "Status" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0].canonical.orderStatus).toBe("COMPLETED");
  });

  it("normalizes a Bank file", () => {
    const parsed = fixture("bank-standard.csv");
    const { rows, errors } = validateRows(
      RecordKind.BANK,
      parsed,
      { date: "Value Date", amount: "Credit Amount", reference: "Narration" },
      "dd/MM/yyyy",
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].reference).toBe("NEFT SETTLEMENT CYC-38");
  });
});

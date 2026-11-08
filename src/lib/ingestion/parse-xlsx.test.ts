import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXlsx } from "./parse-xlsx";
import { FileParseError } from "./parse-csv";

function fixture(name: string): Buffer {
  return readFileSync(path.join(__dirname, "__fixtures__", name));
}

describe("parseXlsx", () => {
  it("parses headers and rows, converting a native date cell to ISO", async () => {
    const result = await parseXlsx(fixture("settlement-standard.xlsx"));
    expect(result.headers).toEqual(["Order Number", "Payout Date", "Net Payout"]);
    expect(result.rows).toHaveLength(2);
    const dateIndex = result.headers.indexOf("Payout Date");
    // The fixture writes a genuine Date object for this cell, not text —
    // it must come back as an unambiguous ISO date regardless of any
    // text-date-format setting.
    expect(result.rows[0][dateIndex]).toBe("2026-09-05");
  });

  it("converts a numeric money cell to a plain decimal string", async () => {
    const result = await parseXlsx(fixture("settlement-standard.xlsx"));
    const amountIndex = result.headers.indexOf("Net Payout");
    expect(result.rows[0][amountIndex]).toBe("850");
    expect(result.rows[1][amountIndex]).toBe("412.75");
  });

  it("rejects a file that is not a real XLSX archive", async () => {
    await expect(parseXlsx(Buffer.from("not a zip"))).rejects.toThrow(FileParseError);
  });
});

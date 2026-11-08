import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv, FileParseError } from "./parse-csv";

function fixture(name: string): Buffer {
  return readFileSync(path.join(__dirname, "__fixtures__", name));
}

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const result = parseCsv(fixture("settlement-standard.csv"));
    expect(result.headers).toContain("Order Number");
    expect(result.headers).toContain("Net Payout");
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0][result.headers.indexOf("Order Number")]).toBe("ORD-1001");
  });

  it("handles reordered columns positionally correctly", () => {
    const result = parseCsv(fixture("settlement-reordered-columns.csv"));
    expect(result.headers[0]).toBe("Status");
    const orderIndex = result.headers.indexOf("Order Number");
    expect(result.rows[0][orderIndex]).toBe("ORD-2001");
  });

  it("preserves extra, unmapped-by-anything columns as plain data", () => {
    const result = parseCsv(fixture("settlement-extra-columns.csv"));
    expect(result.headers).toContain("Internal Notes");
    expect(result.headers).toContain("Warehouse Code");
  });

  it("throws FileParseError for a file with no rows", () => {
    expect(() => parseCsv(Buffer.from(""))).toThrow(FileParseError);
  });
});

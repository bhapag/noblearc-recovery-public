import ExcelJS from "exceljs";
import { format as formatDate } from "date-fns";
import { FileParseError } from "./parse-csv";
import type { ParsedFile } from "./types";

/**
 * Converts one exceljs cell value to a plain string.
 *
 * - A native `Date` (a genuinely date-typed Excel cell, not text) becomes an
 *   unambiguous ISO `yyyy-MM-dd` string — Excel dates are stored as serial
 *   numbers, never ambiguous DD/MM-vs-MM/DD text, so there is nothing to
 *   "guess" here. `date-formats.ts` accepts ISO strings outright regardless
 *   of the user's chosen text-date format for exactly this reason.
 * - A formula cell's cached `.result` is used — the formula itself is never
 *   evaluated (exceljs does not execute formulas; this only reads the value
 *   Excel last computed and stored).
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value, "yyyy-MM-dd");
  if (typeof value === "object") {
    if ("result" in value) return cellToString(value.result as ExcelJS.CellValue);
    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("text" in value) return String(value.text);
    return "";
  }
  return String(value);
}

export async function parseXlsx(bytes: Buffer): Promise<ParsedFile> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's own transitive dependency (fast-csv) pulls in @types/node@14,
    // whose older non-generic `Buffer` type conflicts with this project's
    // @types/node@22 `Buffer` at the type level even though both are the
    // same value at runtime — a known cross-package @types/node version
    // mismatch, not a real type error.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new FileParseError(
      `Could not parse file as XLSX: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new FileParseError("The workbook has no worksheets.");
  }

  const allRows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    // exceljs row.values is 1-indexed with index 0 unused — drop it.
    const values = (row.values as ExcelJS.CellValue[]).slice(1);
    allRows.push(values.map(cellToString));
  });

  if (allRows.length === 0) {
    throw new FileParseError("The file has no rows (not even a header row).");
  }

  const [headers, ...rows] = allRows;
  return { headers, rows };
}

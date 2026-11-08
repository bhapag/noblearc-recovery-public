import type { RecordKind } from "@/generated/prisma/enums";
import { roundMoney } from "@/lib/money";
import { getCanonicalFields } from "./canonical-fields";
import { parseStrictDate } from "./date-formats";
import { parseStrictMoney } from "./money-parsing";
import { MAX_STRING_FIELD_LENGTH, type ColumnMapping, type DateFormatKey, type NormalizedRow, type ParsedFile, type RowError } from "./types";

export interface RowValidationResult {
  rows: NormalizedRow[];
  /** Rows blank across every mapped column — skipped, not an error, but counted so it's never a silent gap between totalRowCount and rowsImported. */
  skippedBlankRowCount: number;
  errors: RowError[];
}

/**
 * Parses and validates every row against the chosen mapping — never a
 * sample. Money and dates are never guessed: an unparseable value is
 * reported as a row error, never silently coerced or dropped. A row that
 * fails any field is excluded from `rows` entirely (see commit-import.ts for
 * the whole-file atomicity rule this feeds into): a row is only ever
 * imported in full, or not at all.
 */
export function validateRows(
  kind: RecordKind,
  parsed: ParsedFile,
  mapping: ColumnMapping,
  dateFormat: DateFormatKey,
): RowValidationResult {
  const fields = getCanonicalFields(kind);
  const headerIndex = new Map(parsed.headers.map((header, index) => [header, index]));
  // Only columns that actually exist count toward "is this row blank" — a
  // mapping pointing at a nonexistent column (which validateMapping should
  // already have rejected before this ever runs) must still surface as a
  // per-field error below, not silently mark every row blank and skip it.
  const mappedColumns = Object.values(mapping).filter((column) => headerIndex.has(column));

  const rows: NormalizedRow[] = [];
  const errors: RowError[] = [];
  let skippedBlankRowCount = 0;

  parsed.rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 1;
    const getCell = (column: string): string => {
      const index = headerIndex.get(column);
      if (index === undefined) return "";
      return (row[index] ?? "").trim();
    };

    if (mappedColumns.length > 0 && mappedColumns.every((column) => getCell(column) === "")) {
      skippedBlankRowCount += 1;
      return; // Entirely blank row (across every mapped column) — not an error, just skipped.
    }

    let date: string | undefined;
    let amount: string | undefined;
    let orderRef: string | undefined;
    let reference: string | undefined;
    const canonical: Record<string, string> = {};
    let rowHasError = false;

    for (const field of fields) {
      const column = mapping[field.key];
      if (!column) continue; // Field not mapped for this file at all.
      const rawValue = getCell(column);

      if (!rawValue) {
        if (field.required) {
          errors.push({ rowNumber: sourceRowNumber, field: field.label, value: "", reason: "Required value is missing." });
          rowHasError = true;
        }
        continue;
      }

      if (field.dataType === "date") {
        const parsedDate = parseStrictDate(rawValue, dateFormat);
        if (parsedDate === null) {
          errors.push({
            rowNumber: sourceRowNumber,
            field: field.label,
            value: rawValue,
            reason: `Could not parse as a date in the selected format (${dateFormat}).`,
          });
          rowHasError = true;
          continue;
        }
        if (field.target.kind === "column" && field.target.column === "date") date = parsedDate;
        continue;
      }

      if (field.dataType === "money") {
        const parsedMoney = parseStrictMoney(rawValue);
        if (parsedMoney === null) {
          errors.push({
            rowNumber: sourceRowNumber,
            field: field.label,
            value: rawValue,
            reason: "Could not parse as a valid monetary amount.",
          });
          rowHasError = true;
          continue;
        }
        // roundMoney is the single documented source of truth for the app's
        // rounding mode — never round money ad hoc with a raw Decimal call.
        const moneyString = roundMoney(parsedMoney).toFixed(2);
        if (field.target.kind === "column" && field.target.column === "amount") amount = moneyString;
        else if (field.target.kind === "raw") canonical[field.target.key] = moneyString;
        continue;
      }

      // string field
      const maxLength = field.maxLength ?? MAX_STRING_FIELD_LENGTH;
      if (rawValue.length > maxLength) {
        errors.push({
          rowNumber: sourceRowNumber,
          field: field.label,
          value: `${rawValue.slice(0, 40)}… (${rawValue.length} chars)`,
          reason: `Value exceeds the ${maxLength}-character limit for this field.`,
        });
        rowHasError = true;
        continue;
      }
      if (field.target.kind === "column") {
        if (field.target.column === "orderRef") orderRef = rawValue;
        else if (field.target.column === "reference") reference = rawValue;
      } else {
        canonical[field.target.key] = rawValue;
      }
    }

    if (rowHasError) return;

    if (date === undefined || amount === undefined) {
      errors.push({
        rowNumber: sourceRowNumber,
        field: "date / amount",
        value: "",
        reason: "Row is missing a required date or amount value.",
      });
      return;
    }

    rows.push({ sourceRowNumber, date, amount, orderRef, reference, canonical });
  });

  return { rows, skippedBlankRowCount, errors };
}

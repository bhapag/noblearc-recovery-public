import { format as formatDate, isValid, parse } from "date-fns";
import { DATE_FORMAT_OPTIONS, type DateFormatKey } from "./types";

export { DATE_FORMAT_OPTIONS };

const SUPPORTED_KEYS = new Set(DATE_FORMAT_OPTIONS.map((option) => option.key));

export function isSupportedDateFormat(value: string): value is DateFormatKey {
  return SUPPORTED_KEYS.has(value as DateFormatKey);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strictly parses `value` against the user-chosen `formatKey` — never
 * `new Date(string)`, which guesses ambiguously across locales/engines.
 * Returns an ISO calendar date (`yyyy-MM-dd`, UTC midnight semantics) or
 * `null` if the value cannot be parsed as that exact format. The caller
 * (validate-rows.ts) turns a `null` into a reported row error rather than
 * silently falling back to any other interpretation.
 *
 * An already-ISO-shaped value is accepted regardless of `formatKey`: XLSX
 * date-typed cells are converted to ISO strings by parse-xlsx.ts (Excel
 * dates are serial numbers, never ambiguous DD/MM-vs-MM/DD text), so there
 * is nothing to guess at and no reason to force the user's chosen
 * text-date format onto a value that was never text in the source file.
 */
export function parseStrictDate(value: string, formatKey: DateFormatKey): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (ISO_DATE_PATTERN.test(trimmed)) {
    const isoParsed = parse(trimmed, "yyyy-MM-dd", new Date(2000, 0, 1));
    return isValid(isoParsed) ? formatDate(isoParsed, "yyyy-MM-dd") : null;
  }

  const referenceDate = new Date(2000, 0, 1);
  const parsed = parse(trimmed, formatKey, referenceDate);
  if (!isValid(parsed)) return null;

  return formatDate(parsed, "yyyy-MM-dd");
}

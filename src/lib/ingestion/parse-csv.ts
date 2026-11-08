import { parse } from "csv-parse/sync";
import type { ParsedFile } from "./types";

export class FileParseError extends Error {}

/**
 * Parses raw CSV bytes into headers + string rows. Deliberately does not use
 * csv-parse's `columns` option (which would key rows by header and silently
 * tolerate ragged rows) — row-length mismatches against the header are
 * reported explicitly by validate-rows.ts instead of being hidden here.
 */
export function parseCsv(bytes: Buffer): ParsedFile {
  let records: string[][];
  try {
    records = parse(bytes, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    });
  } catch (error) {
    throw new FileParseError(
      `Could not parse file as CSV: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (records.length === 0) {
    throw new FileParseError("The file has no rows (not even a header row).");
  }

  const [headers, ...rows] = records;
  return { headers, rows };
}

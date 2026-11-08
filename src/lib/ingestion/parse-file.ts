import { parseCsv, FileParseError } from "./parse-csv";
import { parseXlsx } from "./parse-xlsx";
import type { ParsedFile } from "./types";

export { FileParseError };

/** Matched against the raised next.config.ts Server Action body size limit. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const XLSX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" — a ZIP archive

export type SniffedKind = "csv" | "xlsx";

/**
 * Identifies the file type from its actual bytes, not just its extension or
 * browser-reported MIME type (both are trivially spoofable) — an XLSX file
 * must have a real ZIP signature; a CSV must decode as plausible text.
 */
export function sniffFileKind(filename: string, bytes: Buffer): SniffedKind {
  const extension = filename.toLowerCase().split(".").pop();

  if (extension === "xlsx") {
    if (bytes.subarray(0, 4).equals(XLSX_MAGIC_BYTES)) return "xlsx";
    throw new FileParseError(
      "File has a .xlsx extension but its contents are not a valid XLSX (ZIP) archive.",
    );
  }

  if (extension === "csv") {
    assertLooksLikeText(bytes);
    return "csv";
  }

  throw new FileParseError(`Unsupported file type: .${extension ?? "unknown"}. Only .csv and .xlsx are supported.`);
}

/** Rejects files that are extension-spoofed binary content pretending to be CSV. */
function assertLooksLikeText(bytes: Buffer): void {
  const sample = bytes.subarray(0, 4096);
  let controlByteCount = 0;
  for (const byte of sample) {
    // Allow common whitespace (tab, LF, CR); anything else below 0x20, or a
    // NUL byte anywhere, counts as a control/binary byte.
    if (byte === 0x00 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      controlByteCount += 1;
    }
  }
  if (sample.length > 0 && controlByteCount / sample.length > 0.01) {
    throw new FileParseError("File has a .csv extension but its contents do not look like text.");
  }
}

export function assertUploadSize(sizeBytes: number): void {
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new FileParseError(
      `File is too large (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB). The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (sizeBytes === 0) {
    throw new FileParseError("File is empty.");
  }
}

export async function parseUploadedFile(filename: string, bytes: Buffer): Promise<ParsedFile> {
  assertUploadSize(bytes.length);
  const kind = sniffFileKind(filename, bytes);
  return kind === "csv" ? parseCsv(bytes) : parseXlsx(bytes);
}

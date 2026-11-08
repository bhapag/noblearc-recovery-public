import { prisma } from "@/lib/prisma";
import { findDuplicateSourceFile } from "./duplicate-lookup";
import { hashFileContent } from "./file-hash";
import { parseUploadedFile } from "./parse-file";
import type { PreviewResult } from "./types";

const SAMPLE_ROW_COUNT = 20;

/**
 * Parses a freshly-uploaded file for the mapping UI. Persists nothing —
 * storage and DB writes only happen at commitImport, which re-parses the
 * full file from scratch server-side rather than trusting this preview.
 * The duplicate check here is a best-effort early warning only; commitImport
 * re-checks it under a lock immediately before persisting (see there for why).
 */
export async function previewImportFile(
  restaurantId: string,
  filename: string,
  bytes: Buffer,
): Promise<PreviewResult> {
  const parsed = await parseUploadedFile(filename, bytes);
  const contentHash = hashFileContent(bytes);
  const duplicateOf = await findDuplicateSourceFile(prisma, restaurantId, contentHash);

  return {
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, SAMPLE_ROW_COUNT),
    totalRowCount: parsed.rows.length,
    contentHash,
    duplicateOf: duplicateOf ?? undefined,
  };
}

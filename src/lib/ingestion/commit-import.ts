import { randomUUID } from "node:crypto";
import { RecordKind } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { findDuplicateSourceFile } from "./duplicate-lookup";
import { hashFileContent } from "./file-hash";
import { getFileStorage } from "./file-storage";
import { FileParseError, parseUploadedFile } from "./parse-file";
import { validateMapping } from "./validate-mapping";
import { validateRows } from "./validate-rows";
import type { ColumnMapping, CommitImportResult, DateFormatKey, DuplicateSourceFile, NormalizedRow } from "./types";

export interface CommitImportInput {
  kind: RecordKind;
  restaurantId: string;
  aggregatorId?: string;
  filename: string;
  bytes: Buffer;
  mapping: ColumnMapping;
  dateFormat: DateFormatKey;
  uploadedByActorId: string;
  confirmDuplicate?: boolean;
}

/** Thrown inside the commit transaction to abort and report a race-detected duplicate; never escapes this module. */
class DuplicateDetectedInTransaction extends Error {
  constructor(public readonly existing: DuplicateSourceFile) {
    super("duplicate detected under lock");
  }
}

/**
 * Whole-file validate-then-commit: every row is parsed and validated in
 * memory with zero database writes first. Only if every row passes does a
 * single transaction persist the SourceFile plus all normalized rows
 * atomically. Any row failing rejects the entire file — a partial import
 * would leave a financial period looking more complete than it actually is,
 * which is worse for an audit tool than a rejected file the user fixes and
 * re-uploads. See PROJECT_STATE.md for this rationale in full.
 */
export async function commitImport(input: CommitImportInput): Promise<CommitImportResult> {
  // Aggregator only ever applies to SETTLEMENT — normalize server-side too
  // (defense in depth beyond the client clearing it on kind change) so a
  // stale/forged value can never land on a POS/Bank record's provenance.
  const aggregatorId = input.kind === RecordKind.SETTLEMENT ? input.aggregatorId : undefined;

  if (input.kind === RecordKind.SETTLEMENT && !aggregatorId) {
    return { status: "file_error", message: "An aggregator must be selected for settlement imports." };
  }

  const contentHash = hashFileContent(input.bytes);

  if (!input.confirmDuplicate) {
    const existing = await findDuplicateSourceFile(prisma, input.restaurantId, contentHash);
    if (existing) {
      return { status: "duplicate", existing };
    }
  }

  let parsed;
  try {
    parsed = await parseUploadedFile(input.filename, input.bytes);
  } catch (error) {
    if (error instanceof FileParseError) {
      return { status: "file_error", message: error.message };
    }
    throw error;
  }

  const mappingErrors = validateMapping(input.kind, parsed.headers, input.mapping);
  if (mappingErrors.length > 0) {
    return { status: "validation_error", mappingErrors, rowErrors: [] };
  }

  const { rows, skippedBlankRowCount, errors: rowErrors } = validateRows(
    input.kind,
    parsed,
    input.mapping,
    input.dateFormat,
  );
  if (rowErrors.length > 0) {
    return { status: "validation_error", mappingErrors: [], rowErrors };
  }
  if (rows.length === 0) {
    return { status: "file_error", message: "The file has no data rows to import." };
  }

  // Store the raw file before touching the database: if storage fails, we
  // abort before any DB write; storing first also means a DB transaction
  // failure never leaves a SourceFile row pointing at bytes that don't exist.
  // (The converse gap — storage succeeds but the transaction below then
  // fails — leaves an orphaned file on disk with no DB reference. That is a
  // tracked, accepted Phase 1 limitation: harmless wasted storage, not a
  // correctness or audit problem, since nothing ever points at it. See
  // PROJECT_STATE.md.)
  const storageKey = randomUUID();
  await getFileStorage().store(storageKey, input.bytes);

  let sourceFileId: string;
  try {
    sourceFileId = await prisma.$transaction(async (tx) => {
      // Re-check for a duplicate under an advisory lock scoped to this exact
      // (restaurant, file) pair, serializing concurrent commits that raced
      // past the early check above (e.g. a double-click, or two people
      // uploading the same export at once). Without this, two concurrent
      // transactions could both pass the early findFirst before either
      // commits, both insert, and the "no duplicate without confirmation"
      // guarantee would be silently bypassed.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.restaurantId} || ':' || ${contentHash}))`;
      if (!input.confirmDuplicate) {
        const existing = await findDuplicateSourceFile(tx, input.restaurantId, contentHash);
        if (existing) throw new DuplicateDetectedInTransaction(existing);
      }

      const sourceFile = await tx.sourceFile.create({
        data: {
          filename: input.filename,
          kind: input.kind,
          restaurantId: input.restaurantId,
          aggregatorId,
          contentHash,
          sizeBytes: input.bytes.length,
          mimeType: mimeTypeFor(input.filename),
          storageKey,
          mappingConfig: input.mapping,
          uploadedByActorId: input.uploadedByActorId,
        },
      });

      await persistRows(tx, input.kind, sourceFile.id, input.restaurantId, aggregatorId, rows);

      return sourceFile.id;
    });
  } catch (error) {
    if (error instanceof DuplicateDetectedInTransaction) {
      return { status: "duplicate", existing: error.existing };
    }
    throw error;
  }

  return { status: "success", sourceFileId, rowsImported: rows.length, rowsSkippedBlank: skippedBlankRowCount };
}

function mimeTypeFor(filename: string): string {
  return filename.toLowerCase().endsWith(".xlsx")
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv";
}

function toRawFields(row: NormalizedRow): { sourceRowNumber: number; canonical: Record<string, string> } {
  return { sourceRowNumber: row.sourceRowNumber, canonical: row.canonical };
}

/** Fields every raw-record kind shares. Kind-specific fields are spread on top by the caller. */
function baseRowData(restaurantId: string, sourceFileId: string, row: NormalizedRow) {
  return {
    restaurantId,
    date: new Date(`${row.date}T00:00:00.000Z`),
    amount: row.amount,
    sourceFileId,
    rawFields: toRawFields(row),
  };
}

async function persistRows(
  tx: Prisma.TransactionClient,
  kind: RecordKind,
  sourceFileId: string,
  restaurantId: string,
  aggregatorId: string | undefined,
  rows: NormalizedRow[],
): Promise<void> {
  if (kind === RecordKind.SETTLEMENT) {
    await tx.settlementRecord.createMany({
      data: rows.map((row) => ({
        ...baseRowData(restaurantId, sourceFileId, row),
        aggregatorId: aggregatorId as string,
        orderRef: row.orderRef,
      })),
    });
    return;
  }

  if (kind === RecordKind.POS) {
    await tx.pOSRecord.createMany({
      data: rows.map((row) => ({
        ...baseRowData(restaurantId, sourceFileId, row),
        orderRef: row.orderRef,
      })),
    });
    return;
  }

  await tx.bankRecord.createMany({
    data: rows.map((row) => ({
      ...baseRowData(restaurantId, sourceFileId, row),
      reference: row.reference,
    })),
  });
}

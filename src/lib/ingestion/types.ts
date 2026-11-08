import type { RecordKind } from "@/generated/prisma/enums";

export type CanonicalDataType = "date" | "money" | "string";

/** Where a canonical field's value ends up once validated. */
export type CanonicalFieldTarget =
  | { kind: "column"; column: "date" | "amount" | "orderRef" | "reference" }
  | { kind: "raw"; key: string };

export interface CanonicalFieldDef {
  /** Stable key used in mapping config and rawFields.canonical. */
  key: string;
  label: string;
  required: boolean;
  dataType: CanonicalDataType;
  target: CanonicalFieldTarget;
  /** For "string" fields landing in rawFields: max characters accepted (default MAX_STRING_FIELD_LENGTH). */
  maxLength?: number;
}

export const MAX_STRING_FIELD_LENGTH = 500;

/** canonical field key -> source column header chosen for it. Only mapped fields appear. */
export type ColumnMapping = Record<string, string>;

/** date-fns format tokens for the finite set of formats we support explicitly. */
export const DATE_FORMAT_OPTIONS = [
  { key: "yyyy-MM-dd", label: "YYYY-MM-DD (e.g. 2026-09-05)" },
  { key: "dd/MM/yyyy", label: "DD/MM/YYYY (e.g. 05/09/2026)" },
  { key: "MM/dd/yyyy", label: "MM/DD/YYYY (e.g. 09/05/2026)" },
  { key: "dd-MM-yyyy", label: "DD-MM-YYYY (e.g. 05-09-2026)" },
  { key: "dd MMM yyyy", label: "DD Mon YYYY (e.g. 05 Sep 2026)" },
] as const;

export type DateFormatKey = (typeof DATE_FORMAT_OPTIONS)[number]["key"];

export interface ParsedFile {
  headers: string[];
  /** Each row is an array of raw string cell values, positional to headers. */
  rows: string[][];
}

export interface RowError {
  /** 1-based row number in the source file, header row excluded. */
  rowNumber: number;
  field: string;
  value: string;
  reason: string;
}

export interface MappingValidationError {
  type: "missing_required" | "unknown_field" | "unknown_column" | "duplicate_column";
  message: string;
  fieldKey?: string;
  column?: string;
}

/** A single validated, canonicalized row ready to persist. */
export interface NormalizedRow {
  sourceRowNumber: number;
  date: string; // ISO date (yyyy-MM-dd), UTC midnight
  amount: string; // decimal-safe string
  orderRef?: string;
  reference?: string;
  /** Optional mapped fields with no dedicated column — money values as decimal-safe strings. */
  canonical: Record<string, string>;
}

export interface DuplicateSourceFile {
  sourceFileId: string;
  filename: string;
  uploadedAt: string;
}

export interface PreviewResult {
  headers: string[];
  sampleRows: string[][];
  totalRowCount: number;
  contentHash: string;
  duplicateOf?: DuplicateSourceFile;
}

export type CommitImportResult =
  | { status: "success"; sourceFileId: string; rowsImported: number; rowsSkippedBlank: number }
  | { status: "duplicate"; existing: DuplicateSourceFile }
  | { status: "validation_error"; mappingErrors: MappingValidationError[]; rowErrors: RowError[] }
  | { status: "file_error"; message: string };

export type { RecordKind };

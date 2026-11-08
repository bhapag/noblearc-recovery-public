import type { RecordKind } from "@/generated/prisma/enums";
import { getCanonicalFields, getRequiredFields } from "./canonical-fields";
import type { ColumnMapping, MappingValidationError } from "./types";

export type { MappingValidationError };

/**
 * Pure validation of a proposed column mapping against the canonical field
 * registry and the file's actual headers — no row data involved. Used by
 * both the mapping UI (instant feedback) and commitImport (server-side
 * re-check; the UI's validation is never trusted alone).
 */
export function validateMapping(
  kind: RecordKind,
  headers: string[],
  mapping: ColumnMapping,
): MappingValidationError[] {
  const errors: MappingValidationError[] = [];
  const fields = getCanonicalFields(kind);
  const fieldKeys = new Set(fields.map((field) => field.key));
  const headerSet = new Set(headers);

  for (const field of getRequiredFields(kind)) {
    if (!mapping[field.key]) {
      errors.push({
        type: "missing_required",
        fieldKey: field.key,
        message: `"${field.label}" is required but not mapped to a column.`,
      });
    }
  }

  const columnUsage = new Map<string, string[]>();
  for (const [fieldKey, column] of Object.entries(mapping)) {
    if (!fieldKeys.has(fieldKey)) {
      errors.push({ type: "unknown_field", fieldKey, message: `Unknown canonical field "${fieldKey}".` });
      continue;
    }
    if (!headerSet.has(column)) {
      errors.push({
        type: "unknown_column",
        fieldKey,
        column,
        message: `Mapped column "${column}" is not present in the file.`,
      });
      continue;
    }
    const users = columnUsage.get(column) ?? [];
    users.push(fieldKey);
    columnUsage.set(column, users);
  }

  for (const [column, fieldKeys2] of columnUsage) {
    if (fieldKeys2.length > 1) {
      errors.push({
        type: "duplicate_column",
        column,
        message: `Column "${column}" is mapped to more than one canonical field: ${fieldKeys2.join(", ")}.`,
      });
    }
  }

  return errors;
}

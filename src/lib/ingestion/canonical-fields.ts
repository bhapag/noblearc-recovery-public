import { RecordKind } from "@/generated/prisma/enums";
import type { CanonicalFieldDef } from "./types";

/**
 * Canonical field registry — the single source of truth for both the
 * mapping UI and row validation.
 *
 * Required/optional is taken directly from the Prisma schema's own column
 * nullability, not invented: `date` and `amount` are NOT NULL on every raw
 * record model, so they're required everywhere. Everything else in the
 * richer "aspirational" field set (commission, GST, fees, TDS, discounts,
 * refunds, settlement cycle, order status, etc.) has no dedicated column —
 * those are optional fields whose mapped value lands in the existing
 * `rawFields.canonical` JSON bucket, never a new column, and never required.
 * A field the user does not map simply isn't collected at all (no blind
 * dump of unmapped source columns — see CLAUDE.md's rawFields guardrail).
 */
const SETTLEMENT_FIELDS: CanonicalFieldDef[] = [
  { key: "date", label: "Settlement / order date", required: true, dataType: "date", target: { kind: "column", column: "date" } },
  { key: "amount", label: "Net settlement amount", required: true, dataType: "money", target: { kind: "column", column: "amount" } },
  { key: "orderRef", label: "Order ID / external reference", required: false, dataType: "string", target: { kind: "column", column: "orderRef" } },
  { key: "grossAmount", label: "Gross order value", required: false, dataType: "money", target: { kind: "raw", key: "grossAmount" } },
  { key: "commission", label: "Commission", required: false, dataType: "money", target: { kind: "raw", key: "commission" } },
  { key: "gstOnCommission", label: "GST / tax on commission", required: false, dataType: "money", target: { kind: "raw", key: "gstOnCommission" } },
  { key: "fixedFee", label: "Fixed / platform fee", required: false, dataType: "money", target: { kind: "raw", key: "fixedFee" } },
  { key: "tds", label: "TDS / withholding", required: false, dataType: "money", target: { kind: "raw", key: "tds" } },
  { key: "discounts", label: "Discounts / promotions / adjustments", required: false, dataType: "money", target: { kind: "raw", key: "discounts" } },
  { key: "refundAmount", label: "Refund / cancellation amount", required: false, dataType: "money", target: { kind: "raw", key: "refundAmount" } },
  { key: "settlementCycle", label: "Settlement cycle / reference", required: false, dataType: "string", target: { kind: "raw", key: "settlementCycle" } },
  { key: "orderStatus", label: "Order status", required: false, dataType: "string", target: { kind: "raw", key: "orderStatus" } },
];

const POS_FIELDS: CanonicalFieldDef[] = [
  { key: "date", label: "Order date/time", required: true, dataType: "date", target: { kind: "column", column: "date" } },
  { key: "amount", label: "Gross order amount", required: true, dataType: "money", target: { kind: "column", column: "amount" } },
  { key: "orderRef", label: "Order ID", required: false, dataType: "string", target: { kind: "column", column: "orderRef" } },
  { key: "orderStatus", label: "Order status", required: false, dataType: "string", target: { kind: "raw", key: "orderStatus" } },
  { key: "outletReference", label: "Outlet / reference field", required: false, dataType: "string", target: { kind: "raw", key: "outletReference" } },
];

const BANK_FIELDS: CanonicalFieldDef[] = [
  { key: "date", label: "Transaction date", required: true, dataType: "date", target: { kind: "column", column: "date" } },
  { key: "amount", label: "Credit amount", required: true, dataType: "money", target: { kind: "column", column: "amount" } },
  { key: "reference", label: "Bank reference / description", required: false, dataType: "string", target: { kind: "column", column: "reference" } },
  { key: "settlementReference", label: "Settlement reference (if available)", required: false, dataType: "string", target: { kind: "raw", key: "settlementReference" } },
];

const REGISTRY: Record<RecordKind, CanonicalFieldDef[]> = {
  [RecordKind.SETTLEMENT]: SETTLEMENT_FIELDS,
  [RecordKind.POS]: POS_FIELDS,
  [RecordKind.BANK]: BANK_FIELDS,
};

export function getCanonicalFields(kind: RecordKind): CanonicalFieldDef[] {
  return REGISTRY[kind];
}

export function getRequiredFields(kind: RecordKind): CanonicalFieldDef[] {
  return REGISTRY[kind].filter((field) => field.required);
}

export function getCanonicalField(kind: RecordKind, key: string): CanonicalFieldDef | undefined {
  return REGISTRY[kind].find((field) => field.key === key);
}

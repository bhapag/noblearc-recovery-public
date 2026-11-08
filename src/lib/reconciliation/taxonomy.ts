import { ClassificationStatus } from "@/generated/prisma/enums";

/**
 * The approved classification taxonomy. UNCLASSIFIED is deliberately absent
 * from this list — it is the blank default state, never a choice the
 * operator picks. Do not expand this list casually; it is a fixed,
 * approved set (see CLAUDE.md).
 */
export interface TaxonomyDefinition {
  value: ClassificationStatus;
  label: string;
  description: string;
  /** True only for CONFIRMED_DISCREPANCY — gates an extra confirmation step. */
  requiresExtraConfirmation: boolean;
}

export const CLASSIFICATION_TAXONOMY: TaxonomyDefinition[] = [
  {
    value: ClassificationStatus.VALID_DEDUCTION,
    label: "Valid Deduction",
    description:
      "The difference is explained by a legitimate, evidenced deduction (fee, tax, or adjustment the restaurant is genuinely liable for).",
    requiresExtraConfirmation: false,
  },
  {
    value: ClassificationStatus.TIMING_DIFFERENCE,
    label: "Timing Difference",
    description:
      "The amounts don't match today only because of when they were recorded (e.g. a settlement that will appear in a later cycle) — not a real shortfall.",
    requiresExtraConfirmation: false,
  },
  {
    value: ClassificationStatus.MISSING_DATA_UNMATCHED_ORDER,
    label: "Missing Data / Unmatched Order",
    description:
      "There isn't enough matched data to judge this order — a POS or settlement record is missing, or the calculation lacks required rate evidence.",
    requiresExtraConfirmation: false,
  },
  {
    value: ClassificationStatus.COMMERCIAL_RULE_DIFFERENCE,
    label: "Commercial Rule Difference",
    description:
      "The difference comes from a commercial/contractual rule (e.g. a promotion, cancellation policy, or negotiated term) that the standard formula doesn't capture.",
    requiresExtraConfirmation: false,
  },
  {
    value: ClassificationStatus.CONFIRMED_DISCREPANCY,
    label: "Confirmed Discrepancy",
    description:
      "The difference has been reviewed against the evidence and is considered a genuine, supportable shortfall or overpayment worth pursuing later. This is not dispute filing — it only marks the item as confirmed for future action.",
    requiresExtraConfirmation: true,
  },
  {
    value: ClassificationStatus.REQUIRES_HUMAN_REVIEW,
    label: "Requires Human Review",
    description:
      "Ambiguous, needs a second opinion, or there isn't yet enough evidence to decide — flagged for further review rather than a final call.",
    requiresExtraConfirmation: false,
  },
];

export function getTaxonomyDefinition(value: ClassificationStatus): TaxonomyDefinition | undefined {
  return CLASSIFICATION_TAXONOMY.find((t) => t.value === value);
}

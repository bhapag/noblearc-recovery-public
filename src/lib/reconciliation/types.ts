import type { CalculationStatus, ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";

export const CALCULATION_FORMULA_VERSION = "v1";

export type { CalculationStatus, ClassificationStatus, ReconciliationScope };

/**
 * Operator-entered rate assumptions for one reconciliation run — the
 * "explicit user-entered assumption" evidence the calculation is allowed to
 * use. Every provided rate is copied into a CaseEvidence row per case it
 * touches; none of these are ever hardcoded per-aggregator defaults.
 */
export interface RateAssumptions {
  commissionRatePercent?: string;
  gstRatePercent?: string;
  fixedFeeAmount?: string;
  tdsRatePercent?: string;
  /** Signed — negative reduces expected, positive increases it. */
  adjustmentAmount?: string;
  /** Required whenever any rate above is provided — where this comes from. */
  sourceReference: string;
}

/**
 * Self-contained snapshot of exactly what produced a case's expectedAmount —
 * durable even if the CaseEvidence rows that back it are later superseded.
 * All money fields are decimal-safe strings (never native numbers).
 */
export interface CalculationBreakdown {
  formulaVersion: string;
  grossAmount: string | null;
  grossAmountSource: "pos_match" | "none";
  commissionRatePercent: string | null;
  commissionAmount: string | null;
  gstRatePercent: string | null;
  gstAmount: string | null;
  fixedFeeAmount: string | null;
  tdsRatePercent: string | null;
  tdsAmount: string | null;
  adjustmentAmount: string | null;
  cancellationOverrideApplied: boolean;
  cancellationFeeAmount: string | null;
  sourceReference: string | null;
  notes?: string;
}

export interface RunOrderReconciliationInput {
  restaurantId: string;
  aggregatorId: string;
  periodStart: string; // ISO date (yyyy-MM-dd)
  periodEnd: string;
  rates: RateAssumptions | null;
  actorId: string;
}

export interface RunOrderReconciliationResult {
  matchedCount: number;
  unmatchedSettlementCount: number;
  unmatchedPosCount: number;
  ambiguousOrderRefCount: number;
  casesCreated: number;
  casesSuperseded: number;
}

export interface RunBankReconciliationInput {
  restaurantId: string;
  aggregatorId: string;
  periodStart: string;
  periodEnd: string;
  bankRecordId: string;
  actorId: string;
}

export interface RunBankReconciliationResult {
  caseCreated: boolean;
  caseSuperseded: boolean;
  settlementRecordCount: number;
}

export interface ClassifyInput {
  caseId: string;
  actorId: string;
  toStatus: ClassificationStatus;
  rationale: string;
  /** Required (both true) only when toStatus is CONFIRMED_DISCREPANCY. */
  confirmedEvidenceReviewed?: boolean;
  confirmedSupportable?: boolean;
}

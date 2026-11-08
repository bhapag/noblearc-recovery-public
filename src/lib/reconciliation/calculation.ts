import { percentageOf, roundMoney, toMoney, type Money } from "@/lib/money";
import { CALCULATION_FORMULA_VERSION, type CalculationBreakdown, type RateAssumptions } from "./types";

export interface CalculationOutcome {
  isCalculated: boolean;
  expectedAmount: Money | null;
  breakdown: CalculationBreakdown;
}

/**
 * The Phase 2 v1 formula — deterministic, evidence-driven, no hardcoded
 * per-aggregator constants:
 *
 *   commissionAmount = grossAmount * commissionRatePercent / 100
 *   gstAmount         = commissionAmount * gstRatePercent / 100      (if provided)
 *   tdsAmount         = grossAmount * tdsRatePercent / 100           (if provided)
 *   expectedAmount    = grossAmount - commissionAmount - gstAmount - fixedFee - tdsAmount + adjustment
 *
 * `grossAmount` must come from a matched POS record (ground truth of the
 * sale) — this function does not decide where it came from, only computes
 * from it. Without at least a commission rate, there is no basis for a
 * confident expected amount — `isCalculated: false` rather than inventing
 * one; the caller is responsible for surfacing that honestly (see
 * run-order-reconciliation.ts's INSUFFICIENT_DATA handling).
 */
export function calculateExpectedAmount(grossAmount: Money, rates: RateAssumptions | null): CalculationOutcome {
  if (!rates?.commissionRatePercent) {
    return {
      isCalculated: false,
      expectedAmount: null,
      breakdown: emptyBreakdown(grossAmount, rates?.sourceReference ?? null, "Missing commission rate assumption — cannot compute a confident expected amount."),
    };
  }

  const commissionRatePercent = toMoney(rates.commissionRatePercent);
  const commissionAmount = roundMoney(percentageOf(grossAmount, commissionRatePercent));

  const gstRatePercent = rates.gstRatePercent ? toMoney(rates.gstRatePercent) : null;
  const gstAmount = gstRatePercent ? roundMoney(percentageOf(commissionAmount, gstRatePercent)) : toMoney(0);

  const tdsRatePercent = rates.tdsRatePercent ? toMoney(rates.tdsRatePercent) : null;
  const tdsAmount = tdsRatePercent ? roundMoney(percentageOf(grossAmount, tdsRatePercent)) : toMoney(0);

  const fixedFee = rates.fixedFeeAmount ? toMoney(rates.fixedFeeAmount) : toMoney(0);
  const adjustment = rates.adjustmentAmount ? toMoney(rates.adjustmentAmount) : toMoney(0);

  const expectedAmount = roundMoney(
    grossAmount
      .minus(commissionAmount)
      .minus(gstAmount)
      .minus(fixedFee)
      .minus(tdsAmount)
      .plus(adjustment),
  );

  return {
    isCalculated: true,
    expectedAmount,
    breakdown: {
      formulaVersion: CALCULATION_FORMULA_VERSION,
      grossAmount: grossAmount.toFixed(2),
      grossAmountSource: "pos_match",
      commissionRatePercent: commissionRatePercent.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
      gstRatePercent: gstRatePercent?.toFixed(2) ?? null,
      gstAmount: gstRatePercent ? gstAmount.toFixed(2) : null,
      fixedFeeAmount: rates.fixedFeeAmount ? fixedFee.toFixed(2) : null,
      tdsRatePercent: tdsRatePercent?.toFixed(2) ?? null,
      tdsAmount: tdsRatePercent ? tdsAmount.toFixed(2) : null,
      adjustmentAmount: rates.adjustmentAmount ? adjustment.toFixed(2) : null,
      cancellationOverrideApplied: false,
      cancellationFeeAmount: null,
      sourceReference: rates.sourceReference,
    },
  };
}

/**
 * The cancellation-override variant (Action 14 correction, generalized —
 * never a universal rule): expectedAmount becomes exactly the evidenced
 * cancellation-fee amount instead of the normal formula. Only ever applied
 * per case, by explicit operator action, backed by a required evidence
 * reference — see src/lib/reconciliation/evidence.ts.
 */
export function calculateCancellationOverrideAmount(
  cancellationFeeAmount: Money,
  sourceReference: string,
): CalculationOutcome {
  const expectedAmount = roundMoney(cancellationFeeAmount);
  return {
    isCalculated: true,
    expectedAmount,
    breakdown: {
      formulaVersion: CALCULATION_FORMULA_VERSION,
      grossAmount: null,
      grossAmountSource: "none",
      commissionRatePercent: null,
      commissionAmount: null,
      gstRatePercent: null,
      gstAmount: null,
      fixedFeeAmount: null,
      tdsRatePercent: null,
      tdsAmount: null,
      adjustmentAmount: null,
      cancellationOverrideApplied: true,
      cancellationFeeAmount: expectedAmount.toFixed(2),
      sourceReference,
      notes: "Cancellation/void override applied under evidenced contract rule — normal formula bypassed.",
    },
  };
}

function emptyBreakdown(grossAmount: Money, sourceReference: string | null, notes: string): CalculationBreakdown {
  return {
    formulaVersion: CALCULATION_FORMULA_VERSION,
    grossAmount: grossAmount.toFixed(2),
    grossAmountSource: "pos_match",
    commissionRatePercent: null,
    commissionAmount: null,
    gstRatePercent: null,
    gstAmount: null,
    fixedFeeAmount: null,
    tdsRatePercent: null,
    tdsAmount: null,
    adjustmentAmount: null,
    cancellationOverrideApplied: false,
    cancellationFeeAmount: null,
    sourceReference,
    notes,
  };
}

/** For an unmatched record: no gross figure, no rates applied, nothing computed — just the reason why. */
export function noCalculationBreakdown(notes: string): CalculationBreakdown {
  return {
    formulaVersion: CALCULATION_FORMULA_VERSION,
    grossAmount: null,
    grossAmountSource: "none",
    commissionRatePercent: null,
    commissionAmount: null,
    gstRatePercent: null,
    gstAmount: null,
    fixedFeeAmount: null,
    tdsRatePercent: null,
    tdsAmount: null,
    adjustmentAmount: null,
    cancellationOverrideApplied: false,
    cancellationFeeAmount: null,
    sourceReference: null,
    notes,
  };
}

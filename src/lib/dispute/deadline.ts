import type { DeadlineConfidence } from "@/generated/prisma/enums";
import type { DeadlineView } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The one approved rule: effectiveDeadline = verifiedDeadline ?? workingAssumptionDeadline.
 * Never stored — always computed, so a later verification (or a policy that
 * never existed) is reflected honestly without needing a backfill.
 */
export function computeEffectiveDeadline(verifiedDeadline: Date | null, workingAssumptionDeadline: Date | null): Date | null {
  return verifiedDeadline ?? workingAssumptionDeadline;
}

/** Whole days remaining until the effective deadline; negative once overdue. Pure arithmetic, no judgment. */
export function computeDaysRemaining(effectiveDeadline: Date | null, asOf: Date = new Date()): number | null {
  if (!effectiveDeadline) return null;
  return Math.ceil((effectiveDeadline.getTime() - asOf.getTime()) / MS_PER_DAY);
}

export function computeIsOverdue(effectiveDeadline: Date | null, asOf: Date = new Date()): boolean {
  if (!effectiveDeadline) return false;
  return effectiveDeadline.getTime() < asOf.getTime();
}

/**
 * Assembles the full deadline picture for display. When neither a verified
 * deadline nor a working assumption exists, effectiveDeadline/daysRemaining
 * are honestly null and isOverdue is false — never fabricated certainty
 * (see the Phase 4 brief's "no-policy behavior is honest" requirement).
 */
export function buildDeadlineView(submission: {
  verifiedDeadline: Date | null;
  deadlineSourceEvidence: string | null;
  deadlineConfidence: DeadlineConfidence;
  workingAssumptionDeadline: Date | null;
}): DeadlineView {
  const effectiveDeadline = computeEffectiveDeadline(submission.verifiedDeadline, submission.workingAssumptionDeadline);
  return {
    verifiedDeadline: submission.verifiedDeadline?.toISOString() ?? null,
    deadlineSourceEvidence: submission.deadlineSourceEvidence,
    deadlineConfidence: submission.deadlineConfidence,
    workingAssumptionDeadline: submission.workingAssumptionDeadline?.toISOString() ?? null,
    effectiveDeadline: effectiveDeadline?.toISOString() ?? null,
    daysRemaining: computeDaysRemaining(effectiveDeadline),
    isOverdue: computeIsOverdue(effectiveDeadline),
  };
}

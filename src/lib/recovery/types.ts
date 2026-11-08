import type { ClientResponseStatus, RecoveryCaseStatus } from "@/generated/prisma/enums";

export interface CreateRecoveryCaseInput {
  restaurantId: string;
  aggregatorId: string;
  reconciliationCaseIds: string[];
  actorId: string;
}

export type CreateRecoveryCaseResult =
  | { ok: true; recoveryCaseId: string }
  | { ok: false; message: string };

export interface LinkDiscrepancyInput {
  recoveryCaseId: string;
  reconciliationCaseId: string;
  actorId: string;
}

export type LinkDiscrepancyResult = { ok: true } | { ok: false; message: string };

export interface UnlinkDiscrepancyInput {
  recoveryCaseId: string;
  reconciliationCaseId: string;
  actorId: string;
  note?: string;
}

export type UnlinkDiscrepancyResult = { ok: true } | { ok: false; message: string };

export interface SetEvidenceItemInput {
  recoveryCaseId: string;
  categoryCode: string;
  reference?: string;
  note?: string;
  actorId: string;
}

export type SetEvidenceItemResult = { ok: true } | { ok: false; message: string };

export interface RemoveEvidenceItemInput {
  recoveryCaseId: string;
  categoryCode: string;
  actorId: string;
}

export type RemoveEvidenceItemResult = { ok: true } | { ok: false; message: string };

export interface RecordOverlapReviewInput {
  recoveryCaseId: string;
  actorId: string;
  reviewed: boolean;
  note: string;
}

export type RecordOverlapReviewResult = { ok: true } | { ok: false; message: string };

export interface GenerateFindingsReportInput {
  recoveryCaseId: string;
  actorId: string;
}

export type GenerateFindingsReportResult =
  | { ok: true; reportId: string; version: number }
  | { ok: false; message: string };

export interface MarkReportSentInput {
  reportId: string;
  actorId: string;
  sentVia: string;
}

export type MarkReportSentResult = { ok: true } | { ok: false; message: string };

export interface RecordClientResponseInput {
  recoveryCaseId: string;
  actorId: string;
  status: ClientResponseStatus;
  note?: string;
}

export type RecordClientResponseResult = { ok: true } | { ok: false; message: string };

/** A single linked-item line in the confirmed-total breakdown — see confirmed-total.ts. */
export interface ConfirmedTotalLineItem {
  reconciliationCaseId: string;
  scope: string;
  orderRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amount: string;
  currentlyEligible: boolean;
  ineligibleReason: string | null;
  overlapping: boolean;
  overlapsWithRecoveryCaseId: string | null;
}

export interface ConfirmedTotalResult {
  includedTotal: string;
  blockedAmount: string;
  hasUnresolvedOverlap: boolean;
  lineItems: ConfirmedTotalLineItem[];
}

export interface EvidenceReadinessResult {
  ready: boolean;
  bankCreditEvidenceApplicable: boolean;
  missingCategoryCodes: string[];
}

export const RECOVERY_CASE_STATUSES: RecoveryCaseStatus[] = [
  "OPEN",
  "REPORT_SENT",
  "CLOSED",
  "AWAITING_RECOVERY",
  "PARTIALLY_RECOVERED",
  "RECOVERY_VERIFIED",
  "RECOVERY_CLOSED_PARTIAL",
];

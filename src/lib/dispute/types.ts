import type { DeadlineConfidence, DisputeOutcome, SubmissionChannel } from "@/generated/prisma/enums";

export interface EvidenceSnapshot {
  findingsReportId: string;
  findingsReportVersion: number;
  findingsReportContent: Record<string, unknown>;
  evidenceItemsAtSubmission: {
    categoryCode: string;
    categoryLabel: string;
    reference: string | null;
    note: string | null;
  }[];
  restaurantName: string;
  restaurantCode: string;
  aggregatorName: string;
  snapshotTakenAt: string;
}

export interface CreateDisputeSubmissionInput {
  recoveryCaseId: string;
  ticketOrReferenceNumber?: string;
  channel: SubmissionChannel;
  submittedAt: Date;
  assumptionPolicyId?: string;
  actorId: string;
}

export type CreateDisputeSubmissionResult =
  | { ok: true; disputeSubmissionId: string }
  | { ok: false; message: string };

export interface SetVerifiedDeadlineInput {
  disputeSubmissionId: string;
  verifiedDeadline: Date;
  deadlineSourceEvidence: string;
  deadlineConfidence: DeadlineConfidence;
  actorId: string;
}

export type SetVerifiedDeadlineResult = { ok: true } | { ok: false; message: string };

export interface AddFollowUpInput {
  disputeSubmissionId: string;
  occurredAt: Date;
  channel: SubmissionChannel;
  summary: string;
  aggregatorResponse?: string;
  nextAction?: string;
  actorId: string;
}

export type AddFollowUpResult = { ok: true } | { ok: false; message: string };

export interface RecordDispositionInput {
  disputeSubmissionId: string;
  outcome: DisputeOutcome;
  decidedAt: Date;
  evidenceNote: string;
  aggregatorStatedAmount?: string;
  actorId: string;
}

export type RecordDispositionResult = { ok: true } | { ok: false; message: string };

export interface DeadlineView {
  verifiedDeadline: string | null;
  deadlineSourceEvidence: string | null;
  deadlineConfidence: DeadlineConfidence;
  workingAssumptionDeadline: string | null;
  effectiveDeadline: string | null;
  daysRemaining: number | null;
  isOverdue: boolean;
}

import type { RecoveryCaseStatus, RecoveryEventStatus, RecoveryMethod } from "@/generated/prisma/enums";

export interface AllocationInput {
  reconciliationCaseId: string;
  allocatedAmount: string;
}

export interface CreateRecoveryEventInput {
  recoveryCaseId: string;
  method: RecoveryMethod;
  amount: string;
  occurredAt: Date;
  evidenceReference: string;
  operatorNote?: string;
  bankRecordId?: string;
  settlementRecordId?: string;
  /** Set only when this event corrects a specific already-VOIDED prior event. */
  supersedesEventId?: string;
  verifiedAt: Date;
  actorId: string;
  allocations: AllocationInput[];
}

export type CreateRecoveryEventResult = { ok: true; recoveryEventId: string } | { ok: false; message: string };

export interface VoidRecoveryEventInput {
  recoveryEventId: string;
  voidReason: string;
  actorId: string;
}

export type VoidRecoveryEventResult = { ok: true } | { ok: false; message: string };

export interface DeclareRecoveryClosedPartialInput {
  recoveryCaseId: string;
  note: string;
  actorId: string;
}

export type DeclareRecoveryClosedPartialResult = { ok: true } | { ok: false; message: string };

/** One linked ReconciliationCase's recovery position — the individual-case-level accounting the hard allocation cap is scoped to. */
export interface ReconciliationCasePosition {
  reconciliationCaseId: string;
  scope: string;
  orderRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** The confirmed-discrepancy cap this case's active allocations may never exceed. Zero when the item is no longer currently eligible (reclassified/superseded/overlap-blocked) — see eligibility.ts. */
  confirmedAmount: string;
  verifiedRecovered: string;
  outstanding: string;
}

/** The full recovery-position view for one RecoveryCase — everything the UI's financial labels are computed from. */
export interface RecoveryPositionResult {
  reconciliationCases: ReconciliationCasePosition[];
  totalConfirmedAmount: string;
  totalVerifiedRecovered: string;
  totalOutstanding: string;
  /** What RecoveryCaseStatus the ledger alone implies (ignoring a possible RECOVERY_CLOSED_PARTIAL override) — see position.ts's deriveStatus(). */
  derivedStatus: RecoveryCaseStatus;
}

export interface RecoveryAllocationDetail {
  reconciliationCaseId: string;
  orderRef: string | null;
  allocatedAmount: string;
}

export interface RecoveryEventDetail {
  id: string;
  method: RecoveryMethod;
  amount: string;
  occurredAt: string;
  evidenceReference: string;
  operatorNote: string | null;
  verifiedByActorName: string;
  verifiedAt: string;
  status: RecoveryEventStatus;
  bankRecordId: string | null;
  bankRecordSummary: string | null;
  settlementRecordId: string | null;
  settlementRecordSummary: string | null;
  supersedesEventId: string | null;
  supersededByEventId: string | null;
  voidedAt: string | null;
  voidedByActorName: string | null;
  voidReason: string | null;
  allocations: RecoveryAllocationDetail[];
  allocatedTotal: string;
  unallocatedRemainder: string;
  createdAt: string;
}

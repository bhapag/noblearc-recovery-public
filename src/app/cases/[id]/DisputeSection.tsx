"use client";

import { useEffect, useState } from "react";
import { DeadlineConfidence, DisputeOutcome, SubmissionChannel } from "@/generated/prisma/enums";
import { formatINR, toMoney } from "@/lib/money";
import {
  addFollowUpAction,
  createDisputeSubmissionAction,
  getDisputeSectionAction,
  listDeadlineAssumptionPoliciesAction,
  recordDispositionAction,
  setVerifiedDeadlineAction,
  type DisputeSectionView,
  type DisputeSubmissionDetail,
} from "../dispute-actions";
import styles from "../cases.module.css";

const CHANNEL_LABELS: Record<string, string> = {
  AGGREGATOR_PORTAL: "Aggregator Portal",
  EMAIL: "Email",
  OFFICIAL_SUPPORT: "Official Support",
  OTHER_OFFICIAL_CHANNEL: "Other Official Channel",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DisputeSection({
  recoveryCaseId,
  aggregatorId,
  onCaseChanged,
}: {
  recoveryCaseId: string;
  aggregatorId: string;
  /** The case-level audit timeline lives in the parent's own state — every dispute action must refresh it too, not just this section's own view. */
  onCaseChanged: () => void;
}) {
  const [dispute, setDispute] = useState<DisputeSectionView | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const response = await getDisputeSectionAction({ recoveryCaseId });
    setLoading(false);
    if (response.ok) setDispute(response.dispute);
    onCaseChanged();
  }

  useEffect(() => {
    let cancelled = false;
    async function loadForCase() {
      setLoading(true);
      const response = await getDisputeSectionAction({ recoveryCaseId });
      if (cancelled) return;
      setLoading(false);
      if (response.ok) setDispute(response.dispute);
    }
    loadForCase();
    return () => {
      cancelled = true;
    };
  }, [recoveryCaseId]);

  if (loading) return <section className={styles.card}><p className={styles.mutedText}>Loading dispute status…</p></section>;
  if (!dispute) return null;

  return (
    <section className={styles.card}>
      <p className={styles.sectionTitle}>Dispute submission</p>
      {!dispute.activeSubmission && (
        <>
          {dispute.eligibleForSubmission ? (
            <SubmitForm recoveryCaseId={recoveryCaseId} aggregatorId={aggregatorId} onChanged={load} />
          ) : (
            <p className={styles.mutedText}>{dispute.ineligibleReason}</p>
          )}
        </>
      )}
      {dispute.activeSubmission && <ActiveSubmissionView submission={dispute.activeSubmission} ineligibleReason={dispute.ineligibleReason} onChanged={load} />}
      {dispute.submissionHistory.length > 0 && (
        <div className={styles.detailSection} style={{ marginTop: 16 }}>
          <p className={styles.sectionTitle}>Prior submission attempts ({dispute.submissionHistory.length})</p>
          <ul className={styles.plainList}>
            {dispute.submissionHistory.map((s) => (
              <li key={s.id} className={styles.mutedText}>
                {CHANNEL_LABELS[s.channel]} · submitted {formatDate(s.submittedAt)} · superseded {formatDate(s.supersededAt)}
                {s.ticketOrReferenceNumber && ` · ref ${s.ticketOrReferenceNumber}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SubmitForm({ recoveryCaseId, aggregatorId, onChanged }: { recoveryCaseId: string; aggregatorId: string; onChanged: () => void }) {
  const [ticket, setTicket] = useState("");
  const [channel, setChannel] = useState<SubmissionChannel>(SubmissionChannel.AGGREGATOR_PORTAL);
  const [submittedAt, setSubmittedAt] = useState(() => toDateTimeLocal(new Date()));
  const [policies, setPolicies] = useState<{ id: string; category: string | null; defaultDays: number; sourceNote: string }[]>([]);
  const [policyId, setPolicyId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPolicies() {
      const response = await listDeadlineAssumptionPoliciesAction({ aggregatorId });
      if (cancelled) return;
      if (response.ok) setPolicies(response.policies);
    }
    loadPolicies();
    return () => {
      cancelled = true;
    };
  }, [aggregatorId]);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await createDisputeSubmissionAction({
        recoveryCaseId,
        ticketOrReferenceNumber: ticket || undefined,
        channel,
        submittedAt: new Date(submittedAt).toISOString(),
        assumptionPolicyId: policyId || undefined,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className={styles.mutedText}>
        Record what was actually submitted outside this system. This freezes the current findings report and evidence
        pack into an immutable snapshot — no automated sending, no aggregator integration.
      </p>
      <div className={styles.contextRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ticket">Ticket / reference number</label>
          <input id="ticket" className={styles.select} value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="Optional" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="channel">Official channel</label>
          <select id="channel" className={styles.select} value={channel} onChange={(e) => setChannel(e.target.value as SubmissionChannel)}>
            {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="submittedAt">Submitted at</label>
          <input id="submittedAt" type="datetime-local" className={styles.select} value={submittedAt} onChange={(e) => setSubmittedAt(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="policy">Deadline assumption (optional)</label>
          <select id="policy" className={styles.select} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            <option value="">No assumption available / not applicable</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>{p.category ?? "General"} — {p.defaultDays} days ({p.sourceNote})</option>
            ))}
          </select>
        </div>
      </div>
      {policies.length === 0 && (
        <p className={styles.mutedText}>
          No deadline assumption policy exists for this aggregator yet — the working-assumption deadline will remain
          unavailable until one is added or a verified deadline is recorded directly.
        </p>
      )}
      <label className={styles.checkboxRow}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I confirm this reflects what was actually submitted, and understand this freezes the current findings report
        and evidence pack into a permanent record.
      </label>
      <div className={styles.actionsRow}>
        <button type="button" className={styles.primaryButton} onClick={handleSubmit} disabled={!confirmed || submitting}>
          {submitting ? "Recording…" : "Record dispute submission"}
        </button>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  );
}

function ActiveSubmissionView({
  submission,
  ineligibleReason,
  onChanged,
}: {
  submission: DisputeSubmissionDetail;
  ineligibleReason: string | null;
  onChanged: () => void;
}) {
  const [showSnapshot, setShowSnapshot] = useState(false);
  const canEdit = !submission.disposition;

  return (
    <div>
      <div className={styles.badgeRow}>
        <span className={styles.badgeNeutral}>{CHANNEL_LABELS[submission.channel]}</span>
        {submission.ticketOrReferenceNumber && <span className={styles.badgeNeutral}>Ref: {submission.ticketOrReferenceNumber}</span>}
        <span className={styles.badgeNeutral}>Submitted {formatDate(submission.submittedAt)}</span>
      </div>

      <DeadlineView submission={submission} canEdit={canEdit} onChanged={onChanged} />

      <div style={{ marginTop: 12 }}>
        <button type="button" className={styles.linkButton} onClick={() => setShowSnapshot((v) => !v)}>
          {showSnapshot ? "Hide" : "View"} evidence snapshot frozen at submission
        </button>
        {showSnapshot && (
          <dl className={styles.breakdownList} style={{ marginTop: 8 }}>
            <div className={styles.breakdownRow}>
              <dt>Findings report</dt>
              <dd>v{String(submission.evidenceSnapshot.findingsReportVersion ?? "?")}</dd>
            </div>
            <div className={styles.breakdownRow}>
              <dt>Confirmed total at submission</dt>
              <dd>
                {formatINR(
                  toMoney(
                    String(
                      (submission.evidenceSnapshot.findingsReportContent as Record<string, unknown> | undefined)?.confirmedDiscrepancyTotal ?? "0",
                    ),
                  ),
                )}
              </dd>
            </div>
            <div className={styles.breakdownRow}>
              <dt>Evidence items frozen</dt>
              <dd>{Array.isArray(submission.evidenceSnapshot.evidenceItemsAtSubmission) ? submission.evidenceSnapshot.evidenceItemsAtSubmission.length : 0}</dd>
            </div>
            <div className={styles.breakdownRow}>
              <dt>Snapshot taken</dt>
              <dd>{formatDate(String(submission.evidenceSnapshot.snapshotTakenAt ?? ""))}</dd>
            </div>
          </dl>
        )}
      </div>

      <FollowUpsView submission={submission} canAdd={canEdit} onChanged={onChanged} />
      <DispositionView submission={submission} onChanged={onChanged} />
      {!canEdit && ineligibleReason && <p className={styles.mutedText} style={{ marginTop: 8 }}>{ineligibleReason}</p>}
    </div>
  );
}

function DeadlineView({ submission, canEdit, onChanged }: { submission: DisputeSubmissionDetail; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [verifiedDeadline, setVerifiedDeadline] = useState(() => toDateTimeLocal(new Date()));
  const [sourceEvidence, setSourceEvidence] = useState("");
  const [confidence, setConfidence] = useState<DeadlineConfidence>(DeadlineConfidence.VERIFIED_PLATFORM_POLICY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const response = await setVerifiedDeadlineAction({
        disputeSubmissionId: submission.id,
        verifiedDeadline: new Date(verifiedDeadline).toISOString(),
        deadlineSourceEvidence: sourceEvidence,
        deadlineConfidence: confidence,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const d = submission.deadline;
  return (
    <div className={styles.detailSection} style={{ marginTop: 12 }}>
      <p className={styles.detailSectionTitle}>Deadline</p>
      <div className={styles.badgeRow}>
        <span className={d.verifiedDeadline ? styles.badgeAccent : styles.badgeWarning}>
          {d.verifiedDeadline ? "Verified" : d.workingAssumptionDeadline ? "Assumed" : "Unknown"}
        </span>
        {d.isOverdue && <span className={styles.badgeWarning}>Overdue</span>}
      </div>
      <div className={styles.amountsGrid} style={{ marginTop: 8 }}>
        <div>
          <p className={styles.mutedText}>Effective deadline</p>
          <p>{d.effectiveDeadline ? formatDate(d.effectiveDeadline) : "Unavailable — no verified deadline or applicable assumption"}</p>
        </div>
        <div>
          <p className={styles.mutedText}>Days remaining</p>
          <p>{d.daysRemaining === null ? "—" : d.daysRemaining}</p>
        </div>
      </div>
      {d.workingAssumptionDeadline && (
        <p className={styles.mutedText}>Working assumption: {formatDate(d.workingAssumptionDeadline)} (confidence: {d.deadlineConfidence})</p>
      )}
      {d.verifiedDeadline && (
        <p className={styles.mutedText}>Verified: {formatDate(d.verifiedDeadline)} — {d.deadlineSourceEvidence} ({d.deadlineConfidence})</p>
      )}
      {canEdit && (
        <>
          {!editing ? (
            <button type="button" className={styles.linkButton} onClick={() => setEditing(true)}>Set / update verified deadline</button>
          ) : (
            <div className={styles.evidenceEditForm}>
              <input type="datetime-local" className={styles.select} value={verifiedDeadline} onChange={(e) => setVerifiedDeadline(e.target.value)} />
              <select className={styles.select} value={confidence} onChange={(e) => setConfidence(e.target.value as DeadlineConfidence)}>
                <option value="VERIFIED_PLATFORM_POLICY">Verified — platform policy</option>
                <option value="VERIFIED_CONTRACT">Verified — contract</option>
                <option value="VERIFIED_PRIOR_CASE">Verified — prior case precedent</option>
              </select>
              <input className={styles.select} placeholder="Source / evidence reference" value={sourceEvidence} onChange={(e) => setSourceEvidence(e.target.value)} />
              <div className={styles.actionsRow}>
                <button type="button" className={styles.primaryButton} onClick={handleSave} disabled={saving || !sourceEvidence.trim()}>
                  {saving ? "Saving…" : "Save verified deadline"}
                </button>
                <button type="button" className={styles.linkButton} onClick={() => setEditing(false)}>Cancel</button>
                {error && <span className={styles.errorText}>{error}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FollowUpsView({ submission, canAdd, onChanged }: { submission: DisputeSubmissionDetail; canAdd: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocal(new Date()));
  const [channel, setChannel] = useState<SubmissionChannel>(SubmissionChannel.OFFICIAL_SUPPORT);
  const [summary, setSummary] = useState("");
  const [aggregatorResponse, setAggregatorResponse] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const response = await addFollowUpAction({
        disputeSubmissionId: submission.id,
        occurredAt: new Date(occurredAt).toISOString(),
        channel,
        summary,
        aggregatorResponse: aggregatorResponse || undefined,
        nextAction: nextAction || undefined,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setSummary("");
      setAggregatorResponse("");
      setNextAction("");
      setAdding(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.detailSection} style={{ marginTop: 12 }}>
      <p className={styles.detailSectionTitle}>Follow-ups ({submission.followUps.length})</p>
      {submission.followUps.length === 0 ? (
        <p className={styles.mutedText}>No follow-ups recorded yet.</p>
      ) : (
        <ul className={styles.plainList}>
          {submission.followUps.map((f) => (
            <li key={f.id} className={styles.mutedText}>
              {formatDate(f.occurredAt)} — {f.actorName} ({CHANNEL_LABELS[f.channel]}): {f.summary}
              {f.aggregatorResponse && <> — Aggregator: {f.aggregatorResponse}</>}
              {f.nextAction && <> — Next: {f.nextAction}</>}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <>
          {!adding ? (
            <button type="button" className={styles.linkButton} onClick={() => setAdding(true)}>Add follow-up</button>
          ) : (
            <div className={styles.evidenceEditForm}>
              <input type="datetime-local" className={styles.select} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
              <select className={styles.select} value={channel} onChange={(e) => setChannel(e.target.value as SubmissionChannel)}>
                {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <textarea className={styles.textarea} placeholder="Summary (required)" value={summary} onChange={(e) => setSummary(e.target.value)} />
              <textarea className={styles.textarea} placeholder="Aggregator response (optional)" value={aggregatorResponse} onChange={(e) => setAggregatorResponse(e.target.value)} />
              <input className={styles.select} placeholder="Next action (optional)" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
              <div className={styles.actionsRow}>
                <button type="button" className={styles.primaryButton} onClick={handleAdd} disabled={saving || !summary.trim()}>
                  {saving ? "Saving…" : "Save follow-up"}
                </button>
                <button type="button" className={styles.linkButton} onClick={() => setAdding(false)}>Cancel</button>
                {error && <span className={styles.errorText}>{error}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DispositionView({ submission, onChanged }: { submission: DisputeSubmissionDetail; onChanged: () => void }) {
  const [outcome, setOutcome] = useState<DisputeOutcome>(DisputeOutcome.ACCEPTED);
  const [decidedAt, setDecidedAt] = useState(() => toDateTimeLocal(new Date()));
  const [evidenceNote, setEvidenceNote] = useState("");
  const [aggregatorStatedAmount, setAggregatorStatedAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const response = await recordDispositionAction({
        disputeSubmissionId: submission.id,
        outcome,
        decidedAt: new Date(decidedAt).toISOString(),
        evidenceNote,
        aggregatorStatedAmount: aggregatorStatedAmount || undefined,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  if (submission.disposition) {
    const d = submission.disposition;
    return (
      <div className={styles.detailSection} style={{ marginTop: 12 }}>
        <p className={styles.detailSectionTitle}>Disposition</p>
        <p>
          <span className={d.outcome === "ACCEPTED" || d.outcome === "PARTIALLY_ACCEPTED" ? styles.badgeAccent : styles.badgeWarning}>{d.outcome}</span>
        </p>
        <p className={styles.mutedText}>
          Decided {formatDate(d.decidedAt)} by {d.decidedByActorName} — {d.evidenceNote}
          {d.aggregatorStatedAmount && <> · Aggregator-stated amount: {formatINR(toMoney(d.aggregatorStatedAmount))} (not recovered money)</>}
        </p>
      </div>
    );
  }

  const showAmount = outcome === "ACCEPTED" || outcome === "PARTIALLY_ACCEPTED";

  return (
    <div className={styles.detailSection} style={{ marginTop: 12 }}>
      <p className={styles.detailSectionTitle}>Record disposition</p>
      <p className={styles.mutedText}>
        A human decision only — never inferred. Accepted/Partially Accepted keep this case open for Phase 5 recovery
        verification; Rejected/Unresolved close it. Nothing here is recorded as recovered money.
      </p>
      <select className={styles.select} value={outcome} onChange={(e) => setOutcome(e.target.value as DisputeOutcome)}>
        <option value="ACCEPTED">Accepted</option>
        <option value="PARTIALLY_ACCEPTED">Partially Accepted</option>
        <option value="REJECTED">Rejected</option>
        <option value="UNRESOLVED">Unresolved</option>
      </select>
      <input type="datetime-local" className={styles.select} value={decidedAt} onChange={(e) => setDecidedAt(e.target.value)} style={{ marginTop: 8 }} />
      <textarea className={styles.textarea} placeholder="Evidence / reference note (required)" value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} />
      {showAmount && (
        <input
          className={styles.select}
          placeholder="Aggregator-stated amount (optional — never treated as recovered)"
          value={aggregatorStatedAmount}
          onChange={(e) => setAggregatorStatedAmount(e.target.value)}
        />
      )}
      <div className={styles.actionsRow}>
        <button type="button" className={styles.primaryButton} onClick={handleSave} disabled={saving || !evidenceNote.trim()}>
          {saving ? "Saving…" : "Record disposition"}
        </button>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  );
}

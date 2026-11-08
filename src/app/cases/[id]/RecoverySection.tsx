"use client";

import { useEffect, useState } from "react";
import { RecoveryMethod } from "@/generated/prisma/enums";
import { formatINR, subtractMoney, sumMoney, toMoney } from "@/lib/money";
import {
  createRecoveryEventAction,
  declareRecoveryClosedPartialAction,
  getRecoveryPositionAction,
  searchBankRecordsAction,
  searchSettlementRecordsAction,
  voidRecoveryEventAction,
  type BankRecordOption,
  type RecoverySectionView,
  type SettlementRecordOption,
} from "../recovery-actions";
import type { RecoveryEventDetail } from "@/lib/recovery-events/types";
import styles from "../cases.module.css";

const METHOD_LABELS: Record<string, string> = {
  DIRECT_BANK_CREDIT: "Direct Bank Credit",
  FUTURE_SETTLEMENT_OFFSET: "Future Settlement Offset",
  OTHER_EVIDENCED_METHOD: "Other Evidenced Method",
};

function formatAmount(value: string): string {
  return formatINR(toMoney(value));
}
function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RecoverySection({
  recoveryCaseId,
  restaurantId,
  aggregatorId,
  onCaseChanged,
}: {
  recoveryCaseId: string;
  restaurantId: string;
  aggregatorId: string;
  onCaseChanged: () => void;
}) {
  const [view, setView] = useState<RecoverySectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [correctingEventId, setCorrectingEventId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const response = await getRecoveryPositionAction({ recoveryCaseId });
    setLoading(false);
    if (response.ok) setView(response.view);
    onCaseChanged();
  }

  useEffect(() => {
    let cancelled = false;
    async function loadForCase() {
      setLoading(true);
      const response = await getRecoveryPositionAction({ recoveryCaseId });
      if (cancelled) return;
      setLoading(false);
      if (response.ok) setView(response.view);
    }
    loadForCase();
    return () => {
      cancelled = true;
    };
  }, [recoveryCaseId]);

  if (loading) return <section className={styles.card}><p className={styles.mutedText}>Loading recovery status…</p></section>;
  if (!view) return null;

  const correctingEvent = correctingEventId ? view.events.find((e) => e.id === correctingEventId) : null;

  return (
    <section className={styles.card}>
      <p className={styles.sectionTitle}>Recovery verification</p>
      <PositionSummary view={view} />

      {view.eligibleForNewRecovery ? (
        <RecordRecoveryForm
          recoveryCaseId={recoveryCaseId}
          restaurantId={restaurantId}
          aggregatorId={aggregatorId}
          view={view}
          correcting={correctingEvent ?? null}
          onCancelCorrection={() => setCorrectingEventId(null)}
          onChanged={load}
        />
      ) : (
        <p className={styles.mutedText}>{view.ineligibleReason}</p>
      )}

      {view.eligibleForNewRecovery && <ClosePartialControl recoveryCaseId={recoveryCaseId} onChanged={load} />}

      <EventsList events={view.events} onVoid={load} onCorrect={setCorrectingEventId} />
    </section>
  );
}

function PositionSummary({ view }: { view: RecoverySectionView }) {
  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>Position</p>
      <div className={styles.amountsGrid}>
        <div>
          <p className={styles.mutedText}>Confirmed Discrepancy</p>
          <p className={styles.bigAmount}>{formatAmount(view.position.totalConfirmedAmount)}</p>
        </div>
        <div>
          <p className={styles.mutedText}>Verified Recovered</p>
          <p className={styles.bigAmount}>{formatAmount(view.position.totalVerifiedRecovered)}</p>
        </div>
        <div>
          <p className={styles.mutedText}>Outstanding</p>
          <p className={styles.bigAmount}>{formatAmount(view.position.totalOutstanding)}</p>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.resultsTable}>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Order ref / period</th>
              <th>Confirmed</th>
              <th>Verified Recovered</th>
              <th>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {view.position.reconciliationCases.map((r) => (
              <tr key={r.reconciliationCaseId}>
                <td>{r.scope === "BANK_CYCLE" ? "Bank cycle" : "Order level"}</td>
                <td>{r.orderRef ?? (r.periodStart && r.periodEnd ? `${new Date(r.periodStart).toLocaleDateString()} – ${new Date(r.periodEnd).toLocaleDateString()}` : "—")}</td>
                <td>{formatAmount(r.confirmedAmount)}</td>
                <td>{formatAmount(r.verifiedRecovered)}</td>
                <td>{formatAmount(r.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.mutedText}>
        Verified Recovered reflects only what a human has confirmed actually arrived — an aggregator disposition alone never counts, and an
        event&apos;s unallocated remainder is never treated as recovered against any discrepancy.
      </p>
    </div>
  );
}

function RecordRecoveryForm({
  recoveryCaseId,
  restaurantId,
  aggregatorId,
  view,
  correcting,
  onCancelCorrection,
  onChanged,
}: {
  recoveryCaseId: string;
  restaurantId: string;
  aggregatorId: string;
  view: RecoverySectionView;
  correcting: RecoveryEventDetail | null;
  onCancelCorrection: () => void;
  onChanged: () => void;
}) {
  const [method, setMethod] = useState<RecoveryMethod>(RecoveryMethod.DIRECT_BANK_CREDIT);
  const [amount, setAmount] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocal(new Date()));
  const [verifiedAt, setVerifiedAt] = useState(() => toDateTimeLocal(new Date()));
  const [evidenceReference, setEvidenceReference] = useState("");
  const [operatorNote, setOperatorNote] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [bankOptions, setBankOptions] = useState<BankRecordOption[]>([]);
  const [bankRecordId, setBankRecordId] = useState("");
  const [settlementQuery, setSettlementQuery] = useState("");
  const [settlementOptions, setSettlementOptions] = useState<SettlementRecordOption[]>([]);
  const [settlementRecordId, setSettlementRecordId] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleRows = view.position.reconciliationCases.filter((r) => toMoney(r.outstanding).greaterThan(0));

  async function handleBankSearch() {
    const response = await searchBankRecordsAction({ restaurantId, query: bankQuery || undefined });
    if (response.ok) setBankOptions(response.options);
  }
  async function handleSettlementSearch() {
    const response = await searchSettlementRecordsAction({ restaurantId, aggregatorId, query: settlementQuery || undefined });
    if (response.ok) setSettlementOptions(response.options);
  }

  function suggestAllocation() {
    let remaining = toMoney(amount || "0");
    const next: Record<string, string> = {};
    for (const row of eligibleRows) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const outstanding = toMoney(row.outstanding);
      const take = outstanding.lessThan(remaining) ? outstanding : remaining;
      next[row.reconciliationCaseId] = take.toFixed(2);
      remaining = subtractMoney(remaining, take);
    }
    setAllocations(next);
  }

  function allocationTotal(): ReturnType<typeof toMoney> {
    return sumMoney(
      Object.values(allocations)
        .filter((v) => v.trim())
        .map((v) => {
          try {
            return toMoney(v);
          } catch {
            return toMoney("0");
          }
        }),
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const allocationEntries = Object.entries(allocations)
        .filter(([, v]) => v.trim() && toMoney(v).greaterThan(0))
        .map(([reconciliationCaseId, allocatedAmount]) => ({ reconciliationCaseId, allocatedAmount }));
      if (allocationEntries.length === 0) {
        setError("At least one allocation is required.");
        return;
      }
      const response = await createRecoveryEventAction({
        recoveryCaseId,
        method,
        amount,
        occurredAt: new Date(occurredAt).toISOString(),
        evidenceReference,
        operatorNote: operatorNote || undefined,
        bankRecordId: method === RecoveryMethod.DIRECT_BANK_CREDIT && bankRecordId ? bankRecordId : undefined,
        settlementRecordId: method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && settlementRecordId ? settlementRecordId : undefined,
        supersedesEventId: correcting?.id,
        verifiedAt: new Date(verifiedAt).toISOString(),
        allocations: allocationEntries,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setAmount("");
      setEvidenceReference("");
      setOperatorNote("");
      setBankRecordId("");
      setSettlementRecordId("");
      setAllocations({});
      setConfirmed(false);
      onCancelCorrection();
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  const total = allocationTotal();
  const amountValue = (() => {
    try {
      return toMoney(amount || "0");
    } catch {
      return toMoney("0");
    }
  })();
  const remainder = subtractMoney(amountValue, total);

  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>{correcting ? `Correct recovery event (replacing a voided ${METHOD_LABELS[correcting.method]} record)` : "Record recovery"}</p>
      <p className={styles.mutedText}>
        Records what a human has actually verified — money observed in the bank, or a promised adjustment actually proven in a later settlement
        record. An aggregator saying it &ldquo;will adjust&rdquo; is not evidence on its own.
      </p>
      <div className={styles.contextRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="method">Method</label>
          <select id="method" className={styles.select} value={method} onChange={(e) => setMethod(e.target.value as RecoveryMethod)}>
            <option value="DIRECT_BANK_CREDIT">Direct Bank Credit</option>
            <option value="FUTURE_SETTLEMENT_OFFSET">Future Settlement Offset</option>
            <option value="OTHER_EVIDENCED_METHOD">Other Evidenced Method</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="amount">Amount observed</label>
          <input id="amount" className={styles.select} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="occurredAt">Recovery occurrence date</label>
          <input id="occurredAt" type="datetime-local" className={styles.select} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="verifiedAt">Verified at</label>
          <input id="verifiedAt" type="datetime-local" className={styles.select} value={verifiedAt} onChange={(e) => setVerifiedAt(e.target.value)} />
        </div>
      </div>

      {method === RecoveryMethod.DIRECT_BANK_CREDIT && (
        <div className={styles.evidenceEditForm}>
          <p className={styles.mutedText}>Search imported bank records first — the strongest provenance.</p>
          <div className={styles.actionsRow}>
            <input className={styles.select} placeholder="Search by reference" value={bankQuery} onChange={(e) => setBankQuery(e.target.value)} />
            <button type="button" className={styles.primaryButton} onClick={handleBankSearch}>Search</button>
          </div>
          {bankOptions.length > 0 && (
            <select className={styles.select} value={bankRecordId} onChange={(e) => setBankRecordId(e.target.value)}>
              <option value="">No matching imported record — use evidence reference below</option>
              {bankOptions.map((o) => (
                <option key={o.id} value={o.id} disabled={o.alreadyClaimed}>
                  {new Date(o.date).toLocaleDateString()} — {formatAmount(o.amount)}{o.reference ? ` (${o.reference})` : ""}{o.alreadyClaimed ? " — already claimed" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && (
        <div className={styles.evidenceEditForm}>
          <p className={styles.mutedText}>
            A matching imported settlement record is <strong>required</strong> for this method — an aggregator promise, email, or ticket
            response saying &ldquo;will be adjusted&rdquo; is never sufficient evidence on its own.
          </p>
          <div className={styles.actionsRow}>
            <input className={styles.select} placeholder="Search by order ref" value={settlementQuery} onChange={(e) => setSettlementQuery(e.target.value)} />
            <button type="button" className={styles.primaryButton} onClick={handleSettlementSearch}>Search</button>
          </div>
          {settlementOptions.length > 0 && (
            <select className={styles.select} value={settlementRecordId} onChange={(e) => setSettlementRecordId(e.target.value)}>
              <option value="">Select the settlement record proving this offset occurred…</option>
              {settlementOptions.map((o) => (
                <option key={o.id} value={o.id} disabled={o.alreadyClaimed}>
                  {new Date(o.date).toLocaleDateString()} — {formatAmount(o.amount)}{o.orderRef ? ` (${o.orderRef})` : ""}{o.alreadyClaimed ? " — already claimed" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className={styles.field} style={{ marginTop: 8 }}>
        <label className={styles.label} htmlFor="evidenceReference">
          Evidence reference {(method === RecoveryMethod.DIRECT_BANK_CREDIT && bankRecordId) || (method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && settlementRecordId) ? "(supplementary note)" : "(sole provenance — required)"}
        </label>
        <input id="evidenceReference" className={styles.select} value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} placeholder="UTR / reference text" />
      </div>
      <textarea className={styles.textarea} placeholder="Operator note (optional)" value={operatorNote} onChange={(e) => setOperatorNote(e.target.value)} />

      <div className={styles.detailSection}>
        <p className={styles.detailSectionTitle}>Allocate across confirmed discrepancies</p>
        <button type="button" className={styles.linkButton} onClick={suggestAllocation}>Suggest allocation (fills outstanding amounts in order — you confirm)</button>
        <ul className={styles.plainList} style={{ marginTop: 8 }}>
          {eligibleRows.map((row) => (
            <li key={row.reconciliationCaseId} className={styles.plainListRow}>
              <span>{row.orderRef ?? "period item"} — outstanding {formatAmount(row.outstanding)}</span>
              <input
                className={styles.select}
                style={{ maxWidth: 140 }}
                placeholder="0.00"
                value={allocations[row.reconciliationCaseId] ?? ""}
                onChange={(e) => setAllocations((prev) => ({ ...prev, [row.reconciliationCaseId]: e.target.value }))}
              />
            </li>
          ))}
        </ul>
        {eligibleRows.length === 0 && <p className={styles.mutedText}>No reconciliation case currently has outstanding room for allocation.</p>}
        <p className={styles.mutedText}>
          Allocated so far: {formatAmount(total.toFixed(2))}. Unallocated remainder: {formatAmount((remainder.greaterThan(0) ? remainder : toMoney("0")).toFixed(2))} — never treated as recovered against any discrepancy.
        </p>
      </div>

      <label className={styles.checkboxRow}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I confirm this reflects a human-verified fact, and the allocation above is final.
      </label>
      <div className={styles.actionsRow}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleSubmit}
          disabled={!confirmed || submitting || !amount || !evidenceReference.trim() || (method === RecoveryMethod.FUTURE_SETTLEMENT_OFFSET && !settlementRecordId)}
        >
          {submitting ? "Saving…" : correcting ? "Record replacement event" : "Record recovery"}
        </button>
        {correcting && <button type="button" className={styles.linkButton} onClick={onCancelCorrection}>Cancel correction</button>}
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  );
}

function ClosePartialControl({ recoveryCaseId, onChanged }: { recoveryCaseId: string; onChanged: () => void }) {
  const [showing, setShowing] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const response = await declareRecoveryClosedPartialAction({ recoveryCaseId, note });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setShowing(false);
      setNote("");
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  if (!showing) {
    return (
      <div className={styles.actionsRow}>
        <button type="button" className={styles.linkButton} onClick={() => setShowing(true)}>Close recovery as partial / no further recovery expected</button>
      </div>
    );
  }

  return (
    <div className={styles.evidenceEditForm}>
      <p className={styles.mutedText}>A human-only declaration that no further recovery is expected, even though some amount remains outstanding. Never inferred from age or inactivity.</p>
      <textarea className={styles.textarea} placeholder="Justification (required)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className={styles.actionsRow}>
        <button type="button" className={styles.primaryButton} onClick={handleSave} disabled={saving || !note.trim()}>
          {saving ? "Saving…" : "Confirm partial closure"}
        </button>
        <button type="button" className={styles.linkButton} onClick={() => setShowing(false)}>Cancel</button>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  );
}

function EventsList({ events, onVoid, onCorrect }: { events: RecoveryEventDetail[]; onVoid: () => void; onCorrect: (id: string) => void }) {
  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>Recovery events ({events.length})</p>
      {events.length === 0 ? (
        <p className={styles.mutedText}>No recovery recorded yet.</p>
      ) : (
        <ul className={styles.plainList}>
          {events.map((e) => (
            <EventRow key={e.id} event={e} onVoid={onVoid} onCorrect={onCorrect} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ event, onVoid, onCorrect }: { event: RecoveryEventDetail; onVoid: () => void; onCorrect: (id: string) => void }) {
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVoid() {
    setSaving(true);
    setError(null);
    try {
      const response = await voidRecoveryEventAction({ recoveryEventId: event.id, voidReason });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setVoiding(false);
      setVoidReason("");
      onVoid();
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className={styles.evidenceRow}>
      <div className={styles.evidenceRowHeader}>
        <span className={event.status === "VOIDED" ? styles.badgeWarning : styles.badgeAccent}>{event.status}</span>
        <span className={styles.badgeNeutral}>{METHOD_LABELS[event.method]}</span>
        <span>{formatAmount(event.amount)} — {formatDate(event.occurredAt)}</span>
        {event.status === "ACTIVE" && !voiding && (
          <span className={styles.evidenceRowActions}>
            <button type="button" className={styles.linkButton} onClick={() => setVoiding(true)}>Void</button>
          </span>
        )}
        {event.status === "VOIDED" && !event.supersededByEventId && (
          <span className={styles.evidenceRowActions}>
            <button type="button" className={styles.linkButton} onClick={() => onCorrect(event.id)}>Correct by recording replacement event</button>
          </span>
        )}
      </div>
      <p className={styles.mutedText}>
        {event.bankRecordSummary && <>Bank record: {event.bankRecordSummary}. </>}
        {event.settlementRecordSummary && <>Settlement record: {event.settlementRecordSummary}. </>}
        Evidence: {event.evidenceReference}. {event.operatorNote && <>Note: {event.operatorNote}. </>}
        Verified by {event.verifiedByActorName}, {formatDate(event.verifiedAt)}.
      </p>
      {event.allocations.length > 0 && (
        <dl className={styles.breakdownList}>
          {event.allocations.map((a) => (
            <div className={styles.breakdownRow} key={a.reconciliationCaseId}>
              <dt>{a.orderRef ?? "period item"}</dt>
              <dd>{formatAmount(a.allocatedAmount)}</dd>
            </div>
          ))}
          {toMoney(event.unallocatedRemainder).greaterThan(0) && (
            <div className={styles.breakdownRow}>
              <dt>Unallocated remainder</dt>
              <dd>{formatAmount(event.unallocatedRemainder)}</dd>
            </div>
          )}
        </dl>
      )}
      {event.status === "VOIDED" && (
        <p className={styles.mutedText}>
          Voided {formatDate(event.voidedAt)} by {event.voidedByActorName} — {event.voidReason}
          {event.supersededByEventId && " (corrected by a replacement event below)"}
        </p>
      )}
      {voiding && (
        <div className={styles.evidenceEditForm}>
          <textarea className={styles.textarea} placeholder="Void reason (required)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          <div className={styles.actionsRow}>
            <button type="button" className={styles.primaryButton} onClick={handleVoid} disabled={saving || !voidReason.trim()}>
              {saving ? "Voiding…" : "Confirm void"}
            </button>
            <button type="button" className={styles.linkButton} onClick={() => setVoiding(false)}>Cancel</button>
            {error && <span className={styles.errorText}>{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

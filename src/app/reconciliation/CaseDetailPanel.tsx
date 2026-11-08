"use client";

import { useEffect, useState } from "react";
import { ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { formatINR, toMoney } from "@/lib/money";
import { CLASSIFICATION_TAXONOMY, getTaxonomyDefinition } from "@/lib/reconciliation/taxonomy";
import {
  applyCancellationOverrideAction,
  classifyCaseAction,
  getCaseDetailAction,
  type ReconciliationCaseDetail,
} from "./actions";
import styles from "./reconciliation.module.css";

function formatAmount(value: string | null): string {
  if (value === null) return "—";
  return formatINR(toMoney(value));
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function CaseDetailPanel({
  caseId,
  onClose,
  onChanged,
  restaurantLabel,
  aggregatorLabel,
}: {
  caseId: string;
  onClose: () => void;
  onChanged: () => void;
  restaurantLabel: string;
  aggregatorLabel: string;
}) {
  const [detail, setDetail] = useState<ReconciliationCaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [toStatus, setToStatus] = useState<ClassificationStatus | "">("");
  const [rationale, setRationale] = useState("");
  const [confirmedEvidenceReviewed, setConfirmedEvidenceReviewed] = useState(false);
  const [confirmedSupportable, setConfirmedSupportable] = useState(false);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [isClassifying, setIsClassifying] = useState(false);

  const [showCancellationForm, setShowCancellationForm] = useState(false);
  const [cancellationFeeAmount, setCancellationFeeAmount] = useState("");
  const [cancellationSourceReference, setCancellationSourceReference] = useState("");
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [isApplyingCancellation, setIsApplyingCancellation] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const response = await getCaseDetailAction({ caseId });
    setLoading(false);
    if (!response.ok) {
      setLoadError(response.message);
      return;
    }
    setDetail(response.detail);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadForCase() {
      setToStatus("");
      setRationale("");
      setConfirmedEvidenceReviewed(false);
      setConfirmedSupportable(false);
      setClassifyError(null);
      setShowCancellationForm(false);
      setCancellationFeeAmount("");
      setCancellationSourceReference("");
      setCancellationError(null);
      setLoading(true);
      setLoadError(null);
      const response = await getCaseDetailAction({ caseId });
      if (cancelled) return;
      setLoading(false);
      if (!response.ok) {
        setLoadError(response.message);
        return;
      }
      setDetail(response.detail);
    }
    loadForCase();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  async function handleClassify() {
    if (!toStatus || rationale.trim().length === 0) return;
    setIsClassifying(true);
    setClassifyError(null);
    try {
      const response = await classifyCaseAction({
        caseId,
        toStatus,
        rationale,
        confirmedEvidenceReviewed,
        confirmedSupportable,
      });
      if (!response.ok) {
        setClassifyError(response.message);
        return;
      }
      setToStatus("");
      setRationale("");
      setConfirmedEvidenceReviewed(false);
      setConfirmedSupportable(false);
      await load();
      onChanged();
    } finally {
      setIsClassifying(false);
    }
  }

  async function handleApplyCancellation() {
    if (!cancellationFeeAmount.trim() || !cancellationSourceReference.trim()) return;
    setIsApplyingCancellation(true);
    setCancellationError(null);
    try {
      const response = await applyCancellationOverrideAction({
        caseId,
        cancellationFeeAmount,
        sourceReference: cancellationSourceReference,
      });
      if (!response.ok) {
        setCancellationError(response.message);
        return;
      }
      onChanged();
      onClose();
    } finally {
      setIsApplyingCancellation(false);
    }
  }

  const selectedTaxonomy = toStatus ? getTaxonomyDefinition(toStatus) : undefined;
  const canSubmitClassification =
    Boolean(toStatus) &&
    rationale.trim().length > 0 &&
    (!selectedTaxonomy?.requiresExtraConfirmation || (confirmedEvidenceReviewed && confirmedSupportable));

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailPanelHeader}>
        <div>
          <p className={styles.mutedText}>{restaurantLabel} · {aggregatorLabel}</p>
          <p className={styles.sectionTitle}>{detail?.orderRef ?? (detail?.scope === ReconciliationScope.BANK_CYCLE ? "Bank cycle" : "Case detail")}</p>
        </div>
        <button type="button" className={styles.linkButton} onClick={onClose}>Close</button>
      </div>

      {loading && <p className={styles.mutedText}>Loading…</p>}
      {loadError && <p className={styles.errorText}>{loadError}</p>}

      {detail && (
        <>
          {detail.isSuperseded && (
            <div className={styles.warningBanner}>This case has been superseded by a newer calculation and is read-only.</div>
          )}

          <div className={styles.amountsGrid}>
            <div><p className={styles.mutedText}>Expected</p><p>{formatAmount(detail.expectedAmount)}</p></div>
            <div><p className={styles.mutedText}>Actual</p><p>{formatAmount(detail.actualAmount)}</p></div>
            <div><p className={styles.mutedText}>Difference</p><p>{formatAmount(detail.difference)}</p></div>
          </div>
          <p className={styles.mutedText}>
            Positive difference means the restaurant appears to be owed money; negative means it was paid more than expected.
          </p>

          <section className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>Calculation breakdown (formula {detail.calculationFormulaVersion})</p>
            <dl className={styles.breakdownList}>
              {Object.entries(detail.calculationBreakdown)
                .filter(([, v]) => v !== null && v !== undefined && v !== false)
                .map(([key, value]) => (
                  <div key={key} className={styles.breakdownRow}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>Linked source records</p>
            {detail.linkedSettlements.map((r) => (
              <p key={r.id} className={styles.mutedText}>Settlement: {r.orderRef ?? "—"} · {formatAmount(r.amount)} · {formatDate(r.date)}</p>
            ))}
            {detail.linkedPos.map((r) => (
              <p key={r.id} className={styles.mutedText}>POS: {r.orderRef ?? "—"} · {formatAmount(r.amount)} · {formatDate(r.date)}</p>
            ))}
            {detail.linkedBank.map((r) => (
              <p key={r.id} className={styles.mutedText}>Bank: {formatAmount(r.amount)} · {formatDate(r.date)}</p>
            ))}
            {detail.linkedSettlements.length === 0 && detail.linkedPos.length === 0 && detail.linkedBank.length === 0 && (
              <p className={styles.mutedText}>No linked records.</p>
            )}
          </section>

          {detail.evidence.length > 0 && (
            <section className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Evidence</p>
              {detail.evidence.map((e) => (
                <p key={e.id} className={styles.mutedText}>
                  [{e.kind.replace(/_/g, " ").toLowerCase()}] {e.description}
                  {e.sourceReference && ` — ${e.sourceReference}`}
                </p>
              ))}
            </section>
          )}

          <section className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>Classification history</p>
            {detail.classificationHistory.length === 0 ? (
              <p className={styles.mutedText}>No classification recorded yet.</p>
            ) : (
              detail.classificationHistory.map((ev) => (
                <p key={ev.id} className={styles.mutedText}>
                  {formatDate(ev.createdAt)} — {ev.actorName}: {ev.fromStatus ?? "UNCLASSIFIED"} → {ev.toStatus}
                  <br />&ldquo;{ev.rationale}&rdquo;
                </p>
              ))
            )}
          </section>

          {!detail.isSuperseded && (
            <section className={styles.detailSection}>
              <p className={styles.detailSectionTitle}>Classify this case</p>
              <select
                className={styles.select}
                value={toStatus}
                onChange={(e) => {
                  setToStatus(e.target.value as ClassificationStatus);
                  setConfirmedEvidenceReviewed(false);
                  setConfirmedSupportable(false);
                }}
              >
                <option value="">Select a classification…</option>
                {CLASSIFICATION_TAXONOMY.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              {selectedTaxonomy && <p className={styles.mutedText}>{selectedTaxonomy.description}</p>}

              <textarea
                className={styles.textarea}
                placeholder="Rationale (required) — why this classification?"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />

              {selectedTaxonomy?.requiresExtraConfirmation && (
                <div className={styles.confirmGate}>
                  <label className={styles.checkboxRow}>
                    <input type="checkbox" checked={confirmedEvidenceReviewed} onChange={(e) => setConfirmedEvidenceReviewed(e.target.checked)} />
                    I have reviewed the supporting evidence for this case.
                  </label>
                  <label className={styles.checkboxRow}>
                    <input type="checkbox" checked={confirmedSupportable} onChange={(e) => setConfirmedSupportable(e.target.checked)} />
                    I consider this discrepancy supportable enough to pursue later. This does not file a dispute.
                  </label>
                </div>
              )}

              <div className={styles.actionsRow}>
                <button type="button" className={styles.primaryButton} onClick={handleClassify} disabled={!canSubmitClassification || isClassifying}>
                  {isClassifying ? "Saving…" : "Save classification"}
                </button>
                {classifyError && <span className={styles.errorText}>{classifyError}</span>}
              </div>
            </section>
          )}

          {!detail.isSuperseded && detail.scope === ReconciliationScope.ORDER_LEVEL && detail.actualAmount !== null && (
            <section className={styles.detailSection}>
              <button type="button" className={styles.linkButton} onClick={() => setShowCancellationForm((v) => !v)}>
                {showCancellationForm ? "Hide cancellation/void override" : "Mark as cancelled/voided under evidenced contract rule"}
              </button>
              {showCancellationForm && (
                <div className={styles.cancellationForm}>
                  <p className={styles.mutedText}>
                    Only use this when the order was cancelled or voided under a specific, evidenced contract rule — not a general
                    override. This supersedes the case and resets its classification to blank.
                  </p>
                  <input
                    className={styles.select}
                    placeholder="Evidenced cancellation fee amount"
                    value={cancellationFeeAmount}
                    onChange={(e) => setCancellationFeeAmount(e.target.value)}
                  />
                  <input
                    className={styles.select}
                    placeholder="Source reference (contract clause, document)"
                    value={cancellationSourceReference}
                    onChange={(e) => setCancellationSourceReference(e.target.value)}
                  />
                  <div className={styles.actionsRow}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={handleApplyCancellation}
                      disabled={isApplyingCancellation || !cancellationFeeAmount.trim() || !cancellationSourceReference.trim()}
                    >
                      {isApplyingCancellation ? "Applying…" : "Apply override"}
                    </button>
                    {cancellationError && <span className={styles.errorText}>{cancellationError}</span>}
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

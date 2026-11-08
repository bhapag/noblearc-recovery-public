"use client";

import { useEffect, useMemo, useState } from "react";
import { CalculationStatus, ClassificationStatus, ReconciliationScope } from "@/generated/prisma/enums";
import { formatINR, toMoney } from "@/lib/money";
import { CLASSIFICATION_TAXONOMY } from "@/lib/reconciliation/taxonomy";
import {
  getRecordCountsAction,
  listBankRecordsAction,
  listCasesAction,
  runBankReconciliationAction,
  runOrderReconciliationAction,
  type BankRecordOption,
  type ReconciliationCaseSummary,
  type RecordCounts,
  type RunBankResultView,
  type RunOrderResultView,
} from "./actions";
import { CaseDetailPanel } from "./CaseDetailPanel";
import styles from "./reconciliation.module.css";

interface Restaurant {
  id: string;
  name: string;
  code: string;
}
interface Aggregator {
  id: string;
  name: string;
  slug: string;
}

const CALCULATION_STATUS_FILTERS: { value: CalculationStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: CalculationStatus.CALCULATED, label: "Calculated" },
  { value: CalculationStatus.INSUFFICIENT_DATA, label: "Insufficient data" },
  { value: CalculationStatus.UNMATCHED, label: "Unmatched" },
];

const CLASSIFICATION_FILTERS: { value: ClassificationStatus | "ALL" | "UNCLASSIFIED_ONLY"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "UNCLASSIFIED_ONLY", label: "Unclassified only" },
  ...CLASSIFICATION_TAXONOMY.map((t) => ({ value: t.value, label: t.label })),
];

type SortMode = "recent" | "magnitude";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function formatAmount(value: string | null): string {
  if (value === null) return "—";
  return formatINR(toMoney(value));
}

export function ReconciliationWorkspace({ restaurants, aggregators }: { restaurants: Restaurant[]; aggregators: Aggregator[] }) {
  const [restaurantId, setRestaurantId] = useState("");
  const [aggregatorId, setAggregatorId] = useState("");
  const [periodStart, setPeriodStart] = useState(firstOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());

  const [counts, setCounts] = useState<RecordCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);

  const [commissionRatePercent, setCommissionRatePercent] = useState("");
  const [gstRatePercent, setGstRatePercent] = useState("");
  const [fixedFeeAmount, setFixedFeeAmount] = useState("");
  const [tdsRatePercent, setTdsRatePercent] = useState("");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [rateSourceReference, setRateSourceReference] = useState("");

  const [isRunningOrder, setIsRunningOrder] = useState(false);
  const [orderRunError, setOrderRunError] = useState<string | null>(null);
  const [orderRunResult, setOrderRunResult] = useState<RunOrderResultView | null>(null);

  const [cases, setCases] = useState<ReconciliationCaseSummary[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);

  const [bankRecords, setBankRecords] = useState<BankRecordOption[]>([]);
  const [selectedBankRecordId, setSelectedBankRecordId] = useState("");
  const [isRunningBank, setIsRunningBank] = useState(false);
  const [bankRunError, setBankRunError] = useState<string | null>(null);
  const [bankRunResult, setBankRunResult] = useState<RunBankResultView | null>(null);
  const [bankCases, setBankCases] = useState<ReconciliationCaseSummary[]>([]);

  const [calculationFilter, setCalculationFilter] = useState<CalculationStatus | "ALL">("ALL");
  const [classificationFilter, setClassificationFilter] = useState<ClassificationStatus | "ALL" | "UNCLASSIFIED_ONLY">("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("magnitude");

  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [showTaxonomyLegend, setShowTaxonomyLegend] = useState(false);

  const restaurant = useMemo(() => restaurants.find((r) => r.id === restaurantId), [restaurants, restaurantId]);
  const aggregator = useMemo(() => aggregators.find((a) => a.id === aggregatorId), [aggregators, aggregatorId]);
  const contextReady = Boolean(restaurantId && aggregatorId && periodStart && periodEnd && periodStart <= periodEnd);

  async function refreshCases() {
    if (!contextReady) return;
    setCasesLoading(true);
    try {
      const [orderResponse, bankResponse] = await Promise.all([
        listCasesAction({ restaurantId, aggregatorId, scope: ReconciliationScope.ORDER_LEVEL }),
        listCasesAction({ restaurantId, aggregatorId, scope: ReconciliationScope.BANK_CYCLE }),
      ]);
      if (orderResponse.ok) setCases(orderResponse.cases);
      if (bankResponse.ok) setBankCases(bankResponse.cases);
    } finally {
      setCasesLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadCounts() {
      setCounts(null);
      setCountsError(null);
      if (!contextReady) return;
      const response = await getRecordCountsAction({ restaurantId, aggregatorId, periodStart, periodEnd });
      if (cancelled) return;
      if (!response.ok) {
        setCountsError(response.message);
        return;
      }
      setCounts(response.counts);
    }
    loadCounts();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, aggregatorId, periodStart, periodEnd]);

  useEffect(() => {
    let cancelled = false;
    async function loadBankRecords() {
      setBankRecords([]);
      setSelectedBankRecordId("");
      if (!restaurantId || !periodStart || !periodEnd || periodStart > periodEnd) return;
      const response = await listBankRecordsAction({ restaurantId, periodStart, periodEnd });
      if (cancelled) return;
      if (response.ok) setBankRecords(response.records);
    }
    loadBankRecords();
    return () => {
      cancelled = true;
    };
  }, [restaurantId, periodStart, periodEnd]);

  useEffect(() => {
    let cancelled = false;
    async function loadCasesForContext() {
      setSelectedCaseId(null);
      if (!restaurantId || !aggregatorId) return;
      setCasesLoading(true);
      try {
        const [orderResponse, bankResponse] = await Promise.all([
          listCasesAction({ restaurantId, aggregatorId, scope: ReconciliationScope.ORDER_LEVEL }),
          listCasesAction({ restaurantId, aggregatorId, scope: ReconciliationScope.BANK_CYCLE }),
        ]);
        if (cancelled) return;
        if (orderResponse.ok) setCases(orderResponse.cases);
        if (bankResponse.ok) setBankCases(bankResponse.cases);
      } finally {
        if (!cancelled) setCasesLoading(false);
      }
    }
    loadCasesForContext();
    return () => {
      cancelled = true;
    };
  }, [restaurantId, aggregatorId]);

  async function handleRunOrder() {
    setIsRunningOrder(true);
    setOrderRunError(null);
    setOrderRunResult(null);
    try {
      const response = await runOrderReconciliationAction({
        restaurantId,
        aggregatorId,
        periodStart,
        periodEnd,
        rates: {
          commissionRatePercent,
          gstRatePercent,
          fixedFeeAmount,
          tdsRatePercent,
          adjustmentAmount,
          sourceReference: rateSourceReference,
        },
      });
      if (!response.ok) {
        setOrderRunError(response.message);
        return;
      }
      setOrderRunResult(response.result);
      // Any case currently open in the detail panel may have just been
      // superseded by this rerun — close it rather than leave stale
      // pre-rerun amounts/classification on screen with no indication
      // they're out of date.
      setSelectedCaseId(null);
      await refreshCases();
    } finally {
      setIsRunningOrder(false);
    }
  }

  async function handleRunBank() {
    if (!selectedBankRecordId) return;
    setIsRunningBank(true);
    setBankRunError(null);
    setBankRunResult(null);
    try {
      const response = await runBankReconciliationAction({
        restaurantId,
        aggregatorId,
        periodStart,
        periodEnd,
        bankRecordId: selectedBankRecordId,
      });
      if (!response.ok) {
        setBankRunError(response.message);
        return;
      }
      setBankRunResult(response.result);
      setSelectedCaseId(null);
      await refreshCases();
    } finally {
      setIsRunningBank(false);
    }
  }

  const filteredSortedCases = useMemo(() => {
    let list = cases;
    if (calculationFilter !== "ALL") list = list.filter((c) => c.calculationStatus === calculationFilter);
    if (classificationFilter === "UNCLASSIFIED_ONLY") list = list.filter((c) => c.status === ClassificationStatus.UNCLASSIFIED);
    else if (classificationFilter !== "ALL") list = list.filter((c) => c.status === classificationFilter);

    const sorted = [...list];
    if (sortMode === "magnitude") {
      sorted.sort((a, b) => {
        const magA = a.difference ? Math.abs(Number(a.difference)) : -1;
        const magB = b.difference ? Math.abs(Number(b.difference)) : -1;
        return magB - magA;
      });
    } else {
      sorted.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return sorted;
  }, [cases, calculationFilter, classificationFilter, sortMode]);

  const unclassifiedCount = cases.filter((c) => c.status === ClassificationStatus.UNCLASSIFIED).length;

  if (restaurants.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyStateTitle}>No restaurants configured yet</p>
        <p className={styles.emptyStateBody}>There are no active restaurant clients in the system to reconcile.</p>
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <div className={styles.mainColumn}>
        <section className={styles.card}>
          <p className={styles.sectionTitle}>1. Select scope</p>
          <div className={styles.contextRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="restaurant">Restaurant</label>
              <select id="restaurant" className={styles.select} value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)}>
                <option value="">Select…</option>
                {restaurants.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="aggregator">Aggregator</label>
              <select id="aggregator" className={styles.select} value={aggregatorId} onChange={(e) => setAggregatorId(e.target.value)}>
                <option value="">Select…</option>
                {aggregators.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="periodStart">Period start</label>
              <input id="periodStart" type="date" className={styles.select} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="periodEnd">Period end</label>
              <input id="periodEnd" type="date" className={styles.select} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
          </div>

          {contextReady && (
            <div className={styles.countsRow}>
              {countsError && <span className={styles.errorText}>{countsError}</span>}
              {counts && (
                <>
                  <span className={styles.countBadge}>{counts.settlementCount} settlement record(s)</span>
                  <span className={styles.countBadge}>{counts.posCount} POS record(s)</span>
                  <span className={styles.countBadge}>{counts.bankRecordCount} bank record(s)</span>
                  {counts.settlementCount === 0 && counts.posCount === 0 && (
                    <span className={styles.mutedText}>Nothing imported for this restaurant/aggregator/period yet.</span>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {contextReady && (
          <section className={styles.card}>
            <p className={styles.sectionTitle}>2. Calculation inputs (optional)</p>
            <p className={styles.mutedText}>
              Rates are operator-entered assumptions for this run, never platform defaults. Leave everything blank to see matches
              without a calculated expected amount — cases will be marked &ldquo;Insufficient data&rdquo; rather than guessing a rate.
            </p>
            <div className={styles.rateGrid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="commissionRate">Commission rate (%)</label>
                <input id="commissionRate" className={styles.select} value={commissionRatePercent} onChange={(e) => setCommissionRatePercent(e.target.value)} placeholder="e.g. 20" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="gstRate">GST on commission (%)</label>
                <input id="gstRate" className={styles.select} value={gstRatePercent} onChange={(e) => setGstRatePercent(e.target.value)} placeholder="e.g. 18" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="tdsRate">TDS rate (%)</label>
                <input id="tdsRate" className={styles.select} value={tdsRatePercent} onChange={(e) => setTdsRatePercent(e.target.value)} placeholder="e.g. 1" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fixedFee">Fixed fee</label>
                <input id="fixedFee" className={styles.select} value={fixedFeeAmount} onChange={(e) => setFixedFeeAmount(e.target.value)} placeholder="e.g. 5.00" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="adjustment">Manual adjustment (± signed)</label>
                <input id="adjustment" className={styles.select} value={adjustmentAmount} onChange={(e) => setAdjustmentAmount(e.target.value)} placeholder="e.g. -10.00" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="rateSource">Source / evidence reference</label>
                <input id="rateSource" className={styles.select} value={rateSourceReference} onChange={(e) => setRateSourceReference(e.target.value)} placeholder="e.g. Contract rate card v3, clause 4.2" />
              </div>
            </div>
            <div className={styles.actionsRow}>
              <button type="button" className={styles.primaryButton} onClick={handleRunOrder} disabled={isRunningOrder}>
                {isRunningOrder ? "Running…" : "Run order reconciliation"}
              </button>
              {orderRunError && <span className={styles.errorText}>{orderRunError}</span>}
            </div>
            {orderRunResult && (
              <p className={styles.runSummary}>
                Matched {orderRunResult.matchedCount} · Unmatched settlement {orderRunResult.unmatchedSettlementCount} · Unmatched POS {orderRunResult.unmatchedPosCount}
                {orderRunResult.ambiguousOrderRefCount > 0 && ` · ${orderRunResult.ambiguousOrderRefCount} ambiguous order ref(s) left unmatched`}
                {orderRunResult.casesSuperseded > 0 && ` · ${orderRunResult.casesSuperseded} prior case(s) superseded by this rerun`}
              </p>
            )}
          </section>
        )}

        {contextReady && (
          <section className={styles.card}>
            <p className={styles.sectionTitle}>3. Bank settlement cross-check (separate signal)</p>
            <p className={styles.mutedText}>
              Compares this period&rsquo;s total settlement amount against the bank credit. This never adjusts or is summed with the
              order-level cases above — a bank-level shortfall is its own case, classified independently.
            </p>
            {bankRecords.length === 0 ? (
              <p className={styles.mutedText}>No bank records imported for this restaurant/period.</p>
            ) : (
              <div className={styles.actionsRow}>
                <select className={styles.select} value={selectedBankRecordId} onChange={(e) => setSelectedBankRecordId(e.target.value)}>
                  <option value="">Select a bank credit…</option>
                  {bankRecords.map((b) => (
                    <option key={b.id} value={b.id}>
                      {new Date(b.date).toLocaleDateString()} — {formatAmount(b.amount)}
                    </option>
                  ))}
                </select>
                <button type="button" className={styles.primaryButton} onClick={handleRunBank} disabled={isRunningBank || !selectedBankRecordId}>
                  {isRunningBank ? "Running…" : "Run bank check"}
                </button>
                {bankRunError && <span className={styles.errorText}>{bankRunError}</span>}
              </div>
            )}
            {bankRunResult && (
              <p className={styles.runSummary}>
                Compared against {bankRunResult.settlementRecordCount} settlement record(s)
                {bankRunResult.caseSuperseded && " · prior bank-cycle case superseded by this rerun"}
              </p>
            )}
            {bankCases.length > 0 && (
              <ul className={styles.bankCaseList}>
                {bankCases.map((c) => (
                  <li key={c.id} className={styles.bankCaseRow} onClick={() => setSelectedCaseId(c.id)}>
                    <span>{c.periodStart ? new Date(c.periodStart).toLocaleDateString() : "—"} – {c.periodEnd ? new Date(c.periodEnd).toLocaleDateString() : "—"}</span>
                    <StatusBadges calculationStatus={c.calculationStatus} status={c.status} />
                    <span className={differenceClass(c.difference)}>{formatAmount(c.difference)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {contextReady && cases.length > 0 && (
          <section className={styles.card}>
            <div className={styles.resultsHeader}>
              <p className={styles.sectionTitle}>Order-level results ({filteredSortedCases.length})</p>
              <button type="button" className={styles.linkButton} onClick={() => setShowTaxonomyLegend((v) => !v)}>
                {showTaxonomyLegend ? "Hide" : "What do these classifications mean?"}
              </button>
            </div>

            {showTaxonomyLegend && (
              <ul className={styles.taxonomyLegend}>
                {CLASSIFICATION_TAXONOMY.map((t) => (
                  <li key={t.value}>
                    <strong>{t.label}</strong> — {t.description}
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.filterRow}>
              <label className={styles.filterLabel}>
                Calculation
                <select className={styles.select} value={calculationFilter} onChange={(e) => setCalculationFilter(e.target.value as CalculationStatus | "ALL")}>
                  {CALCULATION_STATUS_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </label>
              <label className={styles.filterLabel}>
                Classification
                <select className={styles.select} value={classificationFilter} onChange={(e) => setClassificationFilter(e.target.value as ClassificationStatus | "ALL" | "UNCLASSIFIED_ONLY")}>
                  {CLASSIFICATION_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </label>
              <label className={styles.filterLabel}>
                Sort
                <select className={styles.select} value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                  <option value="magnitude">Largest difference first</option>
                  <option value="recent">Most recently created</option>
                </select>
              </label>
              {unclassifiedCount > 0 && <span className={styles.countBadge}>{unclassifiedCount} unclassified</span>}
              {casesLoading && <span className={styles.mutedText}>Refreshing…</span>}
            </div>

            <div className={styles.tableScroll}>
              <table className={styles.resultsTable}>
                <thead>
                  <tr>
                    <th>Order ref</th>
                    <th>Calculation</th>
                    <th>Expected</th>
                    <th>Actual</th>
                    <th>Difference</th>
                    <th>Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSortedCases.map((c) => (
                    <tr key={c.id} className={styles.resultsRow} data-selected={c.id === selectedCaseId} onClick={() => setSelectedCaseId(c.id)}>
                      <td>{c.orderRef ?? <span className={styles.mutedText}>none</span>}</td>
                      <td><CalculationBadge value={c.calculationStatus} /></td>
                      <td>{formatAmount(c.expectedAmount)}</td>
                      <td>{formatAmount(c.actualAmount)}</td>
                      <td className={differenceClass(c.difference)}>{formatAmount(c.difference)}</td>
                      <td><ClassificationBadge value={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {contextReady && cases.length === 0 && orderRunResult && (
          <section className={styles.emptyState}>
            <p className={styles.emptyStateTitle}>No cases yet</p>
            <p className={styles.emptyStateBody}>The run completed but found nothing to reconcile for this period.</p>
          </section>
        )}
      </div>

      <div className={styles.detailColumn}>
        {selectedCaseId ? (
          <CaseDetailPanel
            caseId={selectedCaseId}
            onClose={() => setSelectedCaseId(null)}
            onChanged={refreshCases}
            restaurantLabel={restaurant ? `${restaurant.name} (${restaurant.code})` : ""}
            aggregatorLabel={aggregator?.name ?? ""}
          />
        ) : (
          <div className={styles.detailPlaceholder}>
            <p>Select a case to view its calculation, evidence, and classification.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadges({ calculationStatus, status }: { calculationStatus: string; status: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <CalculationBadge value={calculationStatus} />
      <ClassificationBadge value={status} />
    </span>
  );
}

function CalculationBadge({ value }: { value: string }) {
  return <span className={badgeClassForCalculation(value)}>{value.replace(/_/g, " ").toLowerCase()}</span>;
}

function badgeClassForCalculation(value: string): string {
  if (value === CalculationStatus.CALCULATED) return styles.badgeNeutral;
  return styles.badgeWarning;
}

function ClassificationBadge({ value }: { value: string }) {
  const className = value === ClassificationStatus.UNCLASSIFIED
    ? styles.badgeUnclassified
    : value === ClassificationStatus.CONFIRMED_DISCREPANCY
      ? styles.badgeDanger
      : styles.badgeAccent;
  const label = CLASSIFICATION_TAXONOMY.find((t) => t.value === value)?.label ?? "Unclassified";
  return <span className={className}>{label}</span>;
}

function differenceClass(value: string | null): string {
  if (value === null) return styles.mutedText;
  const num = Number(value);
  if (num === 0) return "";
  return num > 0 ? styles.differencePositive : styles.differenceNegative;
}

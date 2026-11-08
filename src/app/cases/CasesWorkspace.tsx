"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RecoveryCaseStatus } from "@/generated/prisma/enums";
import { formatINR, toMoney } from "@/lib/money";
import type { EligibleDiscrepancyOption } from "@/lib/recovery/eligible-discrepancy-picker";
import {
  createRecoveryCaseAction,
  listEligibleDiscrepanciesAction,
  listRecoveryCasesAction,
  type RecoveryCaseSummary,
} from "./actions";
import styles from "./cases.module.css";

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

function formatAmount(value: string): string {
  return formatINR(toMoney(value));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonthIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const STATUS_LABELS: Record<RecoveryCaseStatus, string> = {
  OPEN: "Open",
  REPORT_SENT: "Report sent",
  CLOSED: "Closed",
  AWAITING_RECOVERY: "Awaiting recovery",
  PARTIALLY_RECOVERED: "Partially recovered",
  RECOVERY_VERIFIED: "Recovery verified",
  RECOVERY_CLOSED_PARTIAL: "Recovery closed (partial)",
};

export function CasesWorkspace({ restaurants, aggregators }: { restaurants: Restaurant[]; aggregators: Aggregator[] }) {
  const router = useRouter();

  const [filterRestaurantId, setFilterRestaurantId] = useState("");
  const [filterAggregatorId, setFilterAggregatorId] = useState("");
  const [filterStatus, setFilterStatus] = useState<RecoveryCaseStatus | "ALL">("ALL");
  const [cases, setCases] = useState<RecoveryCaseSummary[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createRestaurantId, setCreateRestaurantId] = useState("");
  const [createAggregatorId, setCreateAggregatorId] = useState("");
  const [periodStart, setPeriodStart] = useState(firstOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [eligibleOptions, setEligibleOptions] = useState<EligibleDiscrepancyOption[] | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadCases() {
      setCasesLoading(true);
      try {
        const response = await listRecoveryCasesAction({
          restaurantId: filterRestaurantId || undefined,
          aggregatorId: filterAggregatorId || undefined,
          status: filterStatus === "ALL" ? undefined : filterStatus,
        });
        if (cancelled) return;
        if (response.ok) setCases(response.cases);
      } finally {
        if (!cancelled) setCasesLoading(false);
      }
    }
    loadCases();
    return () => {
      cancelled = true;
    };
  }, [filterRestaurantId, filterAggregatorId, filterStatus]);

  async function handleFindEligible() {
    if (!createRestaurantId || !createAggregatorId) return;
    setIsSearching(true);
    setPickerError(null);
    setEligibleOptions(null);
    setSelectedIds(new Set());
    try {
      const response = await listEligibleDiscrepanciesAction({
        restaurantId: createRestaurantId,
        aggregatorId: createAggregatorId,
        periodStart,
        periodEnd,
      });
      if (!response.ok) {
        setPickerError(response.message);
        return;
      }
      setEligibleOptions(response.options);
    } finally {
      setIsSearching(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (selectedIds.size === 0) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const response = await createRecoveryCaseAction({
        restaurantId: createRestaurantId,
        aggregatorId: createAggregatorId,
        reconciliationCaseIds: Array.from(selectedIds),
      });
      if (!response.ok) {
        setCreateError(response.message);
        return;
      }
      router.push(`/cases/${response.recoveryCaseId}`);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className={styles.layout}>
      <section className={styles.card}>
        <div className={styles.filterRow}>
          <label className={styles.filterLabel}>
            Restaurant
            <select className={styles.select} value={filterRestaurantId} onChange={(e) => setFilterRestaurantId(e.target.value)}>
              <option value="">All</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterLabel}>
            Aggregator
            <select className={styles.select} value={filterAggregatorId} onChange={(e) => setFilterAggregatorId(e.target.value)}>
              <option value="">All</option>
              {aggregators.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterLabel}>
            Status
            <select className={styles.select} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as RecoveryCaseStatus | "ALL")}>
              <option value="ALL">All</option>
              <option value="OPEN">Open</option>
              <option value="REPORT_SENT">Report sent</option>
              <option value="CLOSED">Closed</option>
            </select>
          </label>
          <button type="button" className={styles.primaryButton} onClick={() => setShowCreateForm((v) => !v)}>
            {showCreateForm ? "Cancel" : "New recovery case"}
          </button>
        </div>

        {showCreateForm && (
          <div className={styles.createForm}>
            <p className={styles.sectionTitle}>New recovery case</p>
            <div className={styles.contextRow}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="createRestaurant">Restaurant</label>
                <select id="createRestaurant" className={styles.select} value={createRestaurantId} onChange={(e) => setCreateRestaurantId(e.target.value)}>
                  <option value="">Select…</option>
                  {restaurants.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="createAggregator">Aggregator</label>
                <select id="createAggregator" className={styles.select} value={createAggregatorId} onChange={(e) => setCreateAggregatorId(e.target.value)}>
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
            <div className={styles.actionsRow}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={handleFindEligible}
                disabled={!createRestaurantId || !createAggregatorId || isSearching}
              >
                {isSearching ? "Searching…" : "Find eligible Confirmed Discrepancy items"}
              </button>
              {pickerError && <span className={styles.errorText}>{pickerError}</span>}
            </div>

            {eligibleOptions && (
              <>
                {eligibleOptions.length === 0 ? (
                  <p className={styles.mutedText}>
                    No eligible Confirmed Discrepancy items found for this restaurant/aggregator/period (already-linked
                    items and items outside this date range are excluded).
                  </p>
                ) : (
                  <div className={styles.tableScroll}>
                    <table className={styles.resultsTable}>
                      <thead>
                        <tr>
                          <th></th>
                          <th>Scope</th>
                          <th>Order ref / period</th>
                          <th>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {eligibleOptions.map((o) => (
                          <tr key={o.id} className={styles.resultsRow} onClick={() => toggleSelected(o.id)} data-selected={selectedIds.has(o.id)}>
                            <td>
                              <input type="checkbox" checked={selectedIds.has(o.id)} onChange={() => toggleSelected(o.id)} onClick={(e) => e.stopPropagation()} />
                            </td>
                            <td>{o.scope === "BANK_CYCLE" ? "Bank cycle" : "Order level"}</td>
                            <td>
                              {o.orderRef ?? (o.periodStart && o.periodEnd ? `${new Date(o.periodStart).toLocaleDateString()} – ${new Date(o.periodEnd).toLocaleDateString()}` : "—")}
                            </td>
                            <td>{formatAmount(o.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className={styles.actionsRow}>
                  <button type="button" className={styles.primaryButton} onClick={handleCreate} disabled={selectedIds.size === 0 || isCreating}>
                    {isCreating ? "Creating…" : `Create recovery case (${selectedIds.size} selected)`}
                  </button>
                  {createError && <span className={styles.errorText}>{createError}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <p className={styles.sectionTitle}>Cases ({cases.length}){casesLoading && <span className={styles.mutedText}> · refreshing…</span>}</p>
        {cases.length === 0 ? (
          <p className={styles.mutedText}>No recovery cases match these filters yet.</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.resultsTable}>
              <thead>
                <tr>
                  <th>Restaurant</th>
                  <th>Aggregator</th>
                  <th>Status</th>
                  <th>Linked</th>
                  <th>Confirmed total</th>
                  <th>Evidence</th>
                  <th>Client response</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} className={styles.resultsRow} onClick={() => router.push(`/cases/${c.id}`)}>
                    <td>{c.restaurantName} ({c.restaurantCode})</td>
                    <td>{c.aggregatorName}</td>
                    <td><span className={styles.badgeNeutral}>{STATUS_LABELS[c.status]}</span></td>
                    <td>{c.linkedCount}</td>
                    <td>
                      {formatAmount(c.confirmedTotal)}
                      {c.hasUnresolvedOverlap && <span className={styles.badgeWarning} style={{ marginLeft: 6 }}>overlap unresolved</span>}
                    </td>
                    <td><span className={c.evidenceReady ? styles.badgeAccent : styles.badgeWarning}>{c.evidenceReady ? "Ready" : "Incomplete"}</span></td>
                    <td>{c.clientResponseStatus}</td>
                    <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

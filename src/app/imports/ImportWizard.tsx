"use client";

import { useMemo, useState } from "react";
import { RecordKind } from "@/generated/prisma/enums";
import type { PreviewResult } from "@/lib/ingestion/types";
import { previewImportFileAction } from "./actions";
import { MappingStep } from "./MappingStep";
import styles from "./imports.module.css";

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

const SOURCE_TYPE_OPTIONS: { kind: RecordKind; label: string; description: string }[] = [
  { kind: RecordKind.SETTLEMENT, label: "Aggregator settlement", description: "A payout/settlement report from Swiggy, Zomato, or another platform." },
  { kind: RecordKind.POS, label: "POS orders", description: "An order export from the restaurant's point-of-sale system." },
  { kind: RecordKind.BANK, label: "Bank credits", description: "A bank statement or credit list showing settlement deposits." },
];

type WizardStep = "context" | "upload" | "mapping";

export function ImportWizard({
  restaurants,
  aggregators,
}: {
  restaurants: Restaurant[];
  aggregators: Aggregator[];
}) {
  const [step, setStep] = useState<WizardStep>("context");
  const [restaurantId, setRestaurantId] = useState("");
  const [kind, setKind] = useState<RecordKind | "">("");
  const [aggregatorId, setAggregatorId] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const contextComplete = restaurantId !== "" && kind !== "" && (kind !== RecordKind.SETTLEMENT || aggregatorId !== "");

  function handleKindChange(nextKind: RecordKind) {
    setKind(nextKind);
    // Aggregator only applies to SETTLEMENT — clear it on any other choice so
    // a stale selection can never leak onto a POS/Bank import's provenance.
    if (nextKind !== RecordKind.SETTLEMENT) setAggregatorId("");
  }

  const restaurant = useMemo(() => restaurants.find((r) => r.id === restaurantId), [restaurants, restaurantId]);
  const aggregator = useMemo(() => aggregators.find((a) => a.id === aggregatorId), [aggregators, aggregatorId]);

  if (restaurants.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyStateTitle}>No restaurants configured yet</p>
        <p className={styles.emptyStateBody}>
          There are no active restaurant clients in the system, so there is
          nothing to import a file for. Restaurant setup is not part of this
          screen.
        </p>
      </div>
    );
  }

  async function handleFileSelected(selected: File) {
    setFile(selected);
    setUploadError(null);
    setPreview(null);
    setIsPreviewing(true);
    try {
      const formData = new FormData();
      formData.set("restaurantId", restaurantId);
      formData.set("file", selected);
      const response = await previewImportFileAction(formData);
      if (!response.ok) {
        setUploadError(response.message);
        return;
      }
      setPreview(response.result);
      setStep("mapping");
    } catch {
      setUploadError("Something went wrong while reading the file. Please try again.");
    } finally {
      setIsPreviewing(false);
    }
  }

  function resetToUpload() {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setUploadError(null);
  }

  return (
    <div className={styles.wizard}>
      <ol className={styles.steps}>
        <StepIndicator index={1} label="Restaurant & source" active={step === "context"} done={contextComplete && step !== "context"} />
        <StepIndicator index={2} label="Upload" active={step === "upload"} done={step === "mapping"} />
        <StepIndicator index={3} label="Map & import" active={step === "mapping"} done={false} />
      </ol>

      {step === "context" && (
        <section className={styles.card}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="restaurant">Restaurant</label>
            <select
              id="restaurant"
              className={styles.select}
              value={restaurantId}
              onChange={(event) => setRestaurantId(event.target.value)}
            >
              <option value="">Select a restaurant…</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>Source type</span>
            <div className={styles.radioGroup}>
              {SOURCE_TYPE_OPTIONS.map((option) => (
                <label key={option.kind} className={styles.radioCard} data-checked={kind === option.kind}>
                  <input
                    type="radio"
                    name="kind"
                    value={option.kind}
                    checked={kind === option.kind}
                    onChange={() => handleKindChange(option.kind)}
                  />
                  <div>
                    <div className={styles.radioCardLabel}>{option.label}</div>
                    <div className={styles.radioCardDescription}>{option.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {kind === RecordKind.SETTLEMENT && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="aggregator">Aggregator</label>
              <select
                id="aggregator"
                className={styles.select}
                value={aggregatorId}
                onChange={(event) => setAggregatorId(event.target.value)}
              >
                <option value="">Select an aggregator…</option>
                {aggregators.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            className={styles.primaryButton}
            disabled={!contextComplete}
            onClick={() => setStep("upload")}
          >
            Continue
          </button>
        </section>
      )}

      {step === "upload" && (
        <section className={styles.card}>
          <div className={styles.contextSummary}>
            <span>{restaurant?.name}</span>
            <span className={styles.contextSummarySep}>·</span>
            <span>{SOURCE_TYPE_OPTIONS.find((o) => o.kind === kind)?.label}</span>
            {aggregator && (
              <>
                <span className={styles.contextSummarySep}>·</span>
                <span>{aggregator.name}</span>
              </>
            )}
            <button type="button" className={styles.linkButton} onClick={() => setStep("context")}>
              Change
            </button>
          </div>

          <label className={styles.dropzone} data-busy={isPreviewing}>
            <input
              type="file"
              accept=".csv,.xlsx"
              className={styles.hiddenInput}
              disabled={isPreviewing}
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void handleFileSelected(selected);
              }}
            />
            {isPreviewing ? (
              <span>Reading {file?.name}…</span>
            ) : (
              <span>Click to choose a CSV or XLSX file (up to 10 MB)</span>
            )}
          </label>

          {uploadError && <p className={styles.errorText} role="alert">{uploadError}</p>}
        </section>
      )}

      {step === "mapping" && preview && kind !== "" && (
        <MappingStep
          kind={kind}
          restaurantId={restaurantId}
          aggregatorId={aggregatorId || undefined}
          file={file!}
          preview={preview}
          onStartOver={resetToUpload}
        />
      )}
    </div>
  );
}

function StepIndicator({ index, label, active, done }: { index: number; label: string; active: boolean; done: boolean }) {
  return (
    <li className={styles.step} data-active={active} data-done={done}>
      <span className={styles.stepDot}>{done ? "✓" : index}</span>
      <span>{label}</span>
    </li>
  );
}

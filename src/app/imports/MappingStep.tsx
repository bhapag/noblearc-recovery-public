"use client";

import { useMemo, useState } from "react";
import type { RecordKind } from "@/generated/prisma/enums";
import { getCanonicalFields } from "@/lib/ingestion/canonical-fields";
import { validateMapping } from "@/lib/ingestion/validate-mapping";
import { DATE_FORMAT_OPTIONS, type ColumnMapping, type CommitImportResult, type DateFormatKey, type PreviewResult } from "@/lib/ingestion/types";
import { commitImportAction } from "./actions";
import styles from "./imports.module.css";

const SAMPLE_PREVIEW_ROWS = 5;
const MAX_ERRORS_SHOWN = 50;

export function MappingStep({
  kind,
  restaurantId,
  aggregatorId,
  file,
  preview,
  onStartOver,
}: {
  kind: RecordKind;
  restaurantId: string;
  aggregatorId?: string;
  file: File;
  preview: PreviewResult;
  onStartOver: () => void;
}) {
  const fields = useMemo(() => getCanonicalFields(kind), [kind]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dateFormat, setDateFormat] = useState<DateFormatKey | "">("");
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<CommitImportResult | null>(null);

  const mappingErrors = useMemo(() => validateMapping(kind, preview.headers, mapping), [kind, preview.headers, mapping]);
  const dateFieldMapped = fields.some((field) => field.dataType === "date" && mapping[field.key]);
  const dateFormatMissing = dateFieldMapped && dateFormat === "";
  const hasDuplicate = Boolean(preview.duplicateOf) && !confirmDuplicate;
  const canSubmit = mappingErrors.length === 0 && !dateFormatMissing && !hasDuplicate && !isSubmitting;

  function setFieldColumn(fieldKey: string, column: string) {
    setMapping((current) => {
      const next = { ...current };
      if (column === "") delete next[fieldKey];
      else next[fieldKey] = column;
      return next;
    });
  }

  function columnOptionsFor(fieldKey: string): string[] {
    const usedElsewhere = new Set(
      Object.entries(mapping)
        .filter(([key]) => key !== fieldKey)
        .map(([, column]) => column),
    );
    return preview.headers.filter((header) => !usedElsewhere.has(header));
  }

  async function handleSubmit() {
    setIsSubmitting(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.set("kind", kind);
      formData.set("restaurantId", restaurantId);
      if (aggregatorId) formData.set("aggregatorId", aggregatorId);
      formData.set("file", file);
      formData.set("mapping", JSON.stringify(mapping));
      formData.set("dateFormat", dateFormat);
      formData.set("confirmDuplicate", String(confirmDuplicate));
      const response = await commitImportAction(formData);
      setResult(response);
      if (response.status === "duplicate") setConfirmDuplicate(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (result?.status === "success") {
    return (
      <section className={`${styles.card} ${styles.successPanel}`}>
        <p className={styles.resultTitle}>Import complete</p>
        <p>
          {result.rowsImported} row{result.rowsImported === 1 ? "" : "s"} imported from{" "}
          <strong>{file.name}</strong>.
        </p>
        {result.rowsSkippedBlank > 0 && (
          <p className={styles.mutedText}>
            {result.rowsSkippedBlank} row{result.rowsSkippedBlank === 1 ? "" : "s"} were blank across every mapped
            column and skipped (not imported, not an error).
          </p>
        )}
        <button type="button" className={styles.primaryButton} onClick={onStartOver}>
          Import another file
        </button>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <div className={styles.mappingLayout}>
        <div>
          <h2 className={styles.sectionTitle}>Preview</h2>
          <p className={styles.mutedText}>
            {file.name} — {preview.totalRowCount} data row{preview.totalRowCount === 1 ? "" : "s"} detected
          </p>
          <div className={styles.tableScroll}>
            <table className={styles.previewTable}>
              <thead>
                <tr>
                  {preview.headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sampleRows.slice(0, SAMPLE_PREVIEW_ROWS).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {preview.headers.map((_, columnIndex) => (
                      <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className={styles.sectionTitle}>Map columns</h2>
          <table className={styles.mappingTable}>
            <thead>
              <tr>
                <th>Canonical field</th>
                <th>Source column</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.key}>
                  <td>
                    {field.label}
                    {field.required && <span className={styles.requiredBadge}>Required</span>}
                  </td>
                  <td>
                    <select
                      className={styles.select}
                      value={mapping[field.key] ?? ""}
                      onChange={(event) => setFieldColumn(field.key, event.target.value)}
                    >
                      <option value="">— not mapped —</option>
                      {columnOptionsFor(field.key).map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {dateFieldMapped && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="dateFormat">Date format used in this file</label>
              <select
                id="dateFormat"
                className={styles.select}
                value={dateFormat}
                onChange={(event) => setDateFormat(event.target.value as DateFormatKey)}
              >
                <option value="">Select the format…</option>
                {DATE_FORMAT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>
          )}

          {mappingErrors.length > 0 && (
            <ul className={styles.errorList}>
              {mappingErrors.map((error, index) => (
                <li key={index} className={styles.errorText}>{error.message}</li>
              ))}
            </ul>
          )}

          {preview.duplicateOf && (
            <div className={styles.warningBanner}>
              <p>
                This exact file was already imported on{" "}
                {new Date(preview.duplicateOf.uploadedAt).toLocaleString()} (as{" "}
                {preview.duplicateOf.filename}).
              </p>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={confirmDuplicate}
                  onChange={(event) => setConfirmDuplicate(event.target.checked)}
                />
                Import anyway
              </label>
            </div>
          )}

          {result?.status === "validation_error" && (
            <ValidationErrors result={result} />
          )}

          {result?.status === "file_error" && (
            <p className={styles.errorText} role="alert">{result.message}</p>
          )}

          <div className={styles.actionsRow}>
            <button type="button" className={styles.linkButton} onClick={onStartOver}>
              Start over
            </button>
            <button type="button" className={styles.primaryButton} disabled={!canSubmit} onClick={handleSubmit}>
              {isSubmitting ? "Validating & importing…" : "Validate & import"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ValidationErrors({ result }: { result: Extract<CommitImportResult, { status: "validation_error" }> }) {
  const total = result.mappingErrors.length + result.rowErrors.length;
  return (
    <div className={styles.errorBanner}>
      <p className={styles.errorBannerTitle}>
        Import rejected — {total} problem{total === 1 ? "" : "s"} found. Nothing was imported.
      </p>
      {result.rowErrors.length > 0 && (
        <div className={styles.tableScroll}>
          <table className={styles.errorTable}>
            <thead>
              <tr>
                <th>Row</th>
                <th>Field</th>
                <th>Value</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {result.rowErrors.slice(0, MAX_ERRORS_SHOWN).map((error, index) => (
                <tr key={index}>
                  <td>{error.rowNumber}</td>
                  <td>{error.field}</td>
                  <td><code>{error.value || "(empty)"}</code></td>
                  <td>{error.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.rowErrors.length > MAX_ERRORS_SHOWN && (
        <p className={styles.mutedText}>
          Showing the first {MAX_ERRORS_SHOWN} of {result.rowErrors.length} row errors.
        </p>
      )}
    </div>
  );
}

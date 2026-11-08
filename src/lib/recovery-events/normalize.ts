/**
 * Deterministic normalization for a free-text evidence reference, used only
 * for duplicate detection (the partial unique index in the Phase 5
 * migration keys on this column, never on the raw `evidenceReference`).
 * Trims, collapses internal whitespace, and lowercases — enough to catch
 * "UTR 123456" vs "utr  123456 " as the same reference without attempting
 * any fuzzy/semantic matching, which would risk false-positive collisions.
 */
export function normalizeEvidenceReference(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

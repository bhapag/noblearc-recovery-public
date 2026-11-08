import type { Prisma } from "@/generated/prisma/client";
import type { EvidenceSnapshot } from "./types";

/**
 * Freezes exactly what was relied upon at submission time into a
 * self-contained JSON blob — never a live pointer. Uses the most recently
 * SENT FindingsReport (its own `content` is already an immutable, versioned
 * snapshot from Phase 3 — this copies it forward rather than re-deriving
 * anything), plus the CURRENT EvidenceItem rows copied by value. Both are
 * embedded directly in the returned object so later mutation of either the
 * live evidence pack or generation of new report versions can never alter
 * this snapshot once written.
 */
export async function buildEvidenceSnapshot(
  tx: Prisma.TransactionClient,
  recoveryCaseId: string,
): Promise<{ ok: true; snapshot: EvidenceSnapshot; findingsReportId: string; findingsReportVersion: number } | { ok: false; message: string }> {
  const recoveryCase = await tx.recoveryCase.findUnique({
    where: { id: recoveryCaseId },
    include: { restaurant: true, aggregator: true },
  });
  if (!recoveryCase) {
    return { ok: false, message: "Recovery case not found." };
  }

  const sentReport = await tx.findingsReport.findFirst({
    where: { recoveryCaseId, sentAt: { not: null } },
    orderBy: { version: "desc" },
  });
  // A sent report must always exist by the time a case is client-approved
  // (approval requires a report to have been sent first — see Phase 3's
  // client-response.ts), but fall back to the latest generated report
  // rather than crashing if that invariant is ever violated.
  const report = sentReport ?? (await tx.findingsReport.findFirst({ where: { recoveryCaseId }, orderBy: { version: "desc" } }));
  if (!report) {
    return { ok: false, message: "No findings report exists for this recovery case yet — generate and send one before submitting a dispute." };
  }

  const evidenceItems = await tx.evidenceItem.findMany({
    where: { recoveryCaseId },
    include: { category: true },
  });

  const snapshot: EvidenceSnapshot = {
    findingsReportId: report.id,
    findingsReportVersion: report.version,
    findingsReportContent: report.content as Record<string, unknown>,
    evidenceItemsAtSubmission: evidenceItems.map((e) => ({
      categoryCode: e.categoryCode,
      categoryLabel: e.category.label,
      reference: e.reference,
      note: e.note,
    })),
    restaurantName: recoveryCase.restaurant.name,
    restaurantCode: recoveryCase.restaurant.code,
    aggregatorName: recoveryCase.aggregator.name,
    snapshotTakenAt: new Date().toISOString(),
  };

  return { ok: true, snapshot, findingsReportId: report.id, findingsReportVersion: report.version };
}

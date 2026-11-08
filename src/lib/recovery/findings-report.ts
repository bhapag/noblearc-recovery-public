import { RecoveryCaseEventKind, RecoveryCaseStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { computeConfirmedTotal } from "./confirmed-total";
import { computeEvidenceReadiness } from "./evidence";
import { recordRecoveryCaseEvent } from "./events";
import type { GenerateFindingsReportInput, GenerateFindingsReportResult, MarkReportSentInput, MarkReportSentResult } from "./types";

/**
 * Generates a new, versioned, immutable findings-report snapshot — never an
 * overwrite of a prior version. The RecoveryCase row is locked first so two
 * concurrent generate calls for the same case can never compute the same
 * next version number (closing the same class of race the migration SQL's
 * comment describes for linking).
 *
 * Deliberately not gated on evidence readiness: whether it's appropriate to
 * generate (or send) a report with incomplete evidence is left to the
 * operator's judgment, which computeEvidenceReadiness's result surfaces to
 * them, not the software's to decide. What IS guaranteed by construction is
 * the report content's separation of confirmed vs. blocked/unresolved
 * amounts — see computeConfirmedTotal's blockedAmount, which this content
 * always keeps a distinct field, never summed into confirmedDiscrepancyTotal.
 */
export async function generateFindingsReport(input: GenerateFindingsReportInput): Promise<GenerateFindingsReportResult> {
  return prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<{ id: string; status: RecoveryCaseStatus }[]>`
      SELECT "id", "status" FROM "recovery_cases" WHERE "id" = ${input.recoveryCaseId}::uuid FOR UPDATE
    `;
    const lockRow = lockRows[0];
    if (!lockRow) {
      return { ok: false, message: "Recovery case not found." };
    }
    if (lockRow.status === RecoveryCaseStatus.CLOSED) {
      return { ok: false, message: "This recovery case is closed." };
    }

    const recoveryCase = await tx.recoveryCase.findUniqueOrThrow({
      where: { id: input.recoveryCaseId },
      include: { restaurant: true, aggregator: true },
    });
    const confirmedTotal = await computeConfirmedTotal(input.recoveryCaseId);
    const readiness = await computeEvidenceReadiness(input.recoveryCaseId);

    const content = {
      recoveryCaseId: input.recoveryCaseId,
      restaurantName: recoveryCase.restaurant.name,
      restaurantCode: recoveryCase.restaurant.code,
      aggregatorName: recoveryCase.aggregator.name,
      generatedAt: new Date().toISOString(),
      // These two amounts must NEVER be combined — confirmedDiscrepancyTotal
      // is the only figure a client-facing report may present as
      // recoverable; unresolvedPendingAmount is explicitly separate.
      confirmedDiscrepancyTotal: confirmedTotal.includedTotal,
      unresolvedPendingAmount: confirmedTotal.blockedAmount,
      hasUnresolvedOverlap: confirmedTotal.hasUnresolvedOverlap,
      overlapReviewed: recoveryCase.overlapReviewed,
      overlapReviewNote: recoveryCase.overlapReviewNote,
      lineItems: confirmedTotal.lineItems,
      evidenceReady: readiness.ready,
      missingEvidenceCategoryCodes: readiness.missingCategoryCodes,
    };

    const maxVersion = await tx.findingsReport.aggregate({ where: { recoveryCaseId: input.recoveryCaseId }, _max: { version: true } });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;

    const report = await tx.findingsReport.create({
      data: {
        recoveryCaseId: input.recoveryCaseId,
        version: nextVersion,
        content: content as unknown as Prisma.InputJsonValue,
        generatedByActorId: input.actorId,
      },
    });

    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.REPORT_GENERATED,
      note: `Generated findings report v${nextVersion}.`,
      metadata: { reportId: report.id, version: nextVersion },
    });

    return { ok: true, reportId: report.id, version: nextVersion };
  });
}

/**
 * The manual "mark as sent" action — no automated delivery of any kind.
 * The first report ever marked sent for a case moves it OPEN → REPORT_SENT;
 * later reports (re-sends, or later versions) marked sent don't re-trigger
 * that transition since the case is already past it.
 */
export async function markReportSent(input: MarkReportSentInput): Promise<MarkReportSentResult> {
  if (!input.sentVia.trim()) {
    return { ok: false, message: "A channel or reference note is required to mark a report as sent." };
  }

  const report = await prisma.findingsReport.findUnique({ where: { id: input.reportId }, include: { recoveryCase: true } });
  if (!report) {
    return { ok: false, message: "Report not found." };
  }
  if (report.sentAt) {
    return { ok: false, message: "This report has already been marked as sent." };
  }
  if (report.recoveryCase.status === RecoveryCaseStatus.CLOSED) {
    return { ok: false, message: "This recovery case is closed." };
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.findingsReport.update({
      where: { id: input.reportId },
      data: { sentAt: now, sentByActorId: input.actorId, sentVia: input.sentVia.trim() },
    });

    if (report.recoveryCase.status === RecoveryCaseStatus.OPEN) {
      await tx.recoveryCase.update({
        where: { id: report.recoveryCaseId },
        data: { status: RecoveryCaseStatus.REPORT_SENT, reportSentAt: now },
      });
      await recordRecoveryCaseEvent(tx, {
        recoveryCaseId: report.recoveryCaseId,
        actorId: input.actorId,
        kind: RecoveryCaseEventKind.STATUS_CHANGED,
        note: "Report marked sent; case moved to Report Sent.",
        metadata: { fromStatus: RecoveryCaseStatus.OPEN, toStatus: RecoveryCaseStatus.REPORT_SENT },
      });
    }

    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: report.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.REPORT_MARKED_SENT,
      note: input.sentVia.trim(),
      metadata: { reportId: input.reportId, version: report.version },
    });
  });

  return { ok: true };
}

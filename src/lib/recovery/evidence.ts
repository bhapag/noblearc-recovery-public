import { RecoveryCaseEventKind, ReconciliationScope } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { recordRecoveryCaseEvent } from "./events";
import type { EvidenceReadinessResult, RemoveEvidenceItemInput, RemoveEvidenceItemResult, SetEvidenceItemInput, SetEvidenceItemResult } from "./types";

const BANK_CREDIT_EVIDENCE_CODE = "BankCreditEvidence";

/**
 * BankCreditEvidence's applicability rule, derived from linked data — never
 * a manual "bank evidence applicable" toggle. `isConditional` on
 * EvidenceCategory is a descriptive/UI flag; this function is the actual
 * behavioral rule. If a future category needs its own conditional rule, add
 * a branch here — a generic "isConditional" boolean alone can't express an
 * arbitrary applicability condition.
 */
export async function isBankCreditEvidenceApplicable(recoveryCaseId: string): Promise<boolean> {
  // Not filtered by releasedAt — see the same note in confirmed-total.ts.
  // Whether this case ever included a bank-cycle item is a permanent fact
  // about the case, unaffected by the discrepancy being released for reuse
  // once this case closes.
  const bankLink = await prisma.recoveryCaseReconciliationLink.findFirst({
    where: {
      recoveryCaseId,
      reconciliationCase: { scope: ReconciliationScope.BANK_CYCLE },
    },
  });
  return bankLink !== null;
}

/**
 * Deterministic presence-based readiness: READY iff an EvidenceItem row
 * exists for every currently-applicable category. This never judges
 * persuasiveness or correctness of the attached reference/note — only
 * whether the operator has marked the category covered.
 */
export async function computeEvidenceReadiness(recoveryCaseId: string): Promise<EvidenceReadinessResult> {
  const [categories, items, bankCreditEvidenceApplicable] = await Promise.all([
    prisma.evidenceCategory.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    prisma.evidenceItem.findMany({ where: { recoveryCaseId }, select: { categoryCode: true } }),
    isBankCreditEvidenceApplicable(recoveryCaseId),
  ]);

  const applicableCategories = categories.filter(
    (c) => !c.isConditional || (c.code === BANK_CREDIT_EVIDENCE_CODE && bankCreditEvidenceApplicable),
  );
  const presentCodes = new Set(items.map((i) => i.categoryCode));
  const missingCategoryCodes = applicableCategories.filter((c) => !presentCodes.has(c.code)).map((c) => c.code);

  return {
    ready: missingCategoryCodes.length === 0,
    bankCreditEvidenceApplicable,
    missingCategoryCodes,
  };
}

/** Add or update (upsert) the evidence for one category — presence, not a version history. */
export async function setEvidenceItem(input: SetEvidenceItemInput): Promise<SetEvidenceItemResult> {
  const reference = input.reference?.trim() || undefined;
  const note = input.note?.trim() || undefined;
  if (!reference && !note) {
    return { ok: false, message: "Provide a reference or a note for this evidence item." };
  }

  const category = await prisma.evidenceCategory.findUnique({ where: { code: input.categoryCode } });
  if (!category || !category.active) {
    return { ok: false, message: "Unknown or inactive evidence category." };
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.evidenceItem.findUnique({
      where: { recoveryCaseId_categoryCode: { recoveryCaseId: input.recoveryCaseId, categoryCode: input.categoryCode } },
    });

    await tx.evidenceItem.upsert({
      where: { recoveryCaseId_categoryCode: { recoveryCaseId: input.recoveryCaseId, categoryCode: input.categoryCode } },
      create: { recoveryCaseId: input.recoveryCaseId, categoryCode: input.categoryCode, reference, note, actorId: input.actorId },
      update: { reference, note, actorId: input.actorId },
    });

    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: existing ? RecoveryCaseEventKind.EVIDENCE_ITEM_UPDATED : RecoveryCaseEventKind.EVIDENCE_ITEM_ADDED,
      note: `${category.label}${reference ? ` — ${reference}` : ""}`,
      metadata: { categoryCode: input.categoryCode },
    });
  });

  return { ok: true };
}

export async function removeEvidenceItem(input: RemoveEvidenceItemInput): Promise<RemoveEvidenceItemResult> {
  const existing = await prisma.evidenceItem.findUnique({
    where: { recoveryCaseId_categoryCode: { recoveryCaseId: input.recoveryCaseId, categoryCode: input.categoryCode } },
  });
  if (!existing) {
    return { ok: false, message: "No evidence recorded for this category yet." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.evidenceItem.delete({ where: { id: existing.id } });
    await recordRecoveryCaseEvent(tx, {
      recoveryCaseId: input.recoveryCaseId,
      actorId: input.actorId,
      kind: RecoveryCaseEventKind.EVIDENCE_ITEM_REMOVED,
      note: null,
      metadata: { categoryCode: input.categoryCode },
    });
  });

  return { ok: true };
}


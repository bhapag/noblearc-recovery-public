"use server";

import { z } from "zod";
import { DeadlineConfidence, DisputeOutcome, SubmissionChannel } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { createDisputeSubmission } from "@/lib/dispute/create-submission";
import { setVerifiedDeadline } from "@/lib/dispute/set-verified-deadline";
import { addFollowUp } from "@/lib/dispute/follow-up";
import { recordDisposition } from "@/lib/dispute/disposition";
import { buildDeadlineView } from "@/lib/dispute/deadline";
import type { DeadlineView } from "@/lib/dispute/types";

/** Same known, documented no-authentication limitation as Phase 1/2/3. */
async function getSystemActorId(): Promise<string> {
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return systemActor.id;
}

const CHANNEL_VALUES = [
  SubmissionChannel.AGGREGATOR_PORTAL,
  SubmissionChannel.EMAIL,
  SubmissionChannel.OFFICIAL_SUPPORT,
  SubmissionChannel.OTHER_OFFICIAL_CHANNEL,
] as const;

export async function listDeadlineAssumptionPoliciesAction(
  input: unknown,
): Promise<{ ok: true; policies: { id: string; category: string | null; defaultDays: number; sourceNote: string }[] } | { ok: false; message: string }> {
  const parsed = z.object({ aggregatorId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid aggregator." };

  const policies = await prisma.deadlineAssumptionPolicy.findMany({
    where: { aggregatorId: parsed.data.aggregatorId, active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, category: true, defaultDays: true, sourceNote: true },
  });
  return { ok: true, policies };
}

const createSubmissionSchema = z.object({
  recoveryCaseId: z.string().uuid(),
  ticketOrReferenceNumber: z.string().optional(),
  channel: z.enum(CHANNEL_VALUES),
  submittedAt: z.string(),
  assumptionPolicyId: z.string().uuid().optional(),
});

export async function createDisputeSubmissionAction(input: unknown): Promise<{ ok: true; disputeSubmissionId: string } | { ok: false; message: string }> {
  const parsed = createSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid dispute submission request." };
  const submittedAt = new Date(parsed.data.submittedAt);
  if (Number.isNaN(submittedAt.getTime())) return { ok: false, message: "Invalid submission date." };

  const actorId = await getSystemActorId();
  return createDisputeSubmission({
    recoveryCaseId: parsed.data.recoveryCaseId,
    ticketOrReferenceNumber: parsed.data.ticketOrReferenceNumber,
    channel: parsed.data.channel,
    submittedAt,
    assumptionPolicyId: parsed.data.assumptionPolicyId,
    actorId,
  });
}

const VERIFIED_CONFIDENCE_VALUES = [
  DeadlineConfidence.VERIFIED_PLATFORM_POLICY,
  DeadlineConfidence.VERIFIED_CONTRACT,
  DeadlineConfidence.VERIFIED_PRIOR_CASE,
] as const;

const setVerifiedDeadlineSchema = z.object({
  disputeSubmissionId: z.string().uuid(),
  verifiedDeadline: z.string(),
  deadlineSourceEvidence: z.string().min(1),
  deadlineConfidence: z.enum(VERIFIED_CONFIDENCE_VALUES),
});

export async function setVerifiedDeadlineAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = setVerifiedDeadlineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid verified-deadline request." };
  const verifiedDeadline = new Date(parsed.data.verifiedDeadline);
  if (Number.isNaN(verifiedDeadline.getTime())) return { ok: false, message: "Invalid deadline date." };

  const actorId = await getSystemActorId();
  return setVerifiedDeadline({ ...parsed.data, verifiedDeadline, actorId });
}

const addFollowUpSchema = z.object({
  disputeSubmissionId: z.string().uuid(),
  occurredAt: z.string(),
  channel: z.enum(CHANNEL_VALUES),
  summary: z.string().min(1),
  aggregatorResponse: z.string().optional(),
  nextAction: z.string().optional(),
});

export async function addFollowUpAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = addFollowUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid follow-up request." };
  const occurredAt = new Date(parsed.data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, message: "Invalid follow-up date." };

  const actorId = await getSystemActorId();
  return addFollowUp({ ...parsed.data, occurredAt, actorId });
}

const recordDispositionSchema = z.object({
  disputeSubmissionId: z.string().uuid(),
  outcome: z.enum([DisputeOutcome.ACCEPTED, DisputeOutcome.PARTIALLY_ACCEPTED, DisputeOutcome.REJECTED, DisputeOutcome.UNRESOLVED]),
  decidedAt: z.string(),
  evidenceNote: z.string().min(1),
  aggregatorStatedAmount: z.string().optional(),
});

export async function recordDispositionAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = recordDispositionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid disposition request." };
  const decidedAt = new Date(parsed.data.decidedAt);
  if (Number.isNaN(decidedAt.getTime())) return { ok: false, message: "Invalid decision date." };
  if (parsed.data.aggregatorStatedAmount !== undefined && !/^-?\d+(\.\d+)?$/.test(parsed.data.aggregatorStatedAmount)) {
    return { ok: false, message: "Aggregator-stated amount must be a plain decimal number." };
  }

  const actorId = await getSystemActorId();
  return recordDisposition({ ...parsed.data, decidedAt, actorId });
}

export interface DisputeSubmissionSummary {
  id: string;
  ticketOrReferenceNumber: string | null;
  channel: string;
  submittedAt: string;
  isActive: boolean;
  supersededAt: string | null;
}

export interface DisputeSubmissionDetail extends DisputeSubmissionSummary {
  deadline: DeadlineView;
  assumptionPolicyId: string | null;
  evidenceSnapshot: Record<string, unknown>;
  followUps: {
    id: string;
    occurredAt: string;
    channel: string;
    actorName: string;
    summary: string;
    aggregatorResponse: string | null;
    nextAction: string | null;
    createdAt: string;
  }[];
  disposition: {
    outcome: string;
    decidedAt: string;
    decidedByActorName: string;
    evidenceNote: string;
    aggregatorStatedAmount: string | null;
  } | null;
}

export interface DisputeSectionView {
  eligibleForSubmission: boolean;
  ineligibleReason: string | null;
  activeSubmission: DisputeSubmissionDetail | null;
  submissionHistory: DisputeSubmissionSummary[];
}

export async function getDisputeSectionAction(input: unknown): Promise<{ ok: true; dispute: DisputeSectionView } | { ok: false; message: string }> {
  const parsed = z.object({ recoveryCaseId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid case id." };

  const recoveryCase = await prisma.recoveryCase.findUnique({ where: { id: parsed.data.recoveryCaseId } });
  if (!recoveryCase) return { ok: false, message: "Recovery case not found." };

  const submissions = await prisma.disputeSubmission.findMany({
    where: { recoveryCaseId: parsed.data.recoveryCaseId },
    orderBy: { createdAt: "desc" },
    include: {
      followUps: { orderBy: { occurredAt: "asc" }, include: { actor: true } },
      disposition: { include: { decidedByActor: true } },
    },
  });

  const active = submissions.find((s) => s.isActive) ?? null;

  let ineligibleReason: string | null = null;
  if (recoveryCase.status === "CLOSED") ineligibleReason = "This recovery case is closed.";
  else if (recoveryCase.clientResponseStatus !== "APPROVED") ineligibleReason = "This recovery case has not been client-approved.";
  else if (active?.disposition) ineligibleReason = "The active dispute submission already has a recorded disposition.";
  const eligibleForSubmission = ineligibleReason === null;

  function toSummary(s: (typeof submissions)[number]): DisputeSubmissionSummary {
    return {
      id: s.id,
      ticketOrReferenceNumber: s.ticketOrReferenceNumber,
      channel: s.channel,
      submittedAt: s.submittedAt.toISOString(),
      isActive: s.isActive,
      supersededAt: s.supersededAt?.toISOString() ?? null,
    };
  }

  function toDetail(s: (typeof submissions)[number]): DisputeSubmissionDetail {
    return {
      ...toSummary(s),
      deadline: buildDeadlineView(s),
      assumptionPolicyId: s.assumptionPolicyId,
      evidenceSnapshot: s.evidenceSnapshot as Record<string, unknown>,
      followUps: s.followUps.map((f) => ({
        id: f.id,
        occurredAt: f.occurredAt.toISOString(),
        channel: f.channel,
        actorName: f.actor.name,
        summary: f.summary,
        aggregatorResponse: f.aggregatorResponse,
        nextAction: f.nextAction,
        createdAt: f.createdAt.toISOString(),
      })),
      disposition: s.disposition
        ? {
            outcome: s.disposition.outcome,
            decidedAt: s.disposition.decidedAt.toISOString(),
            decidedByActorName: s.disposition.decidedByActor.name,
            evidenceNote: s.disposition.evidenceNote,
            aggregatorStatedAmount: s.disposition.aggregatorStatedAmount?.toString() ?? null,
          }
        : null,
    };
  }

  return {
    ok: true,
    dispute: {
      eligibleForSubmission,
      ineligibleReason,
      activeSubmission: active ? toDetail(active) : null,
      submissionHistory: submissions.filter((s) => !s.isActive).map(toSummary),
    },
  };
}

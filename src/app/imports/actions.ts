"use server";

import { z } from "zod";
import { RecordKind } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { commitImport } from "@/lib/ingestion/commit-import";
import { previewImportFile } from "@/lib/ingestion/preview-import";
import { FileParseError } from "@/lib/ingestion/parse-file";
import { DATE_FORMAT_OPTIONS, type CommitImportResult, type DateFormatKey, type PreviewResult } from "@/lib/ingestion/types";

const DATE_FORMAT_KEYS = DATE_FORMAT_OPTIONS.map((option) => option.key) as [DateFormatKey, ...DateFormatKey[]];

/**
 * Phase 1 has no authentication yet (out of scope for this phase — see
 * CLAUDE.md/PROJECT_STATE.md). Every import is attributed to the single
 * system Actor seeded in Phase 0 until real auth exists; this is a known,
 * documented limitation, not an oversight.
 */
async function getSystemActorId(): Promise<string> {
  const systemActor = await prisma.actor.findFirstOrThrow({ where: { isSystem: true } });
  return systemActor.id;
}

const previewSchema = z.object({
  restaurantId: z.string().uuid(),
});

export async function previewImportFileAction(
  formData: FormData,
): Promise<{ ok: true; result: PreviewResult } | { ok: false; message: string }> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, message: "No file was provided." };
  }
  const parsedInput = previewSchema.safeParse({ restaurantId: formData.get("restaurantId") });
  if (!parsedInput.success) {
    return { ok: false, message: "Missing or invalid restaurant selection." };
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await previewImportFile(parsedInput.data.restaurantId, file.name, bytes);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof FileParseError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

const commitSchema = z.object({
  kind: z.enum([RecordKind.SETTLEMENT, RecordKind.POS, RecordKind.BANK]),
  restaurantId: z.string().uuid(),
  aggregatorId: z.string().uuid().optional(),
  mapping: z.record(z.string(), z.string()),
  dateFormat: z.enum(DATE_FORMAT_KEYS),
  confirmDuplicate: z.boolean().optional(),
});

export async function commitImportAction(formData: FormData): Promise<CommitImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { status: "file_error", message: "No file was provided." };
  }

  let mapping: unknown;
  try {
    mapping = JSON.parse(String(formData.get("mapping") ?? "{}"));
  } catch {
    return { status: "file_error", message: "Mapping payload was malformed." };
  }

  const parsedInput = commitSchema.safeParse({
    kind: formData.get("kind"),
    restaurantId: formData.get("restaurantId"),
    aggregatorId: formData.get("aggregatorId") || undefined,
    mapping,
    dateFormat: formData.get("dateFormat"),
    confirmDuplicate: formData.get("confirmDuplicate") === "true",
  });
  if (!parsedInput.success) {
    return { status: "file_error", message: "Import request was invalid or incomplete." };
  }

  const uploadedByActorId = await getSystemActorId();
  const bytes = Buffer.from(await file.arrayBuffer());

  return commitImport({
    kind: parsedInput.data.kind,
    restaurantId: parsedInput.data.restaurantId,
    aggregatorId: parsedInput.data.aggregatorId,
    filename: file.name,
    bytes,
    mapping: parsedInput.data.mapping,
    dateFormat: parsedInput.data.dateFormat,
    uploadedByActorId,
    confirmDuplicate: parsedInput.data.confirmDuplicate,
  });
}

export async function getImportContextAction(): Promise<{
  restaurants: { id: string; name: string; code: string }[];
  aggregators: { id: string; name: string; slug: string }[];
}> {
  const [restaurants, aggregators] = await Promise.all([
    prisma.restaurant.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.aggregator.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true },
    }),
  ]);
  return { restaurants, aggregators };
}

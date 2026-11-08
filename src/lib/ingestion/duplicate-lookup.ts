import type { Prisma } from "@/generated/prisma/client";
import type { DuplicateSourceFile } from "./types";

/**
 * Shared by preview-import.ts (best-effort early warning) and
 * commit-import.ts (both an early fast-fail check and the final
 * lock-protected check inside the commit transaction) — one query
 * definition so the duplicate-detection rule can't drift between the two
 * call sites.
 */
export async function findDuplicateSourceFile(
  client: Prisma.TransactionClient,
  restaurantId: string,
  contentHash: string,
): Promise<DuplicateSourceFile | null> {
  const existing = await client.sourceFile.findFirst({
    where: { restaurantId, contentHash },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, filename: true, uploadedAt: true },
  });
  if (!existing) return null;
  return { sourceFileId: existing.id, filename: existing.filename, uploadedAt: existing.uploadedAt.toISOString() };
}

import { createHash } from "node:crypto";

/** Deterministic content fingerprint used for duplicate-import detection. */
export function hashFileContent(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

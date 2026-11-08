import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Storage abstraction for raw uploaded files. Phase 1 ships exactly one
 * adapter (local filesystem, dev-only — see the factory guard below).
 *
 * PRODUCTION GAP (tracked in PROJECT_STATE.md, not just here): before any
 * real deployment, this needs a real object-storage adapter (S3/R2/Blob).
 * Vercel's filesystem is ephemeral and not shared across invocations, so the
 * local adapter would silently lose files or serve them inconsistently in
 * that environment — which is why the factory below refuses to select it
 * outside development rather than leaving that failure implicit.
 */
export interface FileStorage {
  store(storageKey: string, bytes: Buffer): Promise<void>;
  retrieve(storageKey: string): Promise<Buffer>;
}

const UPLOAD_DIR = path.join(process.cwd(), ".data", "uploads");

/** Local-filesystem adapter. Development only — never selected in production, see getFileStorage(). */
class LocalDevFileStorage implements FileStorage {
  async store(storageKey: string, bytes: Buffer): Promise<void> {
    const filePath = this.resolvePath(storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  async retrieve(storageKey: string): Promise<Buffer> {
    return readFile(this.resolvePath(storageKey));
  }

  private resolvePath(storageKey: string): string {
    // storageKey is always a server-generated UUID-derived path (see
    // commit-import.ts) — never derived from user-supplied filenames — so
    // there is no path-traversal input to sanitize here. Defensively resolve
    // and confirm containment anyway.
    const resolved = path.resolve(UPLOAD_DIR, storageKey);
    if (!resolved.startsWith(UPLOAD_DIR + path.sep)) {
      throw new Error("Refusing to resolve a storage key outside the upload directory.");
    }
    return resolved;
  }
}

let cachedStorage: FileStorage | undefined;

/**
 * Refuses to hand back the local-disk adapter when NODE_ENV is production —
 * that would silently write to a filesystem that does not persist between
 * serverless invocations, rather than failing loudly. Phase 1 has no
 * production-ready adapter yet; this throw is the honest reflection of that.
 */
export function getFileStorage(): FileStorage {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No production-ready FileStorage adapter is configured. The local-filesystem " +
        "adapter is development-only and must not be used in production (see " +
        "PROJECT_STATE.md's storage production-gap note).",
    );
  }
  cachedStorage ??= new LocalDevFileStorage();
  return cachedStorage;
}

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma v7 has no built-in query engine — a driver adapter is required.
// A single PrismaClient (and its connection pool) is reused across the
// process; without this, Next.js dev-mode hot reloads would create a new
// pool on every edit and exhaust the database's connection limit.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma's default interactive-transaction budget is 5000 ms. Several of this
// application's transactions deliberately perform many sequential round trips
// while holding a `SELECT ... FOR UPDATE` lock — generateFindingsReport
// (Phase 3), createDisputeSubmission + buildEvidenceSnapshot (Phase 4), and
// createRecoveryEvent (Phase 5) each issue roughly 7-15 queries inside one
// transaction. Against a pooled Neon connection that sits close enough to the
// 5000 ms default that normal network jitter intermittently expires the
// transaction mid-write (observed overshoots: 5511 ms and 6346 ms, at three
// different call sites, always during setup and never as a logic failure).
//
// This raises the time budget only. It does NOT reduce the work inside those
// transactions, reorder or remove any lock, or weaken any concurrency
// protection — that in-transaction work is load-bearing for correctness (the
// evidence snapshot and the allocation-cap arithmetic must both be consistent
// under the lock they were taken with). The ceiling stays well below the
// integration tests' own per-test timeout so a genuinely stuck transaction
// still surfaces as a failure rather than hanging.
const INTERACTIVE_TRANSACTION_TIMEOUT_MS = 15_000;

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter, transactionOptions: { timeout: INTERACTIVE_TRANSACTION_TIMEOUT_MS } });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

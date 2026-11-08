import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Several test files run live-database integration tests against one
    // shared Neon connection. Running test FILES in parallel (Vitest's
    // default) means each file's worker opens its own connection pool
    // simultaneously, which can exhaust Neon's pooled-connection limit and
    // intermittently drop a connection mid-transaction — observed as a
    // flaky cleanup (afterEach) or a flaky concurrency assertion, in files
    // unrelated to whichever change is actually under test. Tests within a
    // file still run in the same order as before; this only serializes
    // file-to-file execution.
    fileParallelism: false,
    // Phase 2/3 integration tests round-trip live Neon several times per
    // test (multiple sequential service calls, each its own transaction) —
    // the 5s default is comfortably exceeded by legitimate tests well
    // before anything is actually wrong. Raised once here rather than
    // annotating every slow test individually.
    testTimeout: 15000,
  },
});

// Prisma v7 no longer auto-loads .env files for CLI commands (migrate, generate,
// db seed, etc). We use Node's built-in process.loadEnvFile() instead of adding
// a `dotenv` dependency — Node 20.6+ ships the same capability natively. This
// only affects Prisma CLI commands; Next.js loads .env on its own for the app.
try {
  process.loadEnvFile();
} catch {
  // No .env file yet (e.g. fresh clone before setup) — fall through to the
  // placeholder below so `prisma generate` (which needs no live connection)
  // still works on `npm install`. Commands that actually connect (migrate
  // dev, db seed, studio) will fail clearly against the placeholder host
  // instead of crashing here at config-load time.
}

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Prisma 7.10.0's Datasource type only has `url` and `shadowDatabaseUrl`
    // (verified against node_modules/@prisma/config/dist/index.d.ts) — no
    // `directUrl`, despite the bundled prisma-upgrade-v7 skill doc describing
    // one. Migrations already work fine against Neon's pooled connection
    // string alone. DIRECT_URL still exists in .env, unused here, in case a
    // future Prisma version adds real directUrl support.
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset",
  },
});

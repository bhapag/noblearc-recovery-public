// Loads .env for tests that need DATABASE_URL (integration tests). Uses
// Node's built-in loader rather than a `dotenv` dependency — see
// prisma7.config.ts for the same rationale.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — fine for pure unit tests that don't touch the DB.
}

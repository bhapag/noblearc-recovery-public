// Local development / QA convenience only — separate from prisma/seed.ts,
// which stays reference-data-only per its Phase 0 contract. This script
// seeds exactly one clearly-synthetic restaurant so the Phase 1 import
// wizard has something to select while testing. Never run against a real
// operating database; never represent this restaurant as real customer data.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const restaurant = await prisma.restaurant.upsert({
    where: { code: "QA-FIXTURE-001" },
    update: {},
    create: {
      name: "NobleArc QA Fixture Restaurant",
      code: "QA-FIXTURE-001",
      notes: "Synthetic fixture for manual/browser QA only — not a real client.",
    },
  });
  console.log(`Dev-seeded QA fixture restaurant (${restaurant.id}).`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

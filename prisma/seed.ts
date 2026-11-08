// Reference-data seeding only. Per product principle, synthetic data must
// never be modeled or seeded as if it were real customer history — this
// script seeds exactly the one system Actor and the known Aggregator
// platforms, and nothing resembling a restaurant, order, or settlement.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const AGGREGATORS = [
  { name: "Swiggy", slug: "swiggy" },
  { name: "Zomato", slug: "zomato" },
  { name: "Other", slug: "other" },
] as const;

// The six controlled Evidence Pack categories (Phase 3), in the approved
// operating toolkit's fixed order. Reference data, not an enum, so a
// labeling correction never requires a migration — see schema.prisma's
// EvidenceCategory doc comment. Do NOT add a "ClientWrittenApproval"
// category here: client approval's authoritative home is
// RecoveryCase.clientResponseStatus.
const EVIDENCE_CATEGORIES = [
  { code: "ExpectedVsActualCalculation", label: "Expected-vs-actual calculation attached", isConditional: false, sortOrder: 1 },
  { code: "ContractOrRateCardReference", label: "Contract / rate-card reference attached", isConditional: false, sortOrder: 2 },
  { code: "SettlementReportLineCopy", label: "Settlement report line copy attached", isConditional: false, sortOrder: 3 },
  { code: "PosRecordCopy", label: "POS record copy attached", isConditional: false, sortOrder: 4 },
  { code: "BankCreditEvidence", label: "Bank credit evidence attached", isConditional: true, sortOrder: 5 },
  { code: "FactualNarrative", label: "Factual narrative written (no accusations)", isConditional: false, sortOrder: 6 },
] as const;

async function main() {
  const systemActor = await prisma.actor.upsert({
    where: { email: "system@noblearc.internal" },
    update: {},
    create: {
      name: "System",
      email: "system@noblearc.internal",
      isSystem: true,
    },
  });

  for (const aggregator of AGGREGATORS) {
    await prisma.aggregator.upsert({
      where: { slug: aggregator.slug },
      update: { name: aggregator.name },
      create: aggregator,
    });
  }

  for (const category of EVIDENCE_CATEGORIES) {
    await prisma.evidenceCategory.upsert({
      where: { code: category.code },
      update: { label: category.label, isConditional: category.isConditional, sortOrder: category.sortOrder, active: true },
      create: category,
    });
  }

  console.log(
    `Seeded system actor (${systemActor.id}), ${AGGREGATORS.length} aggregators, and ${EVIDENCE_CATEGORIES.length} evidence categories.`,
  );
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

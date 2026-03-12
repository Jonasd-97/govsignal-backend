// prisma/seed.js — creates a test user for local development
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("password123", 12);

  const user = await prisma.user.upsert({
    where: { email: "demo@govsignal.io" },
    update: {},
    create: {
      email: "demo@govsignal.io",
      passwordHash,
      name: "Demo User",
      companyName: "Bastion Supply Group",
      naicsCode: "541512",
      setAside: "SDVOSBC",
      targetAgency: "Department of Defense",
      plan: "PRO",
      digestSettings: {
        create: { enabled: true, sendTime: "08:00", minScore: 60 },
      },
    },
  });

  console.log(`Seed complete. Demo user: ${user.email} / password123`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

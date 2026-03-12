const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { fetchAndScore } = require("../services/samService");
const emailService = require("../services/emailService");
const logger = require("../services/logger");

const prisma = new PrismaClient();

// ── DAILY DIGEST JOB ──
// Runs every hour, checks which PRO users have digest scheduled for this hour
function startDigestJob() {
  cron.schedule("0 * * * *", async () => {
    const hour = new Date().toISOString().slice(11, 16); // "HH:MM" UTC
    logger.info(`Digest job running for sendTime: ${hour}`);

    try {
      const users = await prisma.user.findMany({
        where: {
          plan: { in: ["PRO", "AGENCY"] },
          digestSettings: { enabled: true, sendTime: hour },
        },
        include: { digestSettings: true },
      });

      logger.info(`Sending digests to ${users.length} users`);

      for (const user of users) {
        try {
          const opps = await fetchAndScore(
            { daysBack: 1 }, // only new opportunities from last 24h
            user,
            user.samApiKey || process.env.SAM_GOV_API_KEY
          );

          const minScore = user.digestSettings?.minScore || 60;
          const filtered = opps.filter(o => o.score >= minScore);

          if (filtered.length > 0) {
            await emailService.sendDigest(user, filtered);
            await prisma.digestSettings.update({
              where: { userId: user.id },
              data: { lastSentAt: new Date() },
            });
          }
        } catch (err) {
          logger.error(`Digest failed for user ${user.id}:`, err);
        }
      }
    } catch (err) {
      logger.error("Digest job error:", err);
    }
  });

  logger.info("Digest job scheduled (runs hourly)");
}

// ── SAM.GOV SYNC JOB ──
// Runs every 6 hours — fetches latest opportunities into our cache
// Also checks saved searches for new matches and sends alerts
function startSamSyncJob() {
  cron.schedule("0 */6 * * *", async () => {
    logger.info("SAM.gov sync job running");

    try {
      const { normalizeOpportunity, fetchOpportunities, scoreOpportunity } = require("../services/samService");

      // Fetch with system key
      const raw = await fetchOpportunities({ daysBack: 1, limit: 100 });
      let synced = 0;

      for (const r of raw) {
        const data = normalizeOpportunity(r);
        await prisma.opportunity.upsert({
          where: { noticeId: data.noticeId },
          update: data,
          create: data,
        });
        synced++;
      }

      logger.info(`SAM.gov sync complete: ${synced} opportunities cached`);

      // Check saved searches for new matches
      const searches = await prisma.savedSearch.findMany({
        where: { alertOn: true },
        include: { user: true },
      });

      for (const search of searches) {
        const filters = search.filters;
        const searchOpps = await fetchOpportunities({ ...filters, daysBack: 1 });
        if (searchOpps.length > 0) {
          const scored = searchOpps.map(r => {
            const n = normalizeOpportunity(r);
            return { ...n, ...scoreOpportunity(n, search.user) };
          });
          await emailService.sendSearchAlert(search.user, search.name, scored);
        }
      }
    } catch (err) {
      logger.error("SAM.gov sync job error:", err);
    }
  });

  logger.info("SAM.gov sync job scheduled (runs every 6 hours)");
}

module.exports = { startDigestJob, startSamSyncJob };

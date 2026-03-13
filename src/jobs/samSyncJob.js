const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { normalizeOpportunity, fetchOpportunities, scoreOpportunity } = require("../services/samService");
const emailService = require("../services/emailService");
const logger = require("../services/logger");

const prisma = new PrismaClient();

// ── SAM.GOV SYNC JOB ──
// Runs every 6 hours — fetches latest opportunities into our cache
// Also checks saved searches for new matches and sends alerts
function startSamSyncJob() {
  cron.schedule("0 */6 * * *", async () => {
    logger.info("SAM.gov sync job running");

    try {
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

      // Check saved searches for new matches — only alert on opps newer than last alert
      const searches = await prisma.savedSearch.findMany({
        where: { alertOn: true },
        include: { user: true },
      });

      for (const search of searches) {
        try {
          const filters = search.filters;

          // FIX: only fetch opps since last alert to avoid duplicate notifications
          const lastAlerted = search.lastAlertedAt || new Date(0);
          const hoursSinceLast = (Date.now() - new Date(lastAlerted).getTime()) / 3600000;
          const daysBack = Math.max(1, Math.ceil(hoursSinceLast / 24));

          const searchOpps = await fetchOpportunities({ ...filters, daysBack });

          // Filter to only opps posted after last alert
          const newOpps = searchOpps.filter(r => {
            const posted = r.postedDate ? new Date(r.postedDate) : null;
            return posted && posted > new Date(lastAlerted);
          });

          if (newOpps.length > 0) {
            const scored = newOpps.map(r => {
              const n = normalizeOpportunity(r);
              return { ...n, ...scoreOpportunity(n, search.user) };
            });

            await emailService.sendSearchAlert(search.user, search.name, scored);

            // FIX: update lastAlertedAt so we don't re-send next cycle
            await prisma.savedSearch.update({
              where: { id: search.id },
              data: { lastAlertedAt: new Date() },
            });
          }
        } catch (err) {
          logger.error(`Saved search alert failed for search ${search.id}:`, err);
        }
      }
    } catch (err) {
      logger.error("SAM.gov sync job error:", err);
    }
  });

  logger.info("SAM.gov sync job scheduled (runs every 6 hours)");
}

module.exports = { startSamSyncJob, runSamSync };

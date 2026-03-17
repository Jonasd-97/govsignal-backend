const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { normalizeOpportunity, fetchOpportunities, scoreOpportunity } = require('../services/samService');
const emailService = require('../services/emailService');
const logger = require('../services/logger');

const prisma = new PrismaClient();
let syncTask;

async function runSamSyncCycle() {
  logger.info('SAM.gov sync job running');

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

  const searches = await prisma.savedSearch.findMany({
    where: { alertOn: true },
    include: { user: true },
  });

  for (const search of searches) {
    try {
      const filters = search.filters || {};
      const lastAlerted = search.lastAlertedAt || new Date(0);
      const hoursSinceLast = (Date.now() - new Date(lastAlerted).getTime()) / 3600000;
      const daysBack = Math.max(1, Math.ceil(hoursSinceLast / 24));
      const searchOpps = await fetchOpportunities({ ...filters, daysBack }, search.user.samApiKey || process.env.SAM_GOV_API_KEY);

      const newOpps = searchOpps.filter((r) => {
        const posted = r.postedDate ? new Date(r.postedDate) : null;
        return posted && posted > new Date(lastAlerted);
      });

      if (newOpps.length > 0) {
        const scored = newOpps.map((r) => {
          const n = normalizeOpportunity(r);
          return { ...n, ...scoreOpportunity(n, search.user) };
        });

        await emailService.sendSearchAlert(search.user, search.name, scored);
        await prisma.savedSearch.update({
          where: { id: search.id },
          data: { lastAlertedAt: new Date() },
        });
      }
    } catch (err) {
      logger.error(`Saved search alert failed for search ${search.id}:`, err);
    }
  }
}

function startSamSyncJob() {
  if (syncTask) return syncTask;
  syncTask = cron.schedule('0 */6 * * *', async () => {
    try {
      await runSamSyncCycle();
    } catch (err) {
      logger.error('SAM.gov sync job error:', err);
    }
  });
  logger.info('SAM.gov sync job scheduled (runs every 6 hours)');
  return syncTask;
}

module.exports = { startSamSyncJob, runSamSyncCycle };

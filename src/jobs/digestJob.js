const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { fetchAndScore } = require('../services/samService');
const emailService = require('../services/emailService');
const logger = require('../services/logger');

const prisma = new PrismaClient();
let digestTask;

function startDigestJob() {
  if (digestTask) return digestTask;

  digestTask = cron.schedule('0 * * * *', async () => {
    const hour = new Date().toISOString().slice(11, 16);
    logger.info(`Digest job running for sendTime: ${hour}`);

    try {
      const users = await prisma.user.findMany({
        where: {
          plan: { in: ['PRO', 'AGENCY'] },
          digestSettings: { enabled: true, sendTime: hour },
        },
        include: { digestSettings: true },
      });

      for (const user of users) {
        try {
          const opps = await fetchAndScore({ daysBack: 1 }, user, user.samApiKey || process.env.SAM_GOV_API_KEY);
          const minScore = user.digestSettings?.minScore || 60;
          const filtered = opps.filter((o) => o.score >= minScore);
          if (filtered.length > 0) {
            await emailService.sendDigest(user, filtered);
          }
          await prisma.digestSettings.update({
            where: { userId: user.id },
            data: { lastSentAt: new Date() },
          });
        } catch (err) {
          logger.error(`Digest failed for user ${user.id}:`, err);
        }
      }
    } catch (err) {
      logger.error('Digest job error:', err);
    }
  });

  logger.info('Digest job scheduled (runs hourly)');
  return digestTask;
}

module.exports = { startDigestJob };

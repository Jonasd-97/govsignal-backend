const cron = require('node-cron');
const { scoreOpportunity, extractValueInfo } = require('../services/samService');
const emailService = require('../services/emailService');
const logger = require('../services/logger');

let digestTask;

function startDigestJob(prisma) {
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
          // Query database instead of hitting SAM.gov
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);

          const opps = await prisma.opportunity.findMany({
            where: {
              postedDate: { gte: yesterday },
              OR: [
                { responseDeadline: null },
                { responseDeadline: { gte: new Date() } },
              ],
            },
            orderBy: { postedDate: 'desc' },
            take: 100,
          });

          const minScore = user.digestSettings?.minScore || 60;

          const scored = opps
            .map((opp) => {
              const valueInfo = extractValueInfo(opp.rawJson || opp);
              const scoring = scoreOpportunity(opp, user);
              return { ...opp, ...valueInfo, ...scoring };
            })
            .filter((o) => o.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);

          if (scored.length > 0) {
            await emailService.sendDigest(user, scored);
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

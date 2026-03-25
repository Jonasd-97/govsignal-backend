/**
 * samSyncJob.js
 * helixgov-backend/src/jobs/samSyncJob.js
 *
 * Runs nightly to pull fresh opportunities from SAM.gov into PostgreSQL.
 * Users search YOUR database — not SAM.gov directly. No rate limit issues.
 */

const cron = require('node-cron');
const logger = require('../services/logger');

const SAM_API_BASE = 'https://api.sam.gov/prod/opportunities/v2/search';

function formatSamDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

async function fetchPage(apiKey, fromDate, toDate, offset = 0) {
  const params = new URLSearchParams({
    api_key: apiKey,
    postedFrom: fromDate,
    postedTo: toDate,
    limit: '100',
    offset: String(offset),
    active: 'Yes',
  });

  const res = await fetch(`${SAM_API_BASE}?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAM.gov API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    opportunities: data.opportunitiesData || [],
    total: data.totalRecords || 0,
  };
}

function parseOpportunity(raw) {
  return {
    noticeId: raw.noticeId,
    title: raw.title || 'Untitled',
    agency: raw.department || raw.organizationHierarchy?.[0]?.name || null,
    subAgency: raw.subTier || raw.organizationHierarchy?.[1]?.name || null,
    naicsCode: raw.naicsCode || null,
    opportunityType: raw.type || null,
    setAsideType: raw.typeOfSetAside || null,
    setAsideDescription: raw.typeOfSetAsideDescription || null,
    postedDate: raw.postedDate ? new Date(raw.postedDate) : null,
    responseDeadline: raw.responseDeadLine ? new Date(raw.responseDeadLine) : null,
    archiveDate: raw.archiveDate ? new Date(raw.archiveDate) : null,
    description: raw.description || null,
    uiLink: raw.uiLink || `https://sam.gov/opp/${raw.noticeId}/view`,
    solicitationNumber: raw.solicitationNumber || null,
    placeOfPerformance: raw.placeOfPerformance?.state?.name || null,
    rawJson: raw,
  };
}

async function runSync(prisma, isManual = false) {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    logger.warn('[SAM Sync] SAM_GOV_API_KEY not set — skipping sync');
    return;
  }

  const startTime = Date.now();
  const daysBack = isManual ? 30 : Number(process.env.SAM_SYNC_DAYS_BACK || 2);
  logger.info(`[SAM Sync] Starting ${isManual ? 'manual' : 'scheduled'} sync (${daysBack} days back)...`);

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fromStr = formatSamDate(fromDate);
  const toStr = formatSamDate(toDate);

  let totalFetched = 0, totalUpserted = 0, totalSkipped = 0;

  try {
    const firstPage = await fetchPage(apiKey, fromStr, toStr, 0);
    const totalAvailable = firstPage.total;
    logger.info(`[SAM Sync] ${totalAvailable} opportunities available from SAM.gov`);

    const allOpps = [...firstPage.opportunities];
    const maxPages = Math.ceil(totalAvailable / 100);

    for (let i = 1; i < maxPages; i++) {
      const { opportunities } = await fetchPage(apiKey, fromStr, toStr, i * 100);
      allOpps.push(...opportunities);
      await new Promise((r) => setTimeout(r, 250)); // be polite to SAM.gov
    }

    totalFetched = allOpps.length;
    logger.info(`[SAM Sync] Upserting ${totalFetched} opportunities...`);

    // Upsert in batches of 50
    const BATCH = 50;
    for (let i = 0; i < allOpps.length; i += BATCH) {
      await Promise.all(
        allOpps.slice(i, i + BATCH).map(async (raw) => {
          if (!raw.noticeId) { totalSkipped++; return; }
          try {
            const data = parseOpportunity(raw);
            await prisma.opportunity.upsert({
              where: { noticeId: data.noticeId },
              update: { ...data, source: 'SAM', updatedAt: new Date() },
              create: { ...data, source: 'SAM' },
            });
            totalUpserted++;
          } catch (err) {
            logger.warn(`[SAM Sync] Skipped ${raw.noticeId}: ${err.message}`);
            totalSkipped++;
          }
        })
      );
    }

    // Delete opportunities archived more than 30 days ago
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const { count: deleted } = await prisma.opportunity.deleteMany({
      where: { archiveDate: { lt: cutoff } },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      `[SAM Sync] Done in ${elapsed}s — fetched: ${totalFetched}, ` +
      `upserted: ${totalUpserted}, skipped: ${totalSkipped}, deleted: ${deleted}`
    );

    return { fetched: totalFetched, upserted: totalUpserted, skipped: totalSkipped, deleted, elapsed };
  } catch (err) {
    logger.error(`[SAM Sync] Failed: ${err.message}`);
    throw err;
  }
}

function startSamSyncJob(prisma, runNow = false) {
  // Run at 2:00 AM UTC every night
  cron.schedule('0 2 * * *', async () => {
    try {
      await runSync(prisma);
    } catch (err) {
      logger.error('[SAM Sync] Cron job error:', err);
    }
  });

  logger.info('[SAM Sync] Scheduled nightly sync at 2:00 AM UTC');

  // Run immediately if requested (e.g. on first deploy or manual trigger)
  if (runNow) {
    runSync(prisma).catch((err) => logger.error('[SAM Sync] Initial sync error:', err));
  }
}

module.exports = { startSamSyncJob, runSync };

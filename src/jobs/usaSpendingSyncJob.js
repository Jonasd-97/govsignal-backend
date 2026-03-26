/**
 * usaSpendingSyncJob.js
 * helixgov-backend/src/jobs/usaSpendingSyncJob.js
 *
 * Pulls contract opportunities from USASpending.gov API.
 * No API key required. No rate limits. Runs nightly alongside SAM sync.
 * Expanded to 100+ NAICS codes × 3 pages = 30,000+ potential records.
 */

const cron = require('node-cron');
const logger = require('../services/logger');

const USA_SPENDING_BASE = 'https://api.usaspending.gov/api/v2';

// Expanded NAICS list — 100+ codes covering all major GovCon categories
const TARGET_NAICS = [
  // IT & Technology
  '541511', '541512', '541513', '541519',
  '511210', '517110', '517210', '517310', '517410', '517910',
  '518210', '519130',

  // Professional Services & Consulting
  '541611', '541612', '541613', '541614', '541618', '541619',
  '541690', '541715', '541720', '541810', '541820', '541830',
  '541840', '541850', '541860', '541870', '541890', '541910',
  '541990',

  // Engineering & Technical
  '541310', '541320', '541330', '541340', '541350', '541360',
  '541370', '541380', '541410', '541420', '541430', '541490',
  '541710', '541712',

  // Construction & Facilities
  '236210', '236220', '237110', '237120', '237130', '237210',
  '237310', '237990', '238110', '238120', '238130', '238140',
  '238150', '238160', '238170', '238190', '238210', '238220',
  '238290', '238310', '238320', '238330', '238340', '238350',
  '238390', '238910', '238990',

  // Manufacturing & Defense
  '332911', '332999', '334111', '334118', '334210', '334220',
  '334290', '334310', '334411', '334412', '334413', '334414',
  '334415', '334416', '334417', '334418', '334419', '334510',
  '334511', '334512', '334513', '334514', '334515', '334516',
  '334517', '334519', '334614', '336411', '336412', '336413',
  '336414', '336415', '336419',

  // Healthcare & Medical
  '621111', '621112', '621210', '621310', '621320', '621330',
  '621340', '621391', '621399', '621410', '621420', '621491',
  '621492', '621493', '621498', '621511', '621512', '621610',
  '621910', '621991', '621999', '622110', '622210', '622310',
  '623110', '623210', '623220', '623311', '623312', '623990',
  '624110', '624120', '624190', '624210', '624221', '624229',
  '624230', '624310', '624410',

  // Logistics, Transportation & Supply Chain
  '484110', '484121', '484122', '484210', '484220', '484230',
  '488111', '488119', '488190', '488210', '488310', '488320',
  '488330', '488390', '488410', '488490', '488510', '488991',
  '488999', '491110', '492110', '492210', '493110', '493120',
  '493130', '493190',

  // Administrative & Support Services
  '561110', '561120', '561210', '561310', '561320', '561330',
  '561410', '561421', '561422', '561431', '561439', '561440',
  '561450', '561491', '561492', '561499', '561510', '561520',
  '561591', '561599', '561611', '561612', '561613', '561621',
  '561622', '561710', '561720', '561730', '561740', '561790',
  '561910', '561920', '561990',

  // Education & Training
  '611110', '611210', '611310', '611410', '611420', '611430',
  '611511', '611512', '611513', '611519', '611610', '611620',
  '611630', '611691', '611699', '611710',

  // Food & Hospitality
  '721110', '721120', '721191', '721199', '722310', '722320',
  '722330', '722410', '722511', '722513', '722514', '722515',

  // Research & Development
  '541711', '541712', '541713', '541714', '541715', '541720',
];

const PAGES_PER_NAICS = 3;

async function fetchOpportunitiesByNaics(naicsCode, daysBack = 365, maxPages = PAGES_PER_NAICS) {
  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  const results = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(`${USA_SPENDING_BASE}/search/spending_by_award/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: {
            award_type_codes: ['A', 'B', 'C', 'D'],
            naics_codes: [naicsCode],
            time_period: [{ start_date: fromStr, end_date: toStr }],
            award_amounts: [{ lower_bound: 10000 }],
          },
          fields: [
            'Award ID', 'Recipient Name', 'Award Amount', 'Description',
            'Contract Award Type', 'Awarding Agency', 'Awarding Sub Agency',
            'Start Date', 'End Date', 'generated_internal_id',
            'Place of Performance State Code', 'Funding Agency',
            'NAICS Code', 'NAICS Description', 'PSC Code', 'PSC Description',
          ],
          sort: 'Award Amount',
          order: 'desc',
          limit: 100,
          page,
        }),
      });

      if (!res.ok) break;

      const data = await res.json();
      const pageResults = data.results || [];
      results.push(...pageResults);

      if (pageResults.length < 100) break;
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      logger.warn(`[USA Spending Sync] NAICS ${naicsCode} page ${page} error: ${err.message}`);
      break;
    }
  }

  return results;
}

async function fetchBroadSweep(daysBack = 365) {
  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  const results = [];

  for (let page = 1; page <= 20; page++) {
    try {
      const res = await fetch(`${USA_SPENDING_BASE}/search/spending_by_award/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: {
            award_type_codes: ['A', 'B', 'C', 'D'],
            time_period: [{ start_date: fromStr, end_date: toStr }],
            award_amounts: [{ lower_bound: 25000 }],
          },
          fields: [
            'Award ID', 'Recipient Name', 'Award Amount', 'Description',
            'Contract Award Type', 'Awarding Agency', 'Awarding Sub Agency',
            'Start Date', 'End Date', 'generated_internal_id',
            'Place of Performance State Code', 'Funding Agency',
            'NAICS Code', 'NAICS Description',
          ],
          sort: 'Start Date',
          order: 'desc',
          limit: 100,
          page,
        }),
      });

      if (!res.ok) break;

      const data = await res.json();
      const pageResults = data.results || [];
      results.push(...pageResults);

      if (pageResults.length < 100) break;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      logger.warn(`[USA Spending Sync] Broad sweep page ${page} error: ${err.message}`);
      break;
    }
  }

  logger.info(`[USA Spending Sync] Broad sweep fetched ${results.length} records`);
  return results;
}

function extractAgencyName(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    return value.name || value.agency_name || value.toptier_agency_name || null;
  }
  return null;
}

function parseUsaSpendingRecord(raw, naicsCode = null) {
  const noticeId = `usa-${raw['generated_internal_id'] || raw['Award ID'] || Math.random().toString(36).slice(2)}`;

  const agency = extractAgencyName(raw['Awarding Agency']) || extractAgencyName(raw['Funding Agency']) || null;
  const subAgency = extractAgencyName(raw['Awarding Sub Agency']) || null;
  const naics = naicsCode || raw['NAICS Code'] || null;
  const awardAmount = raw['Award Amount'] ? Number(raw['Award Amount']) : null;
  const startDate = raw['Start Date'] ? new Date(raw['Start Date']) : null;
  const endDate = raw['End Date'] ? new Date(raw['End Date']) : null;

  const naicsDesc = raw['NAICS Description'] || raw['PSC Description'] || '';
  const title = raw['Description']
    ? raw['Description'].slice(0, 120).replace(/\n/g, ' ').trim()
    : `${naicsDesc || 'Federal Contract'} — ${agency || 'Federal Agency'}`;

  return {
    noticeId,
    title: title || 'Federal Contract Opportunity',
    agency,
    subAgency,
    naicsCode: naics,
    opportunityType: raw['Contract Award Type'] || 'Contract',
    setAsideType: null,
    setAsideDescription: null,
    postedDate: startDate,
    responseDeadline: endDate,
    archiveDate: endDate ? new Date(endDate.getTime() + 365 * 24 * 60 * 60 * 1000) : null,
    description: raw['Description'] || null,
    uiLink: raw['generated_internal_id']
      ? `https://www.usaspending.gov/award/${raw['generated_internal_id']}`
      : null,
    solicitationNumber: raw['Award ID'] || null,
    placeOfPerformance: raw['Place of Performance State Code'] || null,
    rawJson: {
      ...raw,
      source: 'usaspending',
      awardAmount,
      naicsDescription: naicsDesc,
    },
  };
}

async function runUsaSpendingSync(prisma, isManual = false) {
  const startTime = Date.now();
  const daysBack = isManual ? 730 : 365;

  logger.info(`[USA Spending Sync] Starting ${isManual ? 'manual' : 'scheduled'} sync (${daysBack} days, ${TARGET_NAICS.length} NAICS codes)...`);

  let totalFetched = 0, totalUpserted = 0, totalSkipped = 0;

  try {
    // Phase 1: Broad sweep
    logger.info('[USA Spending Sync] Phase 1: Broad sweep (20 pages)...');
    const broadRecords = await fetchBroadSweep(daysBack);

    // Phase 2: NAICS-targeted pull
    logger.info(`[USA Spending Sync] Phase 2: NAICS sweep (${TARGET_NAICS.length} codes × ${PAGES_PER_NAICS} pages)...`);
    const naicsRecords = [];

    for (let i = 0; i < TARGET_NAICS.length; i++) {
      const naics = TARGET_NAICS[i];
      const results = await fetchOpportunitiesByNaics(naics, daysBack, PAGES_PER_NAICS);
      naicsRecords.push(...results.map(r => ({ ...r, _naics: naics })));

      if ((i + 1) % 20 === 0) {
        logger.info(`[USA Spending Sync] Phase 2 progress: ${i + 1}/${TARGET_NAICS.length} NAICS, ${naicsRecords.length} records...`);
      }

      await new Promise((r) => setTimeout(r, 150));
    }

    logger.info(`[USA Spending Sync] Phase 2 fetched ${naicsRecords.length} records`);

    // Deduplicate
    const seen = new Set();
    const allRecords = [...broadRecords, ...naicsRecords].filter((r) => {
      const id = r['generated_internal_id'] || r['Award ID'];
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    totalFetched = allRecords.length;
    logger.info(`[USA Spending Sync] ${totalFetched} unique records to upsert...`);

    // Upsert in batches of 100
    const BATCH = 100;
    for (let i = 0; i < allRecords.length; i += BATCH) {
      await Promise.all(
        allRecords.slice(i, i + BATCH).map(async (raw) => {
          try {
            const data = parseUsaSpendingRecord(raw, raw._naics);
            if (!data.noticeId || !data.title) { totalSkipped++; return; }

            await prisma.opportunity.upsert({
              where: { noticeId: data.noticeId },
              update: { ...data, source: 'USASPENDING', updatedAt: new Date() },
              create: { ...data, source: 'USASPENDING' },
            });
            totalUpserted++;
          } catch (err) {
            logger.warn(`[USA Spending Sync] Skipped: ${err.message}`);
            totalSkipped++;
          }
        })
      );

      if (i % 2000 === 0 && i > 0) {
        logger.info(`[USA Spending Sync] Upsert progress: ${i}/${allRecords.length}...`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[USA Spending Sync] Done in ${elapsed}s — fetched: ${totalFetched}, upserted: ${totalUpserted}, skipped: ${totalSkipped}`);

    return { fetched: totalFetched, upserted: totalUpserted, skipped: totalSkipped, elapsed };
  } catch (err) {
    logger.error(`[USA Spending Sync] Failed: ${err.message}`);
    throw err;
  }
}

function startUsaSpendingSyncJob(prisma, runNow = false) {
  cron.schedule('0 3 * * *', async () => {
    try {
      await runUsaSpendingSync(prisma);
    } catch (err) {
      logger.error('[USA Spending Sync] Cron job error:', err);
    }
  });

  logger.info('[USA Spending Sync] Scheduled nightly sync at 3:00 AM UTC');

  if (runNow) {
    runUsaSpendingSync(prisma).catch((err) =>
      logger.error('[USA Spending Sync] Initial sync error:', err)
    );
  }
}

module.exports = { startUsaSpendingSyncJob, runUsaSpendingSync };

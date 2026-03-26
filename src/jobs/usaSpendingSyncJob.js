/**
 * usaSpendingSyncJob.js
 * helixgov-backend/src/jobs/usaSpendingSyncJob.js
 *
 * Pulls active contract opportunities from USASpending.gov API.
 * No API key required. No rate limits. Runs nightly alongside SAM sync.
 * Massively expands the opportunity dataset beyond SAM.gov free tier limits.
 */

const cron = require('node-cron');
const logger = require('../services/logger');

const USA_SPENDING_BASE = 'https://api.usaspending.gov/api/v2';

// NAICS codes to pull — covers the most common GovCon categories
// Each fetch pulls up to 100 records per NAICS, giving us broad coverage
const TARGET_NAICS = [
  '541511', // Custom Computer Programming Services
  '541512', // Computer Systems Design Services
  '541513', // Computer Facilities Management Services
  '541519', // Other Computer Related Services
  '541611', // Management Consulting Services
  '541614', // Process, Physical Distribution, and Logistics Consulting
  '541690', // Other Scientific and Technical Consulting Services
  '541712', // Research and Development in Physical Sciences
  '541720', // Research and Development in Social Sciences
  '541990', // All Other Professional, Scientific, and Technical Services
  '561110', // Office Administrative Services
  '561210', // Facilities Support Services
  '561320', // Temporary Staffing Services
  '561330', // Professional Employer Organizations
  '561499', // All Other Business Support Services
  '611430', // Professional and Management Development Training
  '336411', // Aircraft Manufacturing
  '336413', // Other Aircraft Parts and Equipment
  '332911', // Industrial and Commercial Machinery
  '238210', // Electrical Contractors
  '238220', // Plumbing, Heating, and Air-Conditioning
  '236220', // Commercial and Institutional Building Construction
  '334511', // Search, Detection, Navigation Equipment
  '334513', // Industrial Process Control Instruments
  '334519', // Other Measuring Instruments
  '423430', // Computer and Computer Peripheral Equipment
  '532420', // Office Machinery and Equipment Rental
  '621111', // Offices of Physicians
  '621610', // Home Health Care Services
  '622110', // General Medical and Surgical Hospitals
  '711510', // Independent Artists, Writers, and Performers
  '721110', // Hotels and Motels
  '722310', // Food Service Contractors
  '484110', // General Freight Trucking, Local
  '488510', // Freight Transportation Arrangement
];

async function fetchOpportunitiesByNaics(naicsCode, daysBack = 90) {
  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  try {
    const res = await fetch(`${USA_SPENDING_BASE}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          award_type_codes: ['A', 'B', 'C', 'D'], // Contracts only
          naics_codes: [naicsCode],
          time_period: [{ start_date: fromStr, end_date: toStr }],
          award_amounts: [{ lower_bound: 10000 }], // Skip micro-purchases
        },
        fields: [
          'Award ID',
          'Recipient Name',
          'Award Amount',
          'Total Outlays',
          'Description',
          'Contract Award Type',
          'Awarding Agency',
          'Awarding Sub Agency',
          'Start Date',
          'End Date',
          'generated_internal_id',
          'Place of Performance State Code',
          'Funding Agency',
          'NAICS Code',
          'NAICS Description',
          'PSC Code',
          'PSC Description',
        ],
        sort: 'Award Amount',
        order: 'desc',
        limit: 100,
        page: 1,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[USA Spending Sync] NAICS ${naicsCode} fetch failed: ${res.status} ${text.slice(0, 100)}`);
      return [];
    }

    const data = await res.json();
    return data.results || [];
  } catch (err) {
    logger.warn(`[USA Spending Sync] NAICS ${naicsCode} error: ${err.message}`);
    return [];
  }
}

async function fetchActiveOpportunities(daysBack = 90) {
  // Also pull from the opportunities/search endpoint for active solicitations
  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  const results = [];

  try {
    // Pull multiple pages of active opportunities
    for (let page = 1; page <= 10; page++) {
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
            'Award ID',
            'Recipient Name',
            'Award Amount',
            'Description',
            'Contract Award Type',
            'Awarding Agency',
            'Awarding Sub Agency',
            'Start Date',
            'End Date',
            'generated_internal_id',
            'Place of Performance State Code',
            'Funding Agency',
            'NAICS Code',
            'NAICS Description',
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

      if (pageResults.length < 100) break; // Last page
      await new Promise((r) => setTimeout(r, 300)); // Rate limit courtesy
    }
  } catch (err) {
    logger.warn(`[USA Spending Sync] Active opportunities fetch error: ${err.message}`);
  }

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

  // Build a meaningful title from available data
  const naicsDesc = raw['NAICS Description'] || raw['PSC Description'] || '';
  const recipientName = raw['Recipient Name'] || '';
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
    archiveDate: endDate ? new Date(endDate.getTime() + 30 * 24 * 60 * 60 * 1000) : null,
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
  const daysBack = isManual ? 180 : 90;

  logger.info(`[USA Spending Sync] Starting ${isManual ? 'manual' : 'scheduled'} sync (${daysBack} days back)...`);

  let totalFetched = 0, totalUpserted = 0, totalSkipped = 0;

  try {
    // Phase 1: Pull active opportunities (broad sweep)
    logger.info('[USA Spending Sync] Phase 1: Fetching active opportunities...');
    const activeOpps = await fetchActiveOpportunities(daysBack);
    logger.info(`[USA Spending Sync] Phase 1 fetched ${activeOpps.length} records`);

    // Phase 2: Pull by NAICS for targeted coverage
    logger.info(`[USA Spending Sync] Phase 2: Fetching by ${TARGET_NAICS.length} NAICS codes...`);
    const naicsOpps = [];

    for (const naics of TARGET_NAICS) {
      const results = await fetchOpportunitiesByNaics(naics, daysBack);
      naicsOpps.push(...results.map(r => ({ ...r, _naics: naics })));
      await new Promise((r) => setTimeout(r, 200)); // polite delay
    }

    logger.info(`[USA Spending Sync] Phase 2 fetched ${naicsOpps.length} records`);

    // Combine and deduplicate by generated_internal_id
    const seen = new Set();
    const allRecords = [...activeOpps, ...naicsOpps].filter((r) => {
      const id = r['generated_internal_id'] || r['Award ID'];
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    totalFetched = allRecords.length;
    logger.info(`[USA Spending Sync] ${totalFetched} unique records to upsert...`);

    // Log a sample record to debug field names
    if (allRecords.length > 0) {
      logger.info(`[USA Spending Sync] Sample record keys: ${Object.keys(allRecords[0]).join(', ')}`);
      logger.info(`[USA Spending Sync] Sample agency fields: Awarding Agency=${JSON.stringify(allRecords[0]['Awarding Agency'])}, Funding Agency=${JSON.stringify(allRecords[0]['Funding Agency'])}`);
    }

    // Upsert in batches of 50
    const BATCH = 50;
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
            logger.warn(`[USA Spending Sync] Skipped record: ${err.message}`);
            totalSkipped++;
          }
        })
      );
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      `[USA Spending Sync] Done in ${elapsed}s — fetched: ${totalFetched}, ` +
      `upserted: ${totalUpserted}, skipped: ${totalSkipped}`
    );

    return { fetched: totalFetched, upserted: totalUpserted, skipped: totalSkipped, elapsed };
  } catch (err) {
    logger.error(`[USA Spending Sync] Failed: ${err.message}`);
    throw err;
  }
}

function startUsaSpendingSyncJob(prisma, runNow = false) {
  // Run at 3:00 AM UTC every night (1 hour after SAM sync)
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

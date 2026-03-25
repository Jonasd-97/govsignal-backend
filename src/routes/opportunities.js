const express = require('express');
const { query, param } = require('express-validator');
const { authenticate, requirePlan } = require('../middleware/auth');
const {
  scoreOpportunity,
  fetchOpportunityByNoticeId,
  extractValueInfo,
} = require('../services/samService');
const logger = require('../services/logger');
const { handleValidation } = require('../utils/validation');

const router = express.Router();

const SET_ASIDE_MAP = {
  SBA: ['small business set-aside', 'total small business', 'small business'],
  '8AN': ['8(a)'],
  HZC: ['hubzone'],
  SDVOSBC: ['sdvosb', 'service-disabled veteran'],
  WOSB: ['wosb', 'women-owned small business'],
  EDWOSB: ['edwosb', 'economically disadvantaged'],
  VSB: ['vosb', 'veteran-owned'],
};

function applySetAsideFilter(opps, setAside) {
  const labels = SET_ASIDE_MAP[setAside] || [String(setAside).toLowerCase()];
  return opps.filter((o) => {
    if (!o.setAsideDescription) return false;
    const desc = o.setAsideDescription.toLowerCase();
    if (setAside === 'SBA') {
      return desc.includes('small business') &&
        !desc.includes('sdvosb') &&
        !desc.includes('service-disabled') &&
        !desc.includes('wosb') &&
        !desc.includes('women-owned') &&
        !desc.includes('8(a)') &&
        !desc.includes('hubzone') &&
        !desc.includes('veteran-owned');
    }
    return labels.some((label) => desc.includes(label));
  });
}

// ── LIST OPPORTUNITIES ────────────────────────────────────────────────────────
router.get('/', authenticate, [
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('daysBack').optional().isInt({ min: 1, max: 3650 }),
  query('naicsCode').optional().isLength({ max: 10 }),
  query('setAside').optional().isLength({ max: 50 }),
  query('agency').optional().isLength({ max: 120 }),
  query('keyword').optional().isLength({ max: 200 }),
  query('type').optional().isLength({ max: 10 }),
  query('minValue').optional().isFloat({ min: 0 }),
  query('maxValue').optional().isFloat({ min: 0 }),
  query('source').optional().isIn(['SAM', 'USASPENDING', 'all']),
], async (req, res) => {
  if (!handleValidation(req, res)) return;

  const {
    naicsCode,
    setAside,
    agency,
    keyword,
    type,
    minValue,
    maxValue,
    limit = 50,
    daysBack = 30,
    source = 'SAM', // default to active solicitations only
  } = req.query;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, plan: true },
    });

    const effectiveLimit = user.plan === 'FREE' ? 10 : Math.min(Number(limit), 100);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - Number(daysBack));

    // Build where clause
    const where = {};

    // Source filter
    if (source === 'SAM') {
      where.source = 'SAM';
    } else if (source === 'USASPENDING') {
      where.source = 'USASPENDING';
    }
    // 'all' = no source filter

    // For SAM records, filter by active deadline
    // For USASpending records, show all (they are historical)
    if (source === 'SAM' || source === 'all') {
      where.postedDate = { gte: fromDate };
      if (source === 'SAM') {
        where.OR = [
          { responseDeadline: null },
          { responseDeadline: { gte: new Date() } },
        ];
      }
    } else if (source === 'USASPENDING') {
      // For award intel, use a wider date range
      const awardFromDate = new Date();
      awardFromDate.setDate(awardFromDate.getDate() - Math.max(Number(daysBack), 365));
      where.postedDate = { gte: awardFromDate };
    }

    if (naicsCode) where.naicsCode = String(naicsCode).trim();
    if (type && source === 'SAM') where.opportunityType = String(type).trim();
    if (agency) where.agency = { contains: String(agency), mode: 'insensitive' };

    if (keyword) {
      const keywordFilter = [
        { title: { contains: String(keyword), mode: 'insensitive' } },
        { description: { contains: String(keyword), mode: 'insensitive' } },
      ];
      where.OR = where.OR ? [...where.OR, ...keywordFilter] : keywordFilter;
    }

    if (setAside && source === 'SAM') {
      const labels = SET_ASIDE_MAP[setAside] || [String(setAside).toLowerCase()];
      where.setAsideDescription = { contains: labels[0], mode: 'insensitive' };
    }

    // Fetch from database
    const rawOpps = await req.prisma.opportunity.findMany({
      where,
      orderBy: source === 'USASPENDING'
        ? [{ rawJson: 'desc' }, { postedDate: 'desc' }]
        : { postedDate: 'desc' },
      take: effectiveLimit * 3,
    });

    // Score and enrich
    let scored = rawOpps.map((opp) => {
      const valueInfo = extractValueInfo(opp.rawJson || opp);
      const scoring = scoreOpportunity(opp, user);
      return { ...opp, ...valueInfo, ...scoring };
    });

    // Post-filter set-aside for SAM records
    if (setAside && source === 'SAM') {
      scored = applySetAsideFilter(scored, setAside);
    }

    // Post-filter by value
    const parsedMinValue = minValue ? Number(minValue) : null;
    const parsedMaxValue = maxValue ? Number(maxValue) : null;

    if (parsedMinValue !== null) {
      scored = scored.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        return (o.valueMax ?? o.valueMin) >= parsedMinValue;
      });
    }

    if (parsedMaxValue !== null) {
      scored = scored.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        return (o.valueMin ?? o.valueMax) <= parsedMaxValue;
      });
    }

    // Sort and limit
    const sorted = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveLimit);

    res.json({
      data: sorted,
      total: sorted.length,
      plan: user.plan,
      limited: user.plan === 'FREE' && sorted.length >= 10,
      source,
    });
  } catch (err) {
    logger.error('Opportunities fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunities', detail: err.message });
  }
});

// ── AWARD INTEL (USASpending) ─────────────────────────────────────────────────
router.get('/awards/history', authenticate, requirePlan('PRO', 'AGENCY'), [
  query('agency').optional().isLength({ max: 120 }),
  query('naicsCode').optional().isLength({ max: 10 }),
  query('keyword').optional().isLength({ max: 200 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { agency, naicsCode, keyword, limit = 50 } = req.query;

  try {
    const where = { source: 'USASPENDING' };
    if (naicsCode) where.naicsCode = String(naicsCode).trim();
    if (agency) where.agency = { contains: String(agency), mode: 'insensitive' };
    if (keyword) where.title = { contains: String(keyword), mode: 'insensitive' };

    const awards = await req.prisma.opportunity.findMany({
      where,
      orderBy: { postedDate: 'desc' },
      take: Math.min(Number(limit), 100),
    });

    res.json({ data: awards, total: awards.length });
  } catch (err) {
    logger.error('Awards history error:', err);
    res.status(500).json({ error: 'Failed to fetch award history' });
  }
});

// ── SINGLE OPPORTUNITY ────────────────────────────────────────────────────────
router.get('/:noticeId', authenticate, [
  param('noticeId').isLength({ min: 4, max: 100 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { noticeId } = req.params;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, samApiKey: true },
    });

    // Check database first
    const cached = await req.prisma.opportunity.findUnique({ where: { noticeId } });
    if (cached) {
      const scoring = scoreOpportunity(cached, user);
      const valueInfo = extractValueInfo(cached.rawJson || cached);
      return res.json({ ...cached, ...valueInfo, ...scoring, source: cached.source || 'cache' });
    }

    // Fall back to SAM.gov for individual lookups not in DB
    const live = await fetchOpportunityByNoticeId(
      noticeId,
      user.samApiKey || process.env.SAM_GOV_API_KEY
    );

    if (!live) return res.status(404).json({ error: 'Opportunity not found' });

    const { valueMin, valueMax, valueLabel, valueSource, ...persistableLive } = live;

    await req.prisma.opportunity.upsert({
      where: { noticeId: persistableLive.noticeId },
      update: { ...persistableLive, source: 'SAM' },
      create: { ...persistableLive, source: 'SAM' },
    });

    const scoring = scoreOpportunity(live, user);
    res.json({ ...persistableLive, valueMin, valueMax, valueLabel, valueSource, ...scoring, source: 'SAM' });
  } catch (err) {
    logger.error('Failed to fetch opportunity detail:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

module.exports = router;

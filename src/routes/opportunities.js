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
  } = req.query;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, plan: true },
    });

    const effectiveLimit = user.plan === 'FREE' ? 10 : Math.min(Number(limit), 100);

    // Build database query filters
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - Number(daysBack));

    const where = {
      postedDate: { gte: fromDate },
      // Only show active opportunities (not past deadline)
      OR: [
        { responseDeadline: null },
        { responseDeadline: { gte: new Date() } },
      ],
    };

    if (naicsCode) {
      where.naicsCode = String(naicsCode).trim();
    }

    if (type) {
      where.opportunityType = String(type).trim();
    }

    if (keyword) {
      where.OR = [
        ...(where.OR || []),
        { title: { contains: String(keyword), mode: 'insensitive' } },
        { description: { contains: String(keyword), mode: 'insensitive' } },
      ];
    }

    if (agency) {
      where.agency = { contains: String(agency), mode: 'insensitive' };
    }

    if (setAside) {
      const SET_ASIDE_MAP = {
        SBA: ['small business set-aside', 'total small business', 'small business'],
        '8AN': ['8(a)'],
        HZC: ['hubzone'],
        SDVOSBC: ['sdvosb', 'service-disabled veteran'],
        WOSB: ['wosb', 'women-owned small business'],
        EDWOSB: ['edwosb', 'economically disadvantaged'],
        VSB: ['vosb', 'veteran-owned'],
      };
      const labels = SET_ASIDE_MAP[setAside] || [String(setAside).toLowerCase()];
      // Use OR conditions for set-aside matching
      where.setAsideDescription = {
        contains: labels[0],
        mode: 'insensitive',
      };
    }

    // Fetch from database
    const rawOpps = await req.prisma.opportunity.findMany({
      where,
      orderBy: { postedDate: 'desc' },
      take: effectiveLimit * 3, // fetch more to allow for post-filtering + sorting by score
    });

    // Score and enrich each opportunity
    let scored = rawOpps.map((opp) => {
      const valueInfo = extractValueInfo(opp.rawJson || opp);
      const scoring = scoreOpportunity(opp, user);
      return {
        ...opp,
        ...valueInfo,
        ...scoring,
      };
    });

    // Post-filter by set-aside (more precise matching)
    if (setAside) {
      const SET_ASIDE_MAP = {
        SBA: ['small business set-aside', 'total small business', 'small business'],
        '8AN': ['8(a)'],
        HZC: ['hubzone'],
        SDVOSBC: ['sdvosb', 'service-disabled veteran'],
        WOSB: ['wosb', 'women-owned small business'],
        EDWOSB: ['edwosb', 'economically disadvantaged'],
        VSB: ['vosb', 'veteran-owned'],
      };
      const labels = SET_ASIDE_MAP[setAside] || [String(setAside).toLowerCase()];
      scored = scored.filter((o) => {
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

    // Post-filter by value
    const parsedMinValue = minValue ? Number(minValue) : null;
    const parsedMaxValue = maxValue ? Number(maxValue) : null;

    if (parsedMinValue !== null) {
      scored = scored.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        const upperBound = o.valueMax ?? o.valueMin;
        return upperBound >= parsedMinValue;
      });
    }

    if (parsedMaxValue !== null) {
      scored = scored.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        const lowerBound = o.valueMin ?? o.valueMax;
        return lowerBound <= parsedMaxValue;
      });
    }

    // Sort by score descending and apply limit
    const sorted = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveLimit);

    res.json({
      data: sorted,
      total: sorted.length,
      plan: user.plan,
      limited: user.plan === 'FREE' && sorted.length >= 10,
      source: 'database',
    });
  } catch (err) {
    logger.error('Opportunities fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunities', detail: err.message });
  }
});

router.get('/awards/history', authenticate, requirePlan('PRO', 'AGENCY'), [
  query('agency').optional().isLength({ max: 120 }),
  query('naicsCode').optional().isLength({ max: 10 }),
  query('keyword').optional().isLength({ max: 200 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { agency, naicsCode, keyword } = req.query;

  try {
    const where = { opportunityType: 'a' };
    if (naicsCode) where.naicsCode = String(naicsCode).trim();
    if (agency) where.agency = { contains: String(agency), mode: 'insensitive' };
    if (keyword) where.title = { contains: String(keyword), mode: 'insensitive' };

    const awards = await req.prisma.opportunity.findMany({
      where,
      orderBy: { postedDate: 'desc' },
      take: 50,
    });

    res.json({ data: awards, total: awards.length });
  } catch (err) {
    logger.error('Awards history error:', err);
    res.status(500).json({ error: 'Failed to fetch award history' });
  }
});

router.get('/:noticeId', authenticate, [param('noticeId').isLength({ min: 4, max: 100 })], async (req, res) => {
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
      return res.json({ ...cached, ...valueInfo, ...scoring, source: 'cache' });
    }

    // Fall back to SAM.gov only for individual lookups not in DB
    const live = await fetchOpportunityByNoticeId(
      noticeId,
      user.samApiKey || process.env.SAM_GOV_API_KEY
    );

    if (!live) return res.status(404).json({ error: 'Opportunity not found' });

    const { valueMin, valueMax, valueLabel, valueSource, ...persistableLive } = live;

    await req.prisma.opportunity.upsert({
      where: { noticeId: persistableLive.noticeId },
      update: persistableLive,
      create: persistableLive,
    });

    const scoring = scoreOpportunity(live, user);
    res.json({ ...persistableLive, valueMin, valueMax, valueLabel, valueSource, ...scoring, source: 'live' });
  } catch (err) {
    logger.error('Failed to fetch opportunity detail:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

module.exports = router;

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
  } = req.query;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, samApiKey: true, plan: true },
    });

    const effectiveLimit = user.plan === 'FREE' ? 10 : Math.min(Number(limit), 100);
    const filters = {
      naicsCode,
      type,
      keyword,
      limit: effectiveLimit,
      daysBack: Number(daysBack),
    };

    const opps = await fetchAndScore(filters, user, user.samApiKey || process.env.SAM_GOV_API_KEY);

    let filtered = opps;

    if (naicsCode) {
      filtered = filtered.filter((o) =>
        o.naicsCode && o.naicsCode.trim() === String(naicsCode).trim()
      );
    }

    if (agency) {
      filtered = filtered.filter((o) =>
        o.agency?.toLowerCase().includes(String(agency).toLowerCase())
      );
    }

    if (setAside) {
      const SET_ASIDE_MAP = {
        SBA: ['small business set-aside', 'total small business', 'small business'],
        '8AN': ['8(a)'],
        HZC: ['hubzone'],
        SDVOSBC: ['sdvosb', 'service-disabled veteran'],
        WOSB: ['wosb', 'women-owned small business'],
        EDWOSB: ['edwosb', 'economically disadvantaged'],
        VSB: ['vosb', 'veteran-owned'],
      };
      const labels = SET_ASIDE_MAP[setAside] || [String(setAside).toLowerCase()];
      filtered = filtered.filter((o) => {
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

    const parsedMinValue = minValue ? Number(minValue) : null;
    const parsedMaxValue = maxValue ? Number(maxValue) : null;

    if (parsedMinValue !== null) {
      filtered = filtered.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        const upperBound = o.valueMax ?? o.valueMin;
        return upperBound >= parsedMinValue;
      });
    }

    if (parsedMaxValue !== null) {
      filtered = filtered.filter((o) => {
        if (o.valueMin === null && o.valueMax === null) return false;
        const lowerBound = o.valueMin ?? o.valueMax;
        return lowerBound <= parsedMaxValue;
      });
    }

    res.json({
      data: filtered,
      total: filtered.length,
      plan: user.plan,
      limited: user.plan === 'FREE' && filtered.length >= 10,
    });
  } catch (err) {
    logger.error('Opportunities fetch error:', err);
    res.status(502).json({ error: 'Failed to fetch opportunities from SAM.gov', detail: err.message });
  }
});

router.get('/awards/history', authenticate, requirePlan('PRO', 'AGENCY'), [
  query('agency').optional().isLength({ max: 120 }),
  query('naicsCode').optional().isLength({ max: 10 }),
  query('keyword').optional().isLength({ max: 200 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { agency, naicsCode, keyword } = req.query;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { samApiKey: true },
    });

    const { fetchOpportunities } = require('../services/samService');
    const awards = await fetchOpportunities(
      { type: 'a', naicsCode, keyword, daysBack: 365 },
      user.samApiKey || process.env.SAM_GOV_API_KEY
    );

    const filtered = agency ? awards.filter((a) => a.agency?.includes(agency)) : awards;
    res.json({ data: filtered.slice(0, 50), total: filtered.length });
  } catch (err) {
    logger.error('Awards history error:', err);
    res.status(502).json({ error: 'Failed to fetch award history' });
  }
});

router.get('/:noticeId', authenticate, [param('noticeId').isLength({ min: 4, max: 100 })], async (req, res) => {
  if (!handleValidation(req, res)) return;

  const { noticeId } = req.params;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, samApiKey: true },
    });

    const cached = await req.prisma.opportunity.findUnique({ where: { noticeId } });
    if (cached) {
      const scoring = scoreOpportunity(cached, user);
      const valueInfo = extractValueInfo(cached.rawJson || cached);
      return res.json({ ...cached, ...valueInfo, ...scoring, source: 'cache' });
    }

    const live = await fetchOpportunityByNoticeId(
      noticeId,
      user.samApiKey || process.env.SAM_GOV_API_KEY
    );

    if (!live) return res.status(404).json({ error: 'Opportunity not found' });

    const {
      valueMin,
      valueMax,
      valueLabel,
      valueSource,
      ...persistableLive
    } = live;

    await req.prisma.opportunity.upsert({
      where: { noticeId: persistableLive.noticeId },
      update: persistableLive,
      create: persistableLive,
    });

    const scoring = scoreOpportunity(live, user);
    res.json({
      ...persistableLive,
      valueMin,
      valueMax,
      valueLabel,
      valueSource,
      ...scoring,
      source: 'live',
    });
  } catch (err) {
    logger.error('Failed to fetch opportunity detail:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

module.exports = router;
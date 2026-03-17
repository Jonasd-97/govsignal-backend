const express = require('express');
const { query, param } = require('express-validator');
const { authenticate, requirePlan } = require('../middleware/auth');
const { fetchAndScore, scoreOpportunity, fetchOpportunityByNoticeId } = require('../services/samService');
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
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { naicsCode, setAside, agency, keyword, type, limit = 50, daysBack = 30 } = req.query;

  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, samApiKey: true, plan: true },
    });

    const effectiveLimit = user.plan === 'FREE' ? 10 : Math.min(Number(limit), 100);
    const filters = { naicsCode, type, keyword, limit: effectiveLimit, daysBack: Number(daysBack) };
    const opps = await fetchAndScore(filters, user, user.samApiKey || process.env.SAM_GOV_API_KEY);

    let filtered = opps;
    if (agency) filtered = filtered.filter((o) => o.agency?.toLowerCase().includes(String(agency).toLowerCase()));
    if (setAside) {
      const SET_ASIDE_MAP = { SBA: 'small business', '8AN': '8(a)', HZC: 'hubzone', SDVOSBC: 'sdvosb', WOSB: 'wosb', EDWOSB: 'edwosb' };
      const label = SET_ASIDE_MAP[setAside] || String(setAside).toLowerCase();
      filtered = filtered.filter((o) => o.setAsideDescription?.toLowerCase().includes(label));
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
    const user = await req.prisma.user.findUnique({ where: { id: req.userId }, select: { samApiKey: true } });
    const { fetchOpportunities } = require('../services/samService');
    const awards = await fetchOpportunities({ type: 'a', naicsCode, keyword, daysBack: 365 }, user.samApiKey || process.env.SAM_GOV_API_KEY);
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
      return res.json({ ...cached, ...scoring, source: 'cache' });
    }

    const live = await fetchOpportunityByNoticeId(noticeId, user.samApiKey || process.env.SAM_GOV_API_KEY);
    if (!live) return res.status(404).json({ error: 'Opportunity not found' });

    await req.prisma.opportunity.upsert({
      where: { noticeId: live.noticeId },
      update: live,
      create: live,
    });

    const scoring = scoreOpportunity(live, user);
    res.json({ ...live, ...scoring, source: 'live' });
  } catch (err) {
    logger.error('Failed to fetch opportunity detail:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

module.exports = router;

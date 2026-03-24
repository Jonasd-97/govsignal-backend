const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { handleValidation } = require('../utils/validation');
const { extractValueInfo } = require('../services/samService');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const saved = await req.prisma.savedOpportunity.findMany({
      where: { userId: req.userId },
      include: { opportunity: true },
      orderBy: { savedAt: 'desc' },
    });

    // ✅ Attach value info to each saved opportunity
    const enriched = saved.map((item) => {
      const opp = item.opportunity || {};
      const valueInfo = extractValueInfo(opp.rawJson || opp);

      return {
        ...item,
        opportunity: {
          ...opp,
          ...valueInfo,
        },
      };
    });

    res.json(enriched);
  } catch {
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

router.post('/', authenticate, [
  body('noticeId').isLength({ min: 4, max: 100 }),
  body('title').optional().isLength({ max: 500 }),
  body('agency').optional().isLength({ max: 200 }),
  body('naicsCode').optional().isLength({ max: 10 }),
  body('opportunityType').optional().isLength({ max: 20 }),
  body('setAsideDescription').optional().isLength({ max: 200 }),
  body('uiLink').optional().isURL(),
  body('notes').optional().isLength({ max: 2000 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;

  const {
    noticeId,
    title,
    agency,
    naicsCode,
    opportunityType,
    setAsideDescription,
    postedDate,
    responseDeadline,
    uiLink,
    notes,
    rawJson, // ✅ allow raw SAM data
  } = req.body;

  try {
    const opp = await req.prisma.opportunity.upsert({
      where: { noticeId },
      update: {
        ...(title ? { title } : {}),
        ...(agency ? { agency } : {}),
        ...(naicsCode ? { naicsCode } : {}),
        ...(opportunityType ? { opportunityType } : {}),
        ...(setAsideDescription ? { setAsideDescription } : {}),
        ...(postedDate ? { postedDate: new Date(postedDate) } : {}),
        ...(responseDeadline ? { responseDeadline: new Date(responseDeadline) } : {}),
        ...(uiLink ? { uiLink } : {}),
        ...(rawJson ? { rawJson } : {}), // ✅ store raw data
      },
      create: {
        noticeId,
        title: title || 'Untitled',
        agency,
        naicsCode,
        opportunityType,
        setAsideDescription,
        postedDate: postedDate ? new Date(postedDate) : null,
        responseDeadline: responseDeadline ? new Date(responseDeadline) : null,
        uiLink,
        rawJson: rawJson || null, // ✅ store raw data
      },
    });

    const saved = await req.prisma.savedOpportunity.upsert({
      where: {
        userId_opportunityId: {
          userId: req.userId,
          opportunityId: opp.id,
        },
      },
      update: {
        ...(notes !== undefined ? { notes } : {}),
      },
      create: {
        userId: req.userId,
        opportunityId: opp.id,
        notes,
      },
      include: { opportunity: true },
    });

    // ✅ Attach value info immediately on response
    const valueInfo = extractValueInfo(saved.opportunity.rawJson || saved.opportunity);

    res.status(201).json({
      ...saved,
      opportunity: {
        ...saved.opportunity,
        ...valueInfo,
      },
    });
  } catch {
    res.status(500).json({ error: 'Failed to save opportunity' });
  }
});

router.delete('/:noticeId', authenticate, [
  param('noticeId').isLength({ min: 4, max: 100 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;

  try {
    const opp = await req.prisma.opportunity.findUnique({
      where: { noticeId: req.params.noticeId },
    });

    if (!opp) return res.status(404).json({ error: 'Not found' });

    await req.prisma.savedOpportunity.deleteMany({
      where: { userId: req.userId, opportunityId: opp.id },
    });

    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

module.exports = router;
const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { handleValidation } = require('../utils/validation');
const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const saved = await req.prisma.savedOpportunity.findMany({
      where: { userId: req.userId },
      include: { opportunity: true },
      orderBy: { savedAt: 'desc' },
    });
    res.json(saved);
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
  const { noticeId, title, agency, naicsCode, opportunityType, setAsideDescription, postedDate, responseDeadline, uiLink, notes } = req.body;
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
      },
      create: {
        noticeId, title: title || 'Untitled', agency, naicsCode, opportunityType, setAsideDescription,
        postedDate: postedDate ? new Date(postedDate) : null,
        responseDeadline: responseDeadline ? new Date(responseDeadline) : null,
        uiLink,
      },
    });

    const saved = await req.prisma.savedOpportunity.upsert({
      where: { userId_opportunityId: { userId: req.userId, opportunityId: opp.id } },
      update: { ...(notes !== undefined ? { notes } : {}) },
      create: { userId: req.userId, opportunityId: opp.id, notes },
      include: { opportunity: true },
    });
    res.status(201).json(saved);
  } catch {
    res.status(500).json({ error: 'Failed to save opportunity' });
  }
});

router.delete('/:noticeId', authenticate, [param('noticeId').isLength({ min: 4, max: 100 })], async (req, res) => {
  if (!handleValidation(req, res)) return;
  try {
    const opp = await req.prisma.opportunity.findUnique({ where: { noticeId: req.params.noticeId } });
    if (!opp) return res.status(404).json({ error: 'Not found' });
    await req.prisma.savedOpportunity.deleteMany({ where: { userId: req.userId, opportunityId: opp.id } });
    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

module.exports = router;

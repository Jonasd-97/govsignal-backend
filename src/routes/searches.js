const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { handleValidation } = require('../utils/validation');

const searchRouter = express.Router();

searchRouter.get('/', authenticate, async (req, res) => {
  try {
    const searches = await req.prisma.savedSearch.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } });
    res.json(searches);
  } catch {
    res.status(500).json({ error: 'Failed to fetch saved searches' });
  }
});

searchRouter.post('/', authenticate, [
  body('name').trim().isLength({ min: 1, max: 120 }),
  body('filters').isObject(),
  body('alertOn').optional().isBoolean(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { name, filters, alertOn } = req.body;
  try {
    const search = await req.prisma.savedSearch.create({
      data: { userId: req.userId, name, filters, alertOn: alertOn ?? true },
    });
    res.status(201).json(search);
  } catch {
    res.status(500).json({ error: 'Failed to create saved search' });
  }
});

searchRouter.delete('/:id', authenticate, [param('id').isLength({ min: 5, max: 50 })], async (req, res) => {
  if (!handleValidation(req, res)) return;
  try {
    await req.prisma.savedSearch.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete saved search' });
  }
});

const perfRouter = express.Router();

perfRouter.get('/', authenticate, async (req, res) => {
  try {
    const records = await req.prisma.pastPerformance.findMany({ where: { userId: req.userId }, orderBy: { year: 'desc' } });
    res.json(records);
  } catch {
    res.status(500).json({ error: 'Failed to fetch past performance' });
  }
});

perfRouter.post('/', authenticate, [
  body('title').trim().isLength({ min: 1, max: 200 }),
  body('agency').optional().isLength({ max: 200 }),
  body('contractValue').optional().isFloat({ min: 0 }),
  body('year').optional().isInt({ min: 1900, max: 2100 }),
  body('outcome').optional().isIn(['Won', 'Lost', 'Ongoing', 'Completed']),
  body('description').optional().isLength({ max: 5000 }),
  body('naicsCode').optional().isLength({ max: 10 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { title, agency, contractValue, year, outcome, description, naicsCode } = req.body;
  try {
    const record = await req.prisma.pastPerformance.create({
      data: { userId: req.userId, title, agency, contractValue: contractValue ? Number(contractValue) : null, year: year ? Number(year) : null, outcome: outcome || 'Won', description, naicsCode },
    });
    res.status(201).json(record);
  } catch {
    res.status(500).json({ error: 'Failed to create past performance record' });
  }
});

perfRouter.patch('/:id', authenticate, [param('id').isLength({ min: 5, max: 50 })], async (req, res) => {
  const { title, agency, contractValue, year, outcome, description, naicsCode } = req.body;
  try {
    const record = await req.prisma.pastPerformance.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(agency !== undefined ? { agency } : {}),
        ...(contractValue !== undefined ? { contractValue: contractValue === null || contractValue === '' ? null : Number(contractValue) } : {}),
        ...(year !== undefined ? { year: year === null || year === '' ? null : Number(year) } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(naicsCode !== undefined ? { naicsCode } : {}),
      },
    });
    res.json(record);
  } catch {
    res.status(500).json({ error: 'Failed to update past performance record' });
  }
});

perfRouter.delete('/:id', authenticate, [param('id').isLength({ min: 5, max: 50 })], async (req, res) => {
  if (!handleValidation(req, res)) return;
  try {
    await req.prisma.pastPerformance.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete past performance record' });
  }
});

module.exports = { searchRouter, perfRouter };

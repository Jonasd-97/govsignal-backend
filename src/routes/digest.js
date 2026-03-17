const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { verifyUnsubscribeToken } = require('../utils/tokens');
const { handleValidation } = require('../utils/validation');
const router = express.Router();

router.get('/settings', authenticate, async (req, res) => {
  try {
    const settings = await req.prisma.digestSettings.findUnique({ where: { userId: req.userId } });
    res.json(settings || {});
  } catch {
    res.status(500).json({ error: 'Failed to fetch digest settings' });
  }
});

router.patch('/settings', authenticate, [
  body('enabled').optional().isBoolean(),
  body('frequency').optional().isIn(['daily', 'weekly']),
  body('sendTime').optional().matches(/^\d{2}:\d{2}$/),
  body('minScore').optional().isInt({ min: 0, max: 100 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { enabled, frequency, sendTime, minScore } = req.body;
  const settings = await req.prisma.digestSettings.upsert({
    where: { userId: req.userId },
    update: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(frequency !== undefined ? { frequency } : {}),
      ...(sendTime !== undefined ? { sendTime } : {}),
      ...(minScore !== undefined ? { minScore: Number(minScore) } : {}),
    },
    create: { userId: req.userId, enabled: enabled ?? true, frequency: frequency || 'daily', sendTime: sendTime || '08:00', minScore: minScore !== undefined ? Number(minScore) : 60 },
  });
  res.json(settings);
});

router.post('/test', authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.userId } });
    const { fetchAndScore } = require('../services/samService');
    const emailService = require('../services/emailService');
    const opps = await fetchAndScore({ daysBack: 7, limit: 25 }, user, user.samApiKey || process.env.SAM_GOV_API_KEY);
    await emailService.sendDigest(user, opps.slice(0, 10));
    res.json({ sent: true, count: Math.min(10, opps.length) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test digest', detail: err.message });
  }
});

router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const userId = verifyUnsubscribeToken(String(token));
    await req.prisma.digestSettings.upsert({
      where: { userId },
      update: { enabled: false },
      create: { userId, enabled: false },
    });
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0"><h2 style="color:#f59e0b">◈ GovSignal</h2><p>You've been unsubscribed from digest emails.</p><p><a href="${process.env.FRONTEND_URL}/settings" style="color:#f59e0b">Manage preferences in your dashboard →</a></p></body></html>`);
  } catch {
    res.status(400).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0"><h2 style="color:#f59e0b">◈ GovSignal</h2><p>This unsubscribe link is invalid or expired.</p></body></html>`);
  }
});

module.exports = router;

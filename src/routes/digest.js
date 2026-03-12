// ── DIGEST ROUTES ──
const express = require("express");
const { authenticate } = require("../middleware/auth");
const router = express.Router();

// GET /api/digest/settings
router.get("/settings", authenticate, async (req, res) => {
  const settings = await req.prisma.digestSettings.findUnique({ where: { userId: req.userId } });
  res.json(settings || {});
});

// PATCH /api/digest/settings
router.patch("/settings", authenticate, async (req, res) => {
  const { enabled, frequency, sendTime, minScore } = req.body;
  const settings = await req.prisma.digestSettings.upsert({
    where: { userId: req.userId },
    update: { enabled, frequency, sendTime, minScore: minScore ? Number(minScore) : undefined },
    create: { userId: req.userId, enabled: enabled ?? true, frequency: frequency || "daily", sendTime: sendTime || "08:00", minScore: minScore ? Number(minScore) : 60 },
  });
  res.json(settings);
});

// POST /api/digest/test — send a test digest immediately
router.post("/test", authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.userId } });
    const { fetchAndScore } = require("../services/samService");
    const emailService = require("../services/emailService");
    const opps = await fetchAndScore({}, user, user.samApiKey || process.env.SAM_GOV_API_KEY);
    await emailService.sendDigest(user, opps.slice(0, 10));
    res.json({ sent: true, count: Math.min(10, opps.length) });
  } catch (err) {
    res.status(500).json({ error: "Failed to send test digest", detail: err.message });
  }
});

// GET /api/digest/unsubscribe?token=<userId>
// CAN-SPAM compliant one-click unsubscribe (linked from email footer)
router.get("/unsubscribe", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token required" });
  try {
    // Token is the user's ID (no auth needed — link comes from email)
    await req.prisma.digestSettings.upsert({
      where: { userId: token },
      update: { enabled: false },
      create: { userId: token, enabled: false },
    });
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0">
      <h2 style="color:#f59e0b">◈ GovSignal</h2>
      <p>You've been unsubscribed from daily digest emails.</p>
      <p><a href="${process.env.FRONTEND_URL}/settings" style="color:#f59e0b">Manage preferences in your dashboard →</a></p>
    </body></html>`);
  } catch (err) {
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

module.exports = router;

// ── WATCHLIST ROUTES ──
const express = require("express");
const { authenticate } = require("../middleware/auth");
const router = express.Router();

// GET /api/watchlist
router.get("/", authenticate, async (req, res) => {
  try {
    const saved = await req.prisma.savedOpportunity.findMany({
      where: { userId: req.userId },
      include: { opportunity: true },
      orderBy: { savedAt: "desc" },
    });
    res.json(saved);
  } catch {
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

// POST /api/watchlist
router.post("/", authenticate, async (req, res) => {
  const { noticeId, title, agency, naicsCode, opportunityType, setAsideDescription,
          postedDate, responseDeadline, uiLink, notes } = req.body;
  if (!noticeId) return res.status(400).json({ error: "noticeId required" });
  try {
    // Upsert the opportunity into our cache
    const opp = await req.prisma.opportunity.upsert({
      where: { noticeId },
      update: {},
      create: { noticeId, title, agency, naicsCode, opportunityType, setAsideDescription, postedDate: postedDate ? new Date(postedDate) : null, responseDeadline: responseDeadline ? new Date(responseDeadline) : null, uiLink },
    });
    const saved = await req.prisma.savedOpportunity.upsert({
      where: { userId_opportunityId: { userId: req.userId, opportunityId: opp.id } },
      update: { notes },
      create: { userId: req.userId, opportunityId: opp.id, notes },
      include: { opportunity: true },
    });
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: "Failed to save opportunity" });
  }
});

// DELETE /api/watchlist/:noticeId
router.delete("/:noticeId", authenticate, async (req, res) => {
  try {
    const opp = await req.prisma.opportunity.findUnique({ where: { noticeId: req.params.noticeId } });
    if (!opp) return res.status(404).json({ error: "Not found" });
    await req.prisma.savedOpportunity.deleteMany({
      where: { userId: req.userId, opportunityId: opp.id },
    });
    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

module.exports = router;

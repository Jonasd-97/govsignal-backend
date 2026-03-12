const express = require("express");
const { authenticate, requirePlan } = require("../middleware/auth");
const { fetchAndScore, scoreOpportunity } = require("../services/samService");
const logger = require("../services/logger");

const router = express.Router();

// ── GET /api/opportunities ──
// Search and score opportunities from SAM.gov (or cache)
router.get("/", authenticate, async (req, res) => {
  const { naicsCode, setAside, agency, keyword, type, limit = 50, daysBack = 30 } = req.query;

  try {
    // Get user profile for scoring
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { naicsCode: true, setAside: true, targetAgency: true, samApiKey: true, plan: true },
    });

    // FREE plan: max 10 results, no custom filters
    const effectiveLimit = user.plan === "FREE" ? 10 : Math.min(Number(limit), 100);

    const filters = { naicsCode, type, keyword, limit: effectiveLimit, daysBack: Number(daysBack) };

    // Use user's own SAM key if they provided one, otherwise system key
    const apiKey = user.samApiKey || process.env.SAM_GOV_API_KEY;

    const opps = await fetchAndScore(filters, user, apiKey);

    // Apply agency/setAside filter post-fetch (SAM.gov doesn't support these as params cleanly)
    let filtered = opps;
    if (agency) filtered = filtered.filter(o => o.agency?.includes(agency));
    if (setAside) {
      const SET_ASIDE_MAP = {
        SBA: "small business", "8AN": "8(a)", HZC: "hubzone",
        SDVOSBC: "sdvosb", WOSB: "wosb", EDWOSB: "edwosb",
      };
      const label = SET_ASIDE_MAP[setAside] || setAside.toLowerCase();
      filtered = filtered.filter(o => o.setAsideDescription?.toLowerCase().includes(label));
    }

    res.json({
      data: filtered,
      total: filtered.length,
      plan: user.plan,
      limited: user.plan === "FREE" && filtered.length >= 10,
    });
  } catch (err) {
    logger.error("Opportunities fetch error:", err);
    res.status(502).json({ error: "Failed to fetch opportunities from SAM.gov", detail: err.message });
  }
});

// ── GET /api/opportunities/awards/history ──
// Competitor & award history lookup (PRO+ only)
// FIX: must be defined BEFORE /:noticeId or Express will treat "awards" as a noticeId param
router.get("/awards/history", authenticate, requirePlan("PRO", "AGENCY"), async (req, res) => {
  const { agency, naicsCode, keyword } = req.query;
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { samApiKey: true },
    });

    const apiKey = user.samApiKey || process.env.SAM_GOV_API_KEY;
    const { fetchOpportunities } = require("../services/samService");

    // Fetch award notices (type 'a')
    const awards = await fetchOpportunities({ type: "a", naicsCode, keyword, daysBack: 365 }, apiKey);
    const filtered = agency ? awards.filter(a => a.agency?.includes(agency)) : awards;

    res.json({ data: filtered.slice(0, 50), total: filtered.length });
  } catch (err) {
    logger.error("Awards history error:", err);
    res.status(502).json({ error: "Failed to fetch award history" });
  }
});

// ── GET /api/opportunities/:noticeId ──
// Get single opportunity detail (from cache or SAM.gov)
router.get("/:noticeId", authenticate, async (req, res) => {
  const { noticeId } = req.params;
  try {
    // Check cache first
    const cached = await req.prisma.opportunity.findUnique({ where: { noticeId } });
    if (cached) {
      const user = await req.prisma.user.findUnique({
        where: { id: req.userId },
        select: { naicsCode: true, setAside: true, targetAgency: true },
      });
      const scoring = scoreOpportunity(cached, user);
      return res.json({ ...cached, ...scoring });
    }
    res.status(404).json({ error: "Opportunity not found" });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch opportunity" });
  }
});

module.exports = router;

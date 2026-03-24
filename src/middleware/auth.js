const jwt = require("jsonwebtoken");

const PRO_MONTHLY_LIMIT = 50;

// Verify JWT and attach user to request
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userPlan = decoded.plan;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Require a specific plan tier
// FIX: re-fetch plan from DB to prevent stale JWT tokens granting elevated access
// after a subscription is cancelled (old token could still say PRO for up to 7 days)
const requirePlan = (...plans) => async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { plan: true },
    });

    if (!user || !plans.includes(user.plan)) {
      return res.status(403).json({
        error: "This feature requires a paid plan",
        requiredPlan: plans[0],
        currentPlan: user?.plan || "FREE",
        upgradeUrl: `${process.env.FRONTEND_URL}/pricing`,
      });
    }

    // Keep req.userPlan in sync with DB
    req.userPlan = user.plan;
    next();
  } catch (err) {
    return res.status(500).json({ error: "Failed to verify plan" });
  }
};

// Check and increment AI usage counter
// PRO: 50 calls/month. AGENCY: unlimited.
// Must run AFTER authenticate + requirePlan so req.userPlan is set.
const checkAiLimit = async (req, res, next) => {
  try {
    // Agency is unlimited — skip entirely
    if (req.userPlan === "AGENCY") return next();

    const now = new Date();
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { aiUsageCount: true, aiUsageResetAt: true, plan: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    // Reset counter if we've passed the reset date (or it's never been set)
    const needsReset = !user.aiUsageResetAt || now >= user.aiUsageResetAt;
    if (needsReset) {
      // Set next reset to 1st of next month at midnight UTC
      const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      await req.prisma.user.update({
        where: { id: req.userId },
        data: { aiUsageCount: 1, aiUsageResetAt: nextReset },
      });
      return next();
    }

    // Block if PRO limit reached
    if (user.aiUsageCount >= PRO_MONTHLY_LIMIT) {
      return res.status(429).json({
        error: `You've used all ${PRO_MONTHLY_LIMIT} AI analyses for this month.`,
        usageCount: user.aiUsageCount,
        limit: PRO_MONTHLY_LIMIT,
        resetAt: user.aiUsageResetAt,
        upgradeUrl: `${process.env.FRONTEND_URL}/pricing`,
      });
    }

    // Increment counter and continue
    await req.prisma.user.update({
      where: { id: req.userId },
      data: { aiUsageCount: { increment: 1 } },
    });

    next();
  } catch (err) {
    return res.status(500).json({ error: "Failed to check usage limit" });
  }
};

module.exports = { authenticate, requirePlan, checkAiLimit };

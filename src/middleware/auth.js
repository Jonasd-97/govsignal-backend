const jwt = require("jsonwebtoken");

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

module.exports = { authenticate, requirePlan };

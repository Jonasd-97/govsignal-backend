require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { PrismaClient } = require("@prisma/client");

const logger = require("./services/logger");
const authRoutes = require("./routes/auth");
const opportunityRoutes = require("./routes/opportunities");
const watchlistRoutes = require("./routes/watchlist");
const { searchRouter, perfRouter } = require("./routes/searches"); // FIX: destructure named exports
const digestRoutes = require("./routes/digest");
const stripeRoutes = require("./routes/stripe");
const { startDigestJob } = require("./jobs/digestJob");
const { startSamSyncJob } = require("./jobs/samSyncJob");

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

// Stripe webhooks need raw body — mount BEFORE express.json()
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Global rate limiter — 200 requests per 15 minutes per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Too many requests. Please try again later." },
}));

// Attach prisma to every request
app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

// ── ROUTES ──
app.use("/api/auth",          authRoutes);
app.use("/api/opportunities",  opportunityRoutes);
app.use("/api/watchlist",     watchlistRoutes);
app.use("/api/searches",      searchRouter);      // FIX: use destructured routers
app.use("/api/performance",   perfRouter);
app.use("/api/digest",        digestRoutes);
app.use("/api/stripe",        stripeRoutes);

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// 404 handler
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ── START ──
app.listen(PORT, async () => {
  logger.info(`GovSignal API running on port ${PORT}`);
  try {
    await prisma.$connect();
    logger.info("Database connected");
    // Start background jobs
    startDigestJob();
    startSamSyncJob();
  } catch (err) {
    logger.error("Database connection failed:", err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = app;

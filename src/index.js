require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const logger = require('./services/logger');
const authRoutes = require('./routes/auth');
const opportunityRoutes = require('./routes/opportunities');
const watchlistRoutes = require('./routes/watchlist');
const { searchRouter, perfRouter } = require('./routes/searches');
const digestRoutes = require('./routes/digest');
const stripeRoutes = require('./routes/stripe');
const aiRoutes = require('./routes/ai');
const { startDigestJob } = require('./jobs/digestJob');
const { startSamSyncJob, runSamSyncCycle } = require('./jobs/samSyncJob');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Please try again later.' },
}));
app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/searches', searchRouter);
app.use('/api/performance', perfRouter);
app.use('/api/digest', digestRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/ai', aiRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/admin/sync', async (req, res) => {
  if (!process.env.ADMIN_SYNC_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_SYNC_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await runSamSyncCycle();
    res.json({ message: 'Sync completed' });
  } catch (err) {
    logger.error('Admin sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

app.listen(PORT, async () => {
  logger.info(`GovSignal API running on port ${PORT}`);
  try {
    await prisma.$connect();
    logger.info('Database connected');
    if (process.env.ENABLE_JOBS === 'true') {
      startDigestJob();
      startSamSyncJob();
      logger.info('Background jobs enabled');
    } else {
      logger.info('Background jobs disabled on this instance');
    }
  } catch (err) {
    logger.error('Database connection failed:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = app;

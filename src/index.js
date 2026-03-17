require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

// Routes
const authRoutes = require('./routes/auth');
const opportunityRoutes = require('./routes/opportunities');
const watchlistRoutes = require('./routes/watchlist');
const searchRoutes = require('./routes/searches');
const performanceRoutes = require('./routes/performance');
const digestRoutes = require('./routes/digest');
const stripeRoutes = require('./routes/stripe');
const aiRoutes = require('./routes/ai');

// Jobs
const { startSamSyncJob } = require('./jobs/samSyncJob');
const { startDigestJob } = require('./jobs/digestJob');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

/* =========================
   CORS CONFIG (FIXED)
========================= */

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://govsignal.vercel.app',
];

const isVercelPreview = (origin) => {
  return /^https:\/\/govsignal-.*\.vercel\.app$/.test(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || isVercelPreview(origin)) {
      return callback(null, true);
    }

    console.log('❌ CORS blocked:', origin);
    return callback(new Error(`CORS not allowed for ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

/* =========================
   SECURITY + MIDDLEWARE
========================= */

app.use(helmet());

// Stripe webhook MUST come before json parser
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '2mb' }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests. Please try again later.' },
  })
);

// Attach prisma to request
app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

/* =========================
   ROUTES
========================= */

console.log('authRoutes:', typeof authRoutes, authRoutes);
console.log('opportunityRoutes:', typeof opportunityRoutes, opportunityRoutes);
console.log('watchlistRoutes:', typeof watchlistRoutes, watchlistRoutes);
console.log('searchRoutes:', typeof searchRoutes, searchRoutes);
console.log('performanceRoutes:', typeof performanceRoutes, performanceRoutes);
console.log('digestRoutes:', typeof digestRoutes, digestRoutes);
console.log('stripeRoutes:', typeof stripeRoutes, stripeRoutes);
console.log('aiRoutes:', typeof aiRoutes, aiRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/searches', searchRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/digest', digestRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/ai', aiRoutes);

/* =========================
   HEALTH CHECK
========================= */

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/* =========================
   ADMIN ROUTE (SAFE)
========================= */

app.post('/admin/sync', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SYNC_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await startSamSyncJob(prisma, true);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin sync error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

/* =========================
   BACKGROUND JOBS
========================= */

if (process.env.ENABLE_JOBS === 'true') {
  startSamSyncJob(prisma);
  startDigestJob(prisma);
}

/* =========================
   ERROR HANDLER
========================= */

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);

  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: err.message });
  }

  res.status(500).json({ error: 'Internal server error' });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

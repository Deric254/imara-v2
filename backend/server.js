// server.js — IMARA LINKS Backend
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

// db/index.js selects SQLite or Neon based on DATABASE_TYPE env var
const { initDb } = require('./db');

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : true; // allow all in dev

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.set('trust proxy', 1);

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 })); // global

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many login attempts — try again in 15 minutes' }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',           loginLimiter, require('./routes/auth'));
app.use('/api/users',                        require('./routes/users'));
app.use('/api/daily',                        require('./routes/daily'));
app.use('/api/reconciliation',               require('./routes/reconciliation'));
app.use('/api/backup',                       require('./routes/backup'));
app.use('/api/database',                     require('./routes/database'));
app.use('/api/invoices',                     require('./routes/invoices'));
app.use('/api/inventory',                    require('./routes/inventory'));
app.use('/api',                              require('./routes/reports'));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.stack || err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔗  IMARA LINKS API  →  http://localhost:${PORT}`);
    console.log(`    Health check     →  http://localhost:${PORT}/health\n`);
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});

module.exports = app;

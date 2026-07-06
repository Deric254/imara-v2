// server.js — IMARA LINKS Backend
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const { initDb } = require('./db');

// ── Safety guard: refuse to start with the default placeholder secret ─────────
const KNOWN_UNSAFE_SECRETS = [
  'your-secret-key-change-this-in-production-12345',
  'change-this-to-a-long-random-secret-string',
  'secret',
  'changeme',
];
if (process.env.NODE_ENV === 'production' && KNOWN_UNSAFE_SECRETS.includes(process.env.JWT_SECRET)) {
  console.error('\n\n❌  FATAL: JWT_SECRET is set to a known default placeholder.');
  console.error('    This is a critical security risk in production.');
  console.error('    Set a strong random JWT_SECRET in your .env file and restart.\n');
  process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('\n\n❌  FATAL: JWT_SECRET is missing or too short (minimum 16 characters).');
  console.error('    Set a strong random JWT_SECRET in your .env file and restart.\n');
  process.exit(1);
}

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
app.use('/api',                              require('./routes/orders'));
app.use('/api',                              require('./routes/reports'));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  // express.json() throws a SyntaxError (with type 'entity.parse.failed') when
  // the request body is not valid JSON. This is a client input problem, not a
  // server fault, so it should be a 400 — not fall through to the generic 500.
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
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

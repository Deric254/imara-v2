// routes/auth.js — IMARA LINKS Authentication
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { getDb }  = require('../db');
const { authenticate, requireRole, writeAudit, JWT_SECRET } = require('../middleware/auth');

/* POST /api/auth/login */
router.post('/login',
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const { username, password } = req.body;
      const db   = getDb();
      const user = await db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!user || !user.active) {
        await writeAudit(db, { action: `FAILED_LOGIN:${username}`, ip: req.ip });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (!bcrypt.compareSync(password, user.password)) {
        await writeAudit(db, { action: `FAILED_LOGIN:${username}`, ip: req.ip });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // FIX: include password_changed_at in token payload so old tokens are
      // rejected the moment a password changes (see authenticate middleware)
      const token = jwt.sign(
        { id: user.id, role: user.role, pca: user.password_changed_at ? new Date(user.password_changed_at).getTime() : 0 },
        JWT_SECRET,
        { expiresIn: '12h' }
      );
      await writeAudit(db, { userId: user.id, action: 'LOGIN', ip: req.ip });
      res.json({
        token,
        user: {
          id: user.id, username: user.username, role: user.role,
          full_name: user.full_name, phone: user.phone || '', email: user.email || ''
        }
      });
    } catch(e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* GET /api/auth/me */
router.get('/me', authenticate, async (req, res) => {
  try {
    const db   = getDb();
    const user = await db.prepare(
      'SELECT id,username,role,full_name,phone,email,active FROM users WHERE id=?'
    ).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch(e) {
    console.error('GET /me error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* PATCH /api/auth/profile */
router.patch('/profile', authenticate,
  body('username').optional().trim().isLength({ min: 3 }).withMessage('Username min 3 characters'),
  body('full_name').trim().notEmpty().withMessage('Full name required'),
  body('phone').optional().trim(),
  body('email').optional().trim().isEmail().withMessage('Invalid email').bail().optional({ checkFalsy: true }),
  body('new_password').optional({ checkFalsy: true }).isLength({ min: 8 }).withMessage('New password min 8 characters'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const { full_name, phone = '', email = '', new_password } = req.body;
      const safePhone = (phone || '').trim();
      const safeEmail = (email || '').trim();
      const db     = getDb();
      const target = await db.prepare('SELECT username, role, password FROM users WHERE id=?').get(req.user.id);
      let username = target.username;

      if (req.body.username && req.body.username !== target.username) {
        if (req.user.role !== 'owner')
          return res.status(403).json({ error: 'Only the System Owner can change their username' });
        if (await db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(req.body.username, req.user.id))
          return res.status(409).json({ error: 'Username already taken' });
        username = req.body.username;
      }

      if (new_password) {
        // FIX: stamp password_changed_at so any existing JWTs are invalidated immediately
        const passwordHash = bcrypt.hashSync(new_password, 12);
        await db.prepare(
          'UPDATE users SET username=?, full_name=?, phone=?, email=?, password=?, password_changed_at=datetime(\'now\'), updated_at=datetime(\'now\') WHERE id=?'
        ).run(username, full_name.trim(), safePhone, safeEmail, passwordHash, req.user.id);
      } else {
        await db.prepare(
          'UPDATE users SET username=?, full_name=?, phone=?, email=?, updated_at=datetime(\'now\') WHERE id=?'
        ).run(username, full_name.trim(), safePhone, safeEmail, req.user.id);
      }

      await writeAudit(db, { userId: req.user.id, action: 'UPDATE_PROFILE', table: 'users', recordId: req.user.id, ip: req.ip });
      const updated = await db.prepare(
        'SELECT id,username,role,full_name,phone,email FROM users WHERE id=?'
      ).get(req.user.id);
      res.json({ user: updated });
    } catch(e) {
      console.error('Profile update error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* POST /api/auth/change-password */
router.post('/change-password', authenticate,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }).withMessage('Min 8 characters'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const db   = getDb();
      const user = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!bcrypt.compareSync(req.body.current_password, user.password))
        return res.status(401).json({ error: 'Current password incorrect' });

      // FIX: stamp password_changed_at — invalidates all existing JWT sessions
      await db.prepare('UPDATE users SET password=?, password_changed_at=datetime(\'now\'), updated_at=datetime(\'now\') WHERE id=?')
        .run(bcrypt.hashSync(req.body.new_password, 12), req.user.id);
      await writeAudit(db, { userId: req.user.id, action: 'PASSWORD_CHANGED', ip: req.ip });
      res.json({ message: 'Password changed successfully. Please log in again with your new password.' });
    } catch(e) {
      console.error('Change password error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* GET /api/auth/public-config — unauthenticated, returns only public branding */
router.get('/public-config', async (_req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare(
      "SELECT key, value FROM config WHERE key IN ('business_name','business_slogan','currency')"
    ).all();
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json(cfg);
  } catch(e) {
    console.error('public-config error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   SECURITY QUESTIONS — owner sets 3 questions+answers while logged in
   FIX: requireRole('owner') added — backend now enforces what the UI assumed
   POST /api/auth/security-questions/set
───────────────────────────────────────────────────────────────────────────── */
router.post('/security-questions/set',
  authenticate,
  requireRole('owner'),
  body('q1').trim().notEmpty().withMessage('Question 1 required'),
  body('a1').trim().notEmpty().withMessage('Answer 1 required'),
  body('q2').trim().notEmpty().withMessage('Question 2 required'),
  body('a2').trim().notEmpty().withMessage('Answer 2 required'),
  body('q3').trim().notEmpty().withMessage('Question 3 required'),
  body('a3').trim().notEmpty().withMessage('Answer 3 required'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const { q1, a1, q2, a2, q3, a3 } = req.body;
      const db = getDb();
      const a1h = bcrypt.hashSync(a1.trim().toLowerCase(), 10);
      const a2h = bcrypt.hashSync(a2.trim().toLowerCase(), 10);
      const a3h = bcrypt.hashSync(a3.trim().toLowerCase(), 10);
      await db.prepare(`
        INSERT INTO security_questions(user_id,q1,a1_hash,q2,a2_hash,q3,a3_hash,updated_at)
        VALUES(?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(user_id) DO UPDATE
          SET q1=EXCLUDED.q1, a1_hash=EXCLUDED.a1_hash,
              q2=EXCLUDED.q2, a2_hash=EXCLUDED.a2_hash,
              q3=EXCLUDED.q3, a3_hash=EXCLUDED.a3_hash,
              updated_at=datetime('now')
      `).run(req.user.id, q1.trim(), a1h, q2.trim(), a2h, q3.trim(), a3h);
      await writeAudit(db, { userId: req.user.id, action: 'SET_SECURITY_QUESTIONS', table: 'security_questions', ip: req.ip });
      res.json({ message: 'Security questions saved successfully.' });
    } catch(e) {
      console.error('Set security questions error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* GET /api/auth/security-questions/status — check if questions are set */
router.get('/security-questions/status',
  authenticate,
  requireRole('owner'),
  async (req, res) => {
    try {
      const db  = getDb();
      const row = await db.prepare('SELECT q1,q2,q3,updated_at FROM security_questions WHERE user_id=?').get(req.user.id);
      if (!row) return res.json({ set: false });
      res.json({ set: true, questions: [row.q1, row.q2, row.q3], updated_at: row.updated_at });
    } catch(e) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────────────────────
   FORGOT PASSWORD — step 1: get questions for a username (unauthenticated)
   GET /api/auth/forgot-password/questions?username=xxx
───────────────────────────────────────────────────────────────────────────── */
router.get('/forgot-password/questions', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required' });
    const db   = getDb();
    const user = await db.prepare("SELECT id,active FROM users WHERE username=?").get(username);
    if (!user || !user.active) {
      return res.json({ found: false, message: 'No security questions set for this account. Contact your administrator.' });
    }
    const sq = await db.prepare('SELECT q1,q2,q3 FROM security_questions WHERE user_id=?').get(user.id);
    if (!sq) {
      return res.json({ found: false, message: 'No security questions set for this account. Contact your administrator.' });
    }
    res.json({ found: true, questions: [sq.q1, sq.q2, sq.q3] });
  } catch(e) {
    console.error('Forgot password questions error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   FORGOT PASSWORD — step 2: submit answers, get a short-lived reset token
   POST /api/auth/forgot-password/verify
───────────────────────────────────────────────────────────────────────────── */
router.post('/forgot-password/verify',
  body('username').trim().notEmpty().withMessage('Username required'),
  body('a1').trim().notEmpty().withMessage('Answer 1 required'),
  body('a2').trim().notEmpty().withMessage('Answer 2 required'),
  body('a3').trim().notEmpty().withMessage('Answer 3 required'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const { username, a1, a2, a3 } = req.body;
      const db   = getDb();
      const user = await db.prepare("SELECT id,active FROM users WHERE username=?").get(username.trim());
      const FAIL = () => res.status(401).json({ error: 'Answers incorrect. Please try again.' });
      if (!user || !user.active) return FAIL();
      const sq = await db.prepare('SELECT * FROM security_questions WHERE user_id=?').get(user.id);
      if (!sq) return FAIL();
      const ok = bcrypt.compareSync(a1.trim().toLowerCase(), sq.a1_hash)
              && bcrypt.compareSync(a2.trim().toLowerCase(), sq.a2_hash)
              && bcrypt.compareSync(a3.trim().toLowerCase(), sq.a3_hash);
      if (!ok) {
        await writeAudit(db, { userId: user.id, action: 'FAILED_SECURITY_ANSWER', ip: req.ip });
        return FAIL();
      }
      const crypto = require('crypto');
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db.prepare("UPDATE password_reset_tokens SET used=1 WHERE user_id=? AND used=0").run(user.id);
      await db.prepare(
        "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(?,?,?)"
      ).run(user.id, tokenHash, expiresAt);
      await writeAudit(db, { userId: user.id, action: 'PASSWORD_RESET_REQUESTED', ip: req.ip });
      res.json({ reset_token: rawToken, expires_in_minutes: 15 });
    } catch(e) {
      console.error('Forgot password verify error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────────────────────
   FORGOT PASSWORD — step 3: use reset token to set new password
   ACID: marking the token used and updating the password run inside one
   db.transaction() — SQLite has no RETURNING-based single-statement way to
   do both, so it's two statements, but they commit or roll back together.
   Also stamps password_changed_at to invalidate all existing JWT sessions.
   POST /api/auth/forgot-password/reset
───────────────────────────────────────────────────────────────────────────── */
router.post('/forgot-password/reset',
  body('reset_token').trim().notEmpty().withMessage('Reset token required'),
  body('new_password').isLength({ min: 8 }).withMessage('Password min 8 characters'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const crypto    = require('crypto');
      const tokenHash = crypto.createHash('sha256').update(req.body.reset_token.trim()).digest('hex');
      const db        = getDb();

      const row = await db.prepare(
        "SELECT * FROM password_reset_tokens WHERE token_hash=? AND used=0"
      ).get(tokenHash);
      if (!row) return res.status(400).json({ error: 'Invalid or already used reset token.' });
      if (new Date(row.expires_at) < new Date())
        return res.status(400).json({ error: 'Reset token has expired. Please start again.' });

      const newHash = bcrypt.hashSync(req.body.new_password, 12);

      // ACID: both statements must land together — a crash between them would
      // otherwise burn the token without ever changing the password, locking
      // the user out with no way to retry (the token is one-time-use).
      // SQLite-compatible: two statements (no RETURNING support in SQLite).
      await db.transaction(async () => {
        await db.prepare(
          'UPDATE password_reset_tokens SET used=1 WHERE id=? AND used=0'
        ).run(row.id);
        await db.prepare(
          "UPDATE users SET password=?, password_changed_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
        ).run(newHash, row.user_id);
      });

      await writeAudit(db, { userId: row.user_id, action: 'PASSWORD_RESET_COMPLETED', ip: req.ip });
      res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch(e) {
      console.error('Forgot password reset error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;

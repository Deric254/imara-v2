// routes/users.js — IMARA LINKS
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb }  = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');

/* GET /api/users */
router.get('/', authenticate, requireRole('owner','admin'), async (_req, res) => {
  try {
    const db = getDb();
    res.json(await db.prepare(
      'SELECT id,username,full_name,role,active,phone,email,created_at,updated_at FROM users ORDER BY role,full_name'
    ).all());
  } catch(e) {
    console.error('GET /users error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* POST /api/users — create user */
router.post('/',
  authenticate, requireRole('owner','admin'),
  body('username').trim().isLength({ min: 3 }).withMessage('Username min 3 characters'),
  body('password').isLength({ min: 8 }).withMessage('Password min 8 characters'),
  body('full_name').trim().notEmpty().withMessage('Full name required'),
  body('role').isIn(['admin','knuckler','operator']).withMessage('Role must be admin, knuckler, or operator'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      if (req.user.role === 'admin' && req.body.role === 'admin')
        return res.status(403).json({ error: 'Admin cannot create Admin users' });

      const { username, password, full_name, role, phone = '', email = '' } = req.body;
      const db = getDb();

      if (await db.prepare('SELECT id FROM users WHERE username=?').get(username))
        return res.status(409).json({ error: 'Username already taken' });

      const result = await db.prepare(
        'INSERT INTO users(username,password,role,full_name,phone,email,password_changed_at) VALUES(?,?,?,?,?,?,NOW()) RETURNING id'
      ).run(username, bcrypt.hashSync(password, 12), role, full_name, phone, email);

      await writeAudit(db, { userId: req.user.id, action: 'CREATE_USER', table: 'users',
        recordId: result.lastInsertRowid, newVals: { username, role }, ip: req.ip });

      res.status(201).json({
        id: result.lastInsertRowid, username, full_name, role, active: 1, phone, email
      });
    } catch(e) {
      console.error('POST /users error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* POST /api/users/owner/admin-reset — admin issues a reset token for the owner
   Must be BEFORE /:id routes so Express does not treat "owner" as a numeric id */
router.post('/owner/admin-reset',
  authenticate, requireRole('admin'),
  async (req, res) => {
    try {
      const db    = getDb();
      const owner = await db.prepare("SELECT id,active FROM users WHERE role='owner' LIMIT 1").get();
      if (!owner || !owner.active)
        return res.status(404).json({ error: 'No active owner account found.' });
      const crypto    = require('crypto');
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
      await db.prepare("UPDATE password_reset_tokens SET used=1 WHERE user_id=? AND used=0").run(owner.id);
      await db.prepare(
        "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(?,?,?)"
      ).run(owner.id, tokenHash, expiresAt);
      await writeAudit(db, {
        userId: req.user.id,
        action: 'ADMIN_ISSUED_OWNER_RESET_TOKEN',
        table: 'users', recordId: owner.id, ip: req.ip
      });
      res.json({
        reset_token: rawToken,
        expires_in_minutes: 30,
        message: 'Give this token to the owner. It expires in 30 minutes and can only be used once.'
      });
    } catch(e) {
      console.error('Admin owner reset error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* PATCH /api/users/:id */
router.patch('/:id',
  authenticate, requireRole('owner','admin'),
  body('username').optional().trim().isLength({ min: 3 }).withMessage('Username min 3 characters'),
  body('full_name').optional().trim().notEmpty(),
  body('phone').optional().trim(),
  body('email').optional().trim(),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const targetId = parseInt(req.params.id);
      const db = getDb();
      const target = await db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (target.role === 'owner' && req.user.role !== 'owner')
        return res.status(403).json({ error: 'Only Owner can edit Owner profile' });

      let username = target.username;
      if (req.body.username && req.body.username !== target.username) {
        if (req.user.role !== 'owner')
          return res.status(403).json({ error: 'Only the System Owner can change usernames' });
        if (await db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(req.body.username, targetId))
          return res.status(409).json({ error: 'Username already taken' });
        username = req.body.username;
      }

      const full_name = req.body.full_name ?? target.full_name;
      const phone     = req.body.phone     ?? target.phone ?? '';
      const email     = req.body.email     ?? target.email ?? '';

      await db.prepare("UPDATE users SET username=?, full_name=?, phone=?, email=?, updated_at=NOW() WHERE id=?")
        .run(username, full_name, phone, email, targetId);

      await writeAudit(db, { userId: req.user.id, action: 'EDIT_USER', table: 'users',
        recordId: targetId, newVals: { username, full_name, phone, email }, ip: req.ip });

      const updated = await db.prepare('SELECT id,username,role,full_name,phone,email,active FROM users WHERE id=?').get(targetId);
      res.json(updated);
    } catch(e) {
      console.error('PATCH /users/:id error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* PATCH /api/users/:id/deactivate */
router.patch('/:id/deactivate', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const db = getDb();
    const target = await db.prepare('SELECT * FROM users WHERE id=?').get(targetId);

    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner') return res.status(403).json({ error: 'Cannot deactivate Owner' });
    if (target.role === 'admin' && req.user.role !== 'owner')
      return res.status(403).json({ error: 'Only Owner can deactivate Admin' });
    if (targetId === req.user.id)
      return res.status(403).json({ error: 'Cannot deactivate yourself' });

    await db.prepare("UPDATE users SET active=0, updated_at=NOW() WHERE id=?").run(targetId);
    await writeAudit(db, { userId: req.user.id, action: 'DEACTIVATE_USER', table: 'users', recordId: targetId, ip: req.ip });
    res.json({ message: 'User deactivated' });
  } catch(e) {
    console.error('Deactivate error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* PATCH /api/users/:id/activate */
router.patch('/:id/activate', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const db = getDb();
    const target = await db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'admin' && req.user.role !== 'owner')
      return res.status(403).json({ error: 'Only Owner can activate Admin' });

    await db.prepare("UPDATE users SET active=1, updated_at=NOW() WHERE id=?").run(targetId);
    await writeAudit(db, { userId: req.user.id, action: 'ACTIVATE_USER', table: 'users', recordId: targetId, ip: req.ip });
    res.json({ message: 'User activated' });
  } catch(e) {
    console.error('Activate error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* POST /api/users/:id/reset-password
   FIX: now also stamps password_changed_at so the user's active JWT is
   invalidated and they must log in fresh with the new password.           */
router.post('/:id/reset-password',
  authenticate, requireRole('owner','admin'),
  body('new_password').isLength({ min: 8 }).withMessage('Min 8 characters'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const targetId = parseInt(req.params.id);
      const db = getDb();
      const target = await db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.role === 'owner' && req.user.role !== 'owner')
        return res.status(403).json({ error: 'Cannot reset Owner password' });
      if (target.role === 'admin' && req.user.role !== 'owner')
        return res.status(403).json({ error: 'Only Owner can reset Admin password' });

      // FIX: stamp password_changed_at — forces the user to re-login immediately
      await db.prepare("UPDATE users SET password=?, password_changed_at=NOW(), updated_at=NOW() WHERE id=?")
        .run(bcrypt.hashSync(req.body.new_password, 12), targetId);
      await writeAudit(db, { userId: req.user.id, action: 'RESET_PASSWORD', table: 'users', recordId: targetId, ip: req.ip });
      res.json({ message: 'Password reset successfully. The user must log in with the new password.' });
    } catch(e) {
      console.error('Reset password error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;

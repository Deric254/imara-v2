// routes/config.js — IMARA LINKS Configuration API
const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');

// GET /api/config - Get all configuration values
router.get('/config', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const configs = await db.prepare('SELECT key, value FROM config').all();
    const configObj = {};
    configs.forEach(c => configObj[c.key] = c.value);
    res.json(configObj);
  } catch (error) {
    console.error('Config load error:', error);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// PUT /api/config - Update configuration values
router.put('/config', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const updates = req.body;
    const results = {};

    for (const [key, value] of Object.entries(updates)) {
      await db.prepare(`
        INSERT INTO config (key, value, updated_by, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
      `).run(key, value, req.user.id);

      results[key] = value;
    }

    // Audit log
    await writeAudit(db, {
      userId: req.user.id,
      action: 'CONFIG_UPDATE',
      table: 'config',
      newVals: updates,
      ip: req.ip
    });

    res.json({ success: true, updated: results });
  } catch (error) {
    console.error('Config update error:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// GET /api/piece-types - Get all piece types
router.get('/piece-types', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const pieceTypes = await db.prepare('SELECT * FROM piece_types ORDER BY name').all();
    res.json(pieceTypes);
  } catch (error) {
    console.error('Piece types load error:', error);
    res.status(500).json({ error: 'Failed to load piece types' });
  }
});

// POST /api/piece-types - Create new piece type
router.post('/piece-types', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const { name, length_m, weight_kg, default_price } = req.body;
    const result = await db.prepare(`
      INSERT INTO piece_types (name, length_m, weight_kg, default_price)
      VALUES (?, ?, ?, ?)
    `).run(name, length_m, weight_kg, default_price);

    await writeAudit(db, {
      userId: req.user.id,
      action: 'CREATE',
      table: 'piece_types',
      recordId: result.lastInsertRowid,
      newVals: { name, length_m, weight_kg, default_price },
      ip: req.ip
    });

    res.json({ id: result.lastInsertRowid, name, length_m, weight_kg, default_price, active: 1 });
  } catch (error) {
    console.error('Piece type create error:', error);
    res.status(500).json({ error: 'Failed to create piece type' });
  }
});

// PUT /api/piece-types/:id - Update piece type
router.put('/piece-types/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const { id } = req.params;
    const { name, length_m, weight_kg, default_price } = req.body;

    const oldData = await db.prepare('SELECT * FROM piece_types WHERE id = ?').get(id);
    if (!oldData) return res.status(404).json({ error: 'Piece type not found' });

    await db.prepare(`
      UPDATE piece_types
      SET name = ?, length_m = ?, weight_kg = ?, default_price = ?
      WHERE id = ?
    `).run(name, length_m, weight_kg, default_price, id);

    await writeAudit(db, {
      userId: req.user.id,
      action: 'UPDATE',
      table: 'piece_types',
      recordId: id,
      oldVals: oldData,
      newVals: { name, length_m, weight_kg, default_price },
      ip: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Piece type update error:', error);
    res.status(500).json({ error: 'Failed to update piece type' });
  }
});

// DELETE /api/piece-types/:id - Delete piece type
router.delete('/piece-types/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const { id } = req.params;

    const oldData = await db.prepare('SELECT * FROM piece_types WHERE id = ?').get(id);
    if (!oldData) return res.status(404).json({ error: 'Piece type not found' });

    await db.prepare('UPDATE piece_types SET active = 0 WHERE id = ?').run(id);

    await writeAudit(db, {
      userId: req.user.id,
      action: 'DELETE',
      table: 'piece_types',
      recordId: id,
      oldVals: oldData,
      ip: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Piece type delete error:', error);
    res.status(500).json({ error: 'Failed to delete piece type' });
  }
});

// GET /api/suppliers - Get all suppliers
router.get('/suppliers', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const suppliers = await db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all();
    res.json(suppliers);
  } catch (error) {
    console.error('Suppliers load error:', error);
    res.status(500).json({ error: 'Failed to load suppliers' });
  }
});

// POST /api/suppliers - Create new supplier
router.post('/suppliers', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const { name } = req.body;
    const result = await db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name);

    await writeAudit(db, {
      userId: req.user.id,
      action: 'CREATE',
      table: 'suppliers',
      recordId: result.lastInsertRowid,
      newVals: { name },
      ip: req.ip
    });

    res.json({ id: result.lastInsertRowid, name, active: 1 });
  } catch (error) {
    console.error('Supplier create error:', error);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// DELETE /api/suppliers/:id - Delete supplier
router.delete('/suppliers/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const { id } = req.params;

    const oldData = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!oldData) return res.status(404).json({ error: 'Supplier not found' });

    await db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(id);

    await writeAudit(db, {
      userId: req.user.id,
      action: 'DELETE',
      table: 'suppliers',
      recordId: id,
      oldVals: oldData,
      ip: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Supplier delete error:', error);
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

// GET /api/audit - Get audit log entries
router.get('/audit', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to, limit = 1000 } = req.query;

    let query = `
      SELECT 
        a.*,
        u.username,
        u.full_name
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (from) {
      query += ' AND a.logged_at >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND a.logged_at <= ?';
      params.push(to + ' 23:59:59');
    }

    query += ' ORDER BY a.logged_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const auditEntries = await db.prepare(query).all(...params);
    res.json(auditEntries);
  } catch (error) {
    console.error('Audit load error:', error);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// GET /api/workers - Get workers (operators and knucklers)
router.get('/workers', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const workers = await db.prepare(
      "SELECT id, full_name, role FROM users WHERE active=1 AND role IN ('knuckler','operator','admin','owner') ORDER BY full_name"
    ).all();
    res.json(workers);
  } catch (error) {
    console.error('Workers load error:', error);
    res.status(500).json({ error: 'Failed to load workers' });
  }
});

module.exports = router;
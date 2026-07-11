// routes/database.js — IMARA LINKS
// Admin-only database manager: list tables, run queries, export/import
const express = require('express');
const router  = express.Router();
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { getDb } = require('../db');

const ADMIN_OR_OWNER = [authenticate, requireRole('owner', 'admin')];
const OWNER_ONLY      = [authenticate, requireRole('owner')];

// ── GET /api/database/tables — list all tables with row counts ────────────────
router.get('/tables', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all();
    const tables = [];
    for (const row of rows) {
      try {
        const cnt = await db.prepare(`SELECT COUNT(*) as c FROM "${row.name}"`).get();
        tables.push({ name: row.name, row_count: cnt.c });
      } catch(_) {
        tables.push({ name: row.name, row_count: 0 });
      }
    }
    res.json({ tables, database_type: 'SQLite' });
  } catch (err) {
    console.error('db/tables error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/database/table/:name — fetch rows from a table ──────────────────
router.get('/table/:name', ...ADMIN_OR_OWNER, async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const db = getDb();
    const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;

    const rows  = await db.prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`).all(limit, offset);
    const total = await db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get();

    let columns = [];
    if (rows.length > 0) {
      columns = Object.keys(rows[0]);
    } else {
      const info = await db.prepare(`PRAGMA table_info("${name}")`).all();
      columns = info.map(c => c.name);
    }

    res.json({ rows, columns, total: Number(total.c), limit, offset });
  } catch (err) {
    console.error('db/table error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/database/query — run an arbitrary SQL query ────────────────────
// OWNER ONLY: this can write to any table, including audit_log itself, which
// would let a write here erase the evidence of the write. Everything else in
// this file (listing tables, viewing rows, viewing schema) is read-only and
// stays available to Admin — only the ability to execute arbitrary writes is
// restricted here.
router.post('/query', ...OWNER_ONLY, async (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
    return res.status(400).json({ error: 'No SQL provided' });
  }

  const trimmed  = sql.trim();
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();

  try {
    const db    = getDb();
    const start = Date.now();
    let result;

    if (firstWord === 'SELECT' || firstWord === 'WITH' || firstWord === 'EXPLAIN' || firstWord === 'PRAGMA') {
      const rows    = await db.prepare(trimmed).all();
      const elapsed = Date.now() - start;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      result = { type: 'select', rows, columns, row_count: rows.length, elapsed_ms: elapsed };
    } else {
      const info    = await db.prepare(trimmed).run();
      const elapsed = Date.now() - start;
      result = {
        type: 'write',
        changes: info.changes ?? 0,
        last_insert_id: info.lastInsertRowid ?? null,
        elapsed_ms: elapsed,
        message: `Query executed successfully. ${info.changes ?? 0} row(s) affected.`
      };
    }

    if (result.type === 'write') {
      await writeAudit(db, {
        userId: req.user.id,
        action: 'DB_QUERY_WRITE',
        table: 'database_manager',
        newVals: { sql: trimmed.slice(0, 500), changes: result.changes },
        ip: req.ip
      });
    }

    res.json(result);
  } catch (err) {
    console.error('db/query error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/database/schema/:name — get column definitions for a table ───────
router.get('/schema/:name', ...ADMIN_OR_OWNER, async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const db      = getDb();
    const columns = await db.prepare(`PRAGMA table_info("${name}")`).all();
    res.json({ table: name, columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

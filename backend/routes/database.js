// routes/database.js — IMARA LINKS
// Admin-only database manager: list tables, run queries, export/import
const express = require('express');
const router  = express.Router();
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { getDb } = require('../db');

const ADMIN_OR_OWNER = [authenticate, requireRole('owner', 'admin')];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Detect if we're on SQLite (local) or PostgreSQL (Neon)
function isLocalSQLite() {
  return process.env.DATABASE_TYPE !== 'neon';
}

// ── GET /api/database/tables — list all tables with row counts ────────────────
router.get('/tables', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    let tables = [];

    if (isLocalSQLite()) {
      const rows = await db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      ).all();
      for (const row of rows) {
        try {
          const cnt = await db.prepare(`SELECT COUNT(*) as c FROM "${row.name}"`).get();
          tables.push({ name: row.name, row_count: cnt.c });
        } catch(_) {
          tables.push({ name: row.name, row_count: 0 });
        }
      }
    } else {
      // PostgreSQL / Neon
      const rows = await db.prepare(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      ).all();
      for (const row of rows) {
        try {
          const cnt = await db.prepare(`SELECT COUNT(*) as c FROM "${row.table_name}"`).get();
          tables.push({ name: row.table_name, row_count: Number(cnt.c) });
        } catch(_) {
          tables.push({ name: row.table_name, row_count: 0 });
        }
      }
    }

    res.json({ tables, database_type: isLocalSQLite() ? 'SQLite' : 'PostgreSQL' });
  } catch (err) {
    console.error('db/tables error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/database/table/:name — fetch all rows from a table ───────────────
router.get('/table/:name', ...ADMIN_OR_OWNER, async (req, res) => {
  const name = req.params.name;
  // Validate: only allow safe table names (alphanumeric + underscore)
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await db.prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`).all(limit, offset);
    const total = await db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get();

    // Get column info
    let columns = [];
    if (rows.length > 0) {
      columns = Object.keys(rows[0]);
    } else if (isLocalSQLite()) {
      const info = await db.prepare(`PRAGMA table_info("${name}")`).all();
      columns = info.map(c => c.name);
    } else {
      const info = await db.prepare(
        `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = 'public' ORDER BY ordinal_position`
      ).all(name);
      columns = info.map(c => c.column_name);
    }

    res.json({ rows, columns, total: Number(total.c), limit, offset });
  } catch (err) {
    console.error('db/table error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/database/query — run an arbitrary SQL query ─────────────────────
router.post('/query', ...ADMIN_OR_OWNER, async (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
    return res.status(400).json({ error: 'No SQL provided' });
  }

  // Trim and get first keyword
  const trimmed = sql.trim();
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();

  try {
    const db = getDb();
    const start = Date.now();

    let result;

    if (firstWord === 'SELECT' || firstWord === 'WITH' || firstWord === 'EXPLAIN' || firstWord === 'PRAGMA') {
      // Read query
      const rows = await db.prepare(trimmed).all();
      const elapsed = Date.now() - start;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      result = { type: 'select', rows, columns, row_count: rows.length, elapsed_ms: elapsed };
    } else {
      // Write query (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, etc.)
      const info = await db.prepare(trimmed).run();
      const elapsed = Date.now() - start;
      result = {
        type: 'write',
        changes: info.changes ?? info.rowCount ?? 0,
        last_insert_id: info.lastInsertRowid ?? null,
        elapsed_ms: elapsed,
        message: `Query executed successfully. ${info.changes ?? 0} row(s) affected.`
      };
    }

    // Audit every write query
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

// ── GET /api/database/schema/:name — get column definitions for a table ────────
router.get('/schema/:name', ...ADMIN_OR_OWNER, async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const db = getDb();
    let columns = [];

    if (isLocalSQLite()) {
      columns = await db.prepare(`PRAGMA table_info("${name}")`).all();
    } else {
      columns = await db.prepare(
        `SELECT column_name as name, data_type as type, is_nullable, column_default as dflt_value
         FROM information_schema.columns
         WHERE table_name = ? AND table_schema = 'public'
         ORDER BY ordinal_position`
      ).all(name);
    }

    res.json({ table: name, columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

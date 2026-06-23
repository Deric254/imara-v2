// routes/backup.js
const express = require('express');
const router  = express.Router();
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { getDb } = require('../db');
const bcrypt = require('bcryptjs');

const OWNER_ONLY      = [authenticate, requireRole('owner')];
const ADMIN_OR_OWNER  = [authenticate, requireRole('owner', 'admin')];

// All tables in the correct insert order (parents before children)
const ALL_TABLES = [
  'config', 'suppliers', 'piece_types',
  'users',
  'purchases', 'production', 'production_items',
  'sales',
  'invoices', 'invoice_items', 'invoice_payments',
  'payments', 'rent_months',
  'stock_reservations',
  'notifications', 'audit_log'
];

/* ── GET /api/backup/export ─────────────────────────────────────────────────── */
router.get('/export', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

    const backups = {};
    for (const table of ALL_TABLES) {
      try {
        backups[table] = await db.prepare(`SELECT * FROM ${table}`).all();
      } catch (e) {
        console.warn(`Warning: Could not backup table ${table}:`, e.message);
        backups[table] = [];
      }
    }

    const totalRecords = Object.values(backups).reduce((s, t) => s + t.length, 0);

    const backupData = {
      export_date:   new Date().toISOString(),
      version:       '3.0',
      database:      'imara_links',
      tables:        backups,
      summary: {
        total_tables:  Object.keys(backups).length,
        total_records: totalRecords
      }
    };

    await writeAudit(db, {
      userId:  req.user.id,
      action:  'DATABASE_EXPORT',
      table:   'backup',
      newVals: { tables_count: Object.keys(backups).length, records_count: totalRecords },
      ip:      req.ip
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="imara_links_backup_${timestamp}.json"`);
    res.json(backupData);

  } catch (error) {
    console.error('Backup export error:', error);
    res.status(500).json({ error: 'BACKUP_FAILED', message: 'Failed to create database backup' });
  }
});

/* ── POST /api/backup/import ────────────────────────────────────────────────── */
router.post('/import', ...ADMIN_OR_OWNER, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const db = getDb();
    const backupData = req.body;

    if (!backupData.tables || typeof backupData.tables !== 'object') {
      return res.status(400).json({ error: 'INVALID_FORMAT', message: 'Invalid backup format.' });
    }

    const SUPPORTED_VERSIONS = ['2.0', '3.0'];
    if (backupData.version && !SUPPORTED_VERSIONS.includes(backupData.version)) {
      return res.status(400).json({
        error:   'VERSION_MISMATCH',
        message: `Backup version ${backupData.version} not supported.`
      });
    }

    const importResults = { success: [], failed: [], total_imported: 0 };

    // Insert in parent-first order so foreign keys are never orphaned
    const orderedTables = ALL_TABLES.filter(t => backupData.tables[t]);
    // Also handle any extra tables in the backup that aren't in our list
    const extraTables = Object.keys(backupData.tables).filter(t => !ALL_TABLES.includes(t));

    for (const tableName of [...orderedTables, ...extraTables]) {
      const records = backupData.tables[tableName];
      if (!Array.isArray(records) || records.length === 0) continue;

      try {
        let imported = 0;

        if (tableName === 'users') {
          // Users: merge by username — update non-sensitive fields, skip if username exists
          for (const record of records) {
            try {
              const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(record.username);
              if (existing) {
                // User already exists — skip (don't overwrite passwords or roles)
                continue;
              }
              // New user from backup — insert with original id preserved
              const cols  = Object.keys(record).join(', ');
              const phs   = Object.keys(record).map(() => '?').join(', ');
              const vals  = Object.values(record);
              await db.prepare(`INSERT OR IGNORE INTO users (${cols}) VALUES (${phs})`).run(...vals);
              imported++;
            } catch(e) {
              // skip individual user errors silently
            }
          }
        } else {
          // All other tables: INSERT OR REPLACE preserving original IDs
          // This restores FK integrity — invoice_items still point to the right invoice IDs
          for (const record of records) {
            try {
              const cols = Object.keys(record).join(', ');
              const phs  = Object.keys(record).map(() => '?').join(', ');
              const vals = Object.values(record);
              await db.prepare(
                `INSERT OR REPLACE INTO ${tableName} (${cols}) VALUES (${phs})`
              ).run(...vals);
              imported++;
            } catch(e) {
              // skip individual row errors
            }
          }
        }

        importResults.total_imported += imported;
        importResults.success.push(`${tableName} (${imported})`);

      } catch (e) {
        importResults.failed.push({ table: tableName, reason: e.message });
      }
    }

    await writeAudit(db, {
      userId:  req.user.id,
      action:  'DATABASE_IMPORT',
      table:   'backup',
      newVals: importResults,
      ip:      req.ip
    });

    res.json({
      message: 'Import completed',
      results: importResults,
      summary: `Imported ${importResults.total_imported} records across ${importResults.success.length} tables.`
    });

  } catch (error) {
    console.error('Backup import error:', error);
    res.status(500).json({ error: 'IMPORT_FAILED', message: 'Failed to import backup' });
  }
});

/* ── POST /api/backup/stamp ─────────────────────────────────────────────────── *
 * Called by the frontend after a successful export download to record the
 * timestamp of the last known-good backup. Also accepts the second_path write
 * result so we can store that too.  No file I/O here — the Electron main process
 * handles the actual file write via IPC; this just keeps the DB timestamp.      */
router.post('/stamp', ...ADMIN_OR_OWNER, express.json(), async (req, res) => {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO config(key,value) VALUES('last_backup_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(now);
    res.json({ ok: true, last_backup_at: now });
  } catch(e) {
    console.error('Backup stamp error:', e);
    res.status(500).json({ error: 'Failed to record backup timestamp' });
  }
});

/* ── GET /api/backup/health ─────────────────────────────────────────────────── *
 * Returns last backup timestamp and second-path config so the frontend and
 * the startup check can both use one endpoint.                                   */
router.get('/health', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const lastRow   = await db.prepare(`SELECT value FROM config WHERE key='last_backup_at'`).get();
    const pathRow   = await db.prepare(`SELECT value FROM config WHERE key='backup_second_path'`).get();
    const last      = lastRow?.value || null;
    const secondPath = pathRow?.value || '';
    const hoursSince = last
      ? (Date.now() - new Date(last).getTime()) / 36e5
      : Infinity;
    res.json({
      last_backup_at:   last,
      hours_since:      hoursSince === Infinity ? null : parseFloat(hoursSince.toFixed(1)),
      overdue:          hoursSince > 48,
      second_path_set:  !!secondPath,
      second_path:      secondPath,
    });
  } catch(e) {
    res.status(500).json({ error: 'Failed to get backup health' });
  }
});

/* ── POST /api/backup/set-second-path ──────────────────────────────────────── */
router.post('/set-second-path', ...OWNER_ONLY, express.json(), async (req, res) => {
  try {
    const db = getDb();
    const { path: newPath } = req.body;
    const value = (newPath || '').trim();
    await db.prepare(`INSERT INTO config(key,value) VALUES('backup_second_path',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(value);
    await writeAudit(db, {
      userId: req.user.id, action: 'SET_BACKUP_SECOND_PATH',
      table: 'config', newVals: { path: value }, ip: req.ip
    });
    res.json({ ok: true, path: value });
  } catch(e) {
    res.status(500).json({ error: 'Failed to save second backup path' });
  }
});

/* ── GET /api/backup/test ───────────────────────────────────────────────────── */
router.get('/test', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.prepare('SELECT COUNT(*) as count FROM users').get();
    res.json({ message: 'Database connection successful', user_count: result.count, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'DATABASE_TEST_FAILED', message: error.message });
  }
});

/* ── GET /api/backup/status ─────────────────────────────────────────────────── */
router.get('/status', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const status = {};
    let totalRecords = 0;
    for (const table of ALL_TABLES) {
      try {
        const count = await db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
        status[table] = parseInt(count.count) || 0;
        totalRecords += status[table];
      } catch (e) {
        status[table] = 'Error';
      }
    }
    res.json({
      backup_available: true,
      backup_version:   '3.0',
      table_counts:     status,
      total_records:    totalRecords
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

/* ── POST /api/backup/reset-data  — Owner only ──────────────────────────────── */
router.post('/reset-data', authenticate, requireRole('owner'), async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET_ALL_DATA')
    return res.status(400).json({ error: 'Send { confirm: "RESET_ALL_DATA" } to confirm' });
  try {
    const db = getDb();
    await db.transaction(async () => {
      await db.exec('DELETE FROM invoice_payments');
      await db.exec('DELETE FROM invoice_items');
      await db.exec('DELETE FROM invoices');
      await db.exec('DELETE FROM stock_reservations');
      await db.exec('DELETE FROM audit_log');
      await db.exec('DELETE FROM notifications');
      await db.exec('DELETE FROM payments');
      await db.exec('DELETE FROM rent_months');
      await db.exec('DELETE FROM production_items');
      await db.exec('DELETE FROM production');
      await db.exec('DELETE FROM sales');
      await db.exec('DELETE FROM purchases');
    });
    res.json({ message: 'All business data cleared. Users, config, and structure preserved.' });
  } catch(e) {
    console.error('Reset error:', e);
    res.status(500).json({ error: 'Internal server error during reset' });
  }
});

module.exports = router;

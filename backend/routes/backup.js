// routes/backup.js
const express = require('express');
const router  = express.Router();
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { getDb } = require('../db');

const OWNER_ONLY      = [authenticate, requireRole('owner')];
const ADMIN_OR_OWNER  = [authenticate, requireRole('owner', 'admin')];

// All tables in the correct insert order (parents before children)
const ALL_TABLES = [
  'config', 'suppliers', 'piece_types',
  'users',
  'purchases', 'production', 'production_items',
  'sales',
  'invoices', 'invoice_items', 'invoice_payments',
  'orders', 'order_items',
  'payments', 'rent_months',
  'no_activity_days',
  'notifications', 'audit_log'
];

/* ── GET /api/backup/export ─────────────────────────────────────────────────── */
router.get('/export', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

    const backups = {};
    const tableErrors = {};
    for (const table of ALL_TABLES) {
      try {
        backups[table] = await db.prepare(`SELECT * FROM ${table}`).all();
      } catch (e) {
        console.warn(`Warning: Could not backup table ${table}:`, e.message);
        backups[table] = [];
        tableErrors[table] = e.message;
      }
    }

    const totalRecords = Object.values(backups).reduce((s, t) => s + t.length, 0);
    const exportComplete = Object.keys(tableErrors).length === 0;

    const backupData = {
      export_date:   new Date().toISOString(),
      version:       '3.0',
      database:      'imara_links',
      tables:        backups,
      // export_complete=false means at least one table failed to read during
      // export (see table_errors) — this file is not a trustworthy point-in-time
      // snapshot and /import refuses to restore from it.
      export_complete: exportComplete,
      table_errors:  tableErrors,
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
// OWNER ONLY: a restore overwrites live business data across every table.
// Also: table and column names below come from the uploaded file itself, not
// from the schema, so they're validated against a strict allowlist/pattern
// before ever reaching a SQL string — a backup file is just JSON on disk and
// can be edited by anyone before being re-uploaded.
//
// DISASTER-RECOVERY SEMANTICS: this restores the system exactly as it was at
// the moment of backup — not a merge with whatever exists now. Every table
// present in the backup (including users) is fully replaced with the
// backup's rows, so a role/password/active-state change made after the
// backup is reverted too, same as any other data. A restore is assumed to be
// recovery from a disaster, not a convenience merge.
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/;
router.post('/import', ...OWNER_ONLY, express.json({ limit: '50mb' }), async (req, res) => {
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

    // A backup that failed to fully capture one or more tables at export time
    // is not a trustworthy point-in-time snapshot. Restoring from it would
    // wipe those tables' current data and replace it with nothing. Refuse
    // before touching the database. (Older backups predating this field are
    // trusted as-is — there's no way to retroactively check them.)
    if (backupData.export_complete === false) {
      const failedTables = Object.keys(backupData.table_errors || {}).join(', ') || 'unknown table(s)';
      return res.status(400).json({
        error:   'INCOMPLETE_BACKUP',
        message: `This backup file did not fully capture the database at export time (failed: ${failedTables}). Restoring from it would erase current data for those tables. Aborted — no changes made.`
      });
    }

    // Only tables this app actually knows about are ever restored, in
    // parent-first order — a genuine backup (from /export, right above)
    // never contains anything else, so this drops nothing legitimate while
    // closing off arbitrary table names coming from an uploaded file.
    const orderedTables = ALL_TABLES.filter(t => Object.prototype.hasOwnProperty.call(backupData.tables, t));

    // Pre-flight validation — every row's column names are checked against
    // the allowlist BEFORE any destructive operation runs, so a malformed
    // file is rejected up front instead of mid-restore with data already wiped.
    for (const tableName of orderedTables) {
      const records = backupData.tables[tableName];
      if (!Array.isArray(records)) {
        return res.status(400).json({
          error:   'INVALID_FORMAT',
          message: `Backup file has a malformed entry for table "${tableName}" — expected a list of rows. Aborted — no changes made.`
        });
      }
      for (const record of records) {
        if (!record || typeof record !== 'object' || !Object.keys(record).every(k => SAFE_IDENTIFIER.test(k))) {
          return res.status(400).json({
            error:   'INVALID_FORMAT',
            message: `Backup file contains an invalid row or column name in table "${tableName}". Aborted — no changes made.`
          });
        }
      }
    }

    const importResults = { success: [], total_imported: 0 };

    // ACID + full replace, ONE transaction: every table present in the backup
    // is cleared and reloaded from the backup's rows. Deletes run in reverse
    // dependency order (children first), inserts in forward dependency order
    // (parents first) — same graph ALL_TABLES already encodes — so foreign
    // keys are never left dangling mid-restore. If ANY row anywhere fails,
    // the whole thing throws and the transaction rolls back completely: a
    // failed restore must fail loudly and leave the database exactly as it
    // was before the restore was attempted — never half-done, and never
    // silently missing rows while reporting success.
    await db.transaction(async () => {
      for (const tableName of [...orderedTables].reverse()) {
        try {
          await db.exec(`DELETE FROM ${tableName}`);
        } catch (e) {
          throw new Error(`Restore aborted — could not clear table "${tableName}" before restoring it: ${e.message}`);
        }
      }

      for (const tableName of orderedTables) {
        const records = backupData.tables[tableName];
        let imported = 0;
        for (const record of records) {
          const keys = Object.keys(record);
          const cols = keys.join(', ');
          const phs  = keys.map(() => '?').join(', ');
          const vals = Object.values(record);
          try {
            await db.prepare(`INSERT INTO ${tableName} (${cols}) VALUES (${phs})`).run(...vals);
            imported++;
          } catch (e) {
            throw new Error(`Restore aborted — failed to restore "${tableName}" row (id=${record.id ?? '?'}): ${e.message}`);
          }
        }
        importResults.total_imported += imported;
        importResults.success.push(`${tableName} (${imported})`);
      }
    });

    // Non-critical: this audit write runs after the restore has already
    // committed. If the acting user's own account isn't part of the restored
    // users table (e.g. it was created after the backup was taken), this
    // insert can itself fail — that must not turn an actually-successful
    // restore into a reported failure, so writeAudit's default (log and
    // continue) applies here rather than propagating.
    await writeAudit(db, {
      userId:  req.user.id,
      action:  'DATABASE_IMPORT',
      table:   'backup',
      newVals: importResults,
      ip:      req.ip
    });

    res.json({
      message: 'Restore completed — database matches the backup exactly.',
      results: importResults,
      summary: `Restored ${importResults.total_imported} records across ${importResults.success.length} tables.`
    });

  } catch (error) {
    console.error('Backup import error:', error);
    res.status(500).json({ error: 'IMPORT_FAILED', message: error.message || 'Failed to restore backup — no changes were made.' });
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
      await db.exec('DELETE FROM order_items');
      await db.exec('DELETE FROM orders');
      await db.exec('DELETE FROM invoices');
      await db.exec('DELETE FROM audit_log');
      await db.exec('DELETE FROM notifications');
      await db.exec('DELETE FROM payments');
      await db.exec('DELETE FROM rent_months');
      await db.exec('DELETE FROM no_activity_days');
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

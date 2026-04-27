// routes/backup.js
// PostgreSQL backup implementation using JSON export
const express = require('express');
const router = express.Router();
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { getDb } = require('../db');

const OWNER_ONLY = [authenticate, requireRole('owner')];
const ADMIN_OR_OWNER = [authenticate, requireRole('owner', 'admin')];

/* GET /api/backup/export */
router.get('/export', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    
    // Get all tables to backup
    const tables = [
      // Reference / config
      'users', 'config', 'piece_types', 'suppliers',
      // Core business transactions
      'purchases', 'production', 'production_items',
      'sales',
      // Invoices & payments (financial records)
      'invoices', 'invoice_items', 'invoice_payments',
      // Reconciliation
      'payments', 'rent_months',
      // System
      'audit_log', 'notifications', 'stock_reservations'
    ];
    
    const backups = {};
    
    for (const table of tables) {
      try {
        const data = await db.prepare(`SELECT * FROM ${table}`).all();
        // Always include the table (even if empty) so the backup is complete
        backups[table] = data || [];
      } catch (e) {
        console.warn(`Warning: Could not backup table ${table}:`, e.message);
      }
    }
    
    // Create a comprehensive backup JSON
    const backupData = {
      export_date: new Date().toISOString(),
      version: '3.0',
      database: 'neon_postgresql',
      tables: backups,
      summary: {
        total_tables: Object.keys(backups).length,
        total_records: Object.values(backups).reduce((sum, table) => sum + table.length, 0)
      }
    };
    
    // Write audit log
    await writeAudit(db, {
      userId: req.user.id,
      action: 'DATABASE_EXPORT',
      table: 'backup',
      newVals: { 
        tables_count: Object.keys(backups).length,
        records_count: Object.values(backups).reduce((sum, table) => sum + table.length, 0),
        export_date: backupData.export_date
      },
      ip: req.ip
    });
    
    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="imara_links_backup_${timestamp}.json"`);
    
    res.json(backupData);
    
  } catch (error) {
    console.error('Backup export error:', error);
    res.status(500).json({ 
      error: 'BACKUP_FAILED',
      message: 'Failed to create database backup' 
    });
  }
});

/* POST /api/backup/import */
router.post('/import', ...ADMIN_OR_OWNER, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const db = getDb();
    const backupData = req.body;
    
    if (!backupData.tables || typeof backupData.tables !== 'object') {
      return res.status(400).json({
        error: 'INVALID_FORMAT',
        message: 'Invalid backup format. Expected JSON with tables object.'
      });
    }
    
    // Validate backup version compatibility
    const SUPPORTED_VERSIONS = ['2.0', '3.0'];
    if (backupData.version && !SUPPORTED_VERSIONS.includes(backupData.version)) {
      return res.status(400).json({
        error: 'VERSION_MISMATCH',
        message: `Backup version ${backupData.version} is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`
      });
    }
    
    const importResults = {
      success: [],
      failed: [],
      total_imported: 0
    };
    
    // Import each table (this is a simplified version - production would need more validation)
    for (const [tableName, records] of Object.entries(backupData.tables)) {
      if (!Array.isArray(records) || records.length === 0) {
        continue;
      }
      
      try {
        // Skip tables that must not be overwritten on import
        // audit_log and notifications are append-only system logs; users managed separately
        if (['users', 'audit_log', 'notifications'].includes(tableName)) {
          importResults.failed.push({
            table: tableName,
            reason: 'Skipped: this table is managed separately and cannot be overwritten via restore'
          });
          continue;
        }

        for (const record of records) {
          // Strip auto-generated fields — DB will reassign them on INSERT
          const { id, created_at, updated_at, ...cleanRecord } = record;

          if (Object.keys(cleanRecord).length === 0) continue;

          // Use ? placeholders (required by the pg/neon driver wrapper used here)
          const columns      = Object.keys(cleanRecord).join(', ');
          const placeholders = Object.keys(cleanRecord).map(() => '?').join(', ');
          const values       = Object.values(cleanRecord);

          await db.prepare(
            `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
          ).run(...values);
          importResults.total_imported++;
        }
        
        importResults.success.push(tableName);
        
      } catch (e) {
        importResults.failed.push({
          table: tableName,
          reason: e.message
        });
      }
    }
    
    // Write audit log
    await writeAudit(db, {
      userId: req.user.id,
      action: 'DATABASE_IMPORT',
      table: 'backup',
      newVals: importResults,
      ip: req.ip
    });
    
    res.json({
      message: 'Import completed',
      results: importResults,
      summary: `Successfully imported ${importResults.total_imported} records across ${importResults.success.length} tables.`
    });
    
  } catch (error) {
    console.error('Backup import error:', error);
    res.status(500).json({ 
      error: 'IMPORT_FAILED',
      message: 'Failed to import database backup' 
    });
  }
});

/* GET /api/backup/test - Test database connection */
router.get('/test', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    console.log('Testing database connection...');
    const db = getDb();
    
    // Test basic query
    const result = await db.prepare('SELECT COUNT(*) as count FROM users').get();
    console.log('Database test result:', result);
    
    res.json({
      message: 'Database connection successful',
      user_count: result.count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({
      error: 'DATABASE_TEST_FAILED',
      message: 'Database connection test failed',
      details: error.message
    });
  }
});

/* GET /api/backup/status */
router.get('/status', ...ADMIN_OR_OWNER, async (req, res) => {
  try {
    const db = getDb();
    
    // Get table counts for backup status
    const tables = [
      'users', 'config', 'piece_types', 'suppliers',
      'purchases', 'production', 'production_items',
      'sales', 'invoices', 'invoice_items', 'invoice_payments',
      'payments', 'rent_months', 'audit_log', 'notifications', 'stock_reservations'
    ];
    const status = {};
    let totalRecords = 0;

    for (const table of tables) {
      try {
        const count = await db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
        status[table] = parseInt(count.count) || 0;
        totalRecords += status[table];
      } catch (e) {
        status[table] = 'Error';
      }
    }

    res.json({
      database_type: 'Neon PostgreSQL',
      backup_available: true,
      backup_version: '3.0',
      table_counts: status,
      total_records: totalRecords,
      tables_in_backup: tables.length,
      last_backup: 'Manual backup required — use Export to download'
    });
    
  } catch (error) {
    console.error('Backup status error:', error);
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

module.exports = router;

// ── POST /api/backup/reset-data  — Owner only, clears all business data ──────
router.post('/reset-data',
  authenticate, requireRole('owner'),
  async (req, res) => {
    const { confirm } = req.body;
    if (confirm !== 'RESET_ALL_DATA')
      return res.status(400).json({ error: 'Send { confirm: "RESET_ALL_DATA" } to confirm' });
    try {
      const db = getDb();
      await db.transaction(async () => {
        await db.exec('DELETE FROM invoice_items');
        await db.exec('DELETE FROM invoices');
        await db.exec('DELETE FROM audit_log');
        await db.exec('DELETE FROM notifications');
        await db.exec('DELETE FROM payments');
        await db.exec('DELETE FROM rent_months');
        await db.exec('DELETE FROM production_items');
        await db.exec('DELETE FROM production');
        await db.exec('DELETE FROM sales');
        await db.exec('DELETE FROM purchases');
        // Reset sequences
        for (const seq of [
          'purchases_id_seq','production_id_seq','production_items_id_seq',
          'sales_id_seq','invoices_id_seq','invoice_items_id_seq',
          'payments_id_seq','rent_months_id_seq','audit_log_id_seq'
        ]) {
          try { await db.exec(`ALTER SEQUENCE ${seq} RESTART WITH 1`); } catch(_) {}
        }
      });
      // Fix slogan
      await db.prepare(
        "UPDATE config SET value='Built Strong By IMARA' WHERE key='business_slogan' AND (value='' OR value IS NULL)"
      ).run();
      res.json({ message: 'All business data cleared. Structure, users and config preserved.' });
    } catch(e) {
      console.error('Reset error:', e);
      res.status(500).json({ error: 'Internal server error during reset' });
    }
  }
);

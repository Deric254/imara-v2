// backend/db/migrations.js — Database schema migrations
// Ensures backwards compatibility when app updates

const fs = require('fs');
const path = require('path');

// Define all migrations in order (will only run if not already applied)
const MIGRATIONS = [
  {
    id: '001-initial-schema',
    version: '1.0.0',
    description: 'Initial schema setup',
    async up(db) {
      // Already created by schema.js — this is a marker
    },
  },
  {
    id: '002-add-backup-timestamps',
    version: '2.0.0',
    description: 'Add backup-related timestamps to invoices',
    async up(db) {
      try {
        const checkColumn = await db.prepare(
          "PRAGMA table_info(invoices)"
        ).all();
        const hasBackupColumn = checkColumn.some(col => col.name === 'backup_at');
        if (!hasBackupColumn) {
          await db.exec("ALTER TABLE invoices ADD COLUMN backup_at DATETIME DEFAULT NULL");
        }
      } catch (err) {
        console.warn('Migration 002: Column might already exist', err?.message);
      }
    },
  },
  {
    id: '003-add-rent-month-to-payments',
    version: '2.1.0',
    description: 'Add rent_month column to payments so rent payments are matched by rent period, not payment date',
    async up(db) {
      try {
        const cols = await db.prepare('PRAGMA table_info(payments)').all();
        if (!cols.some(c => c.name === 'rent_month')) {
          await db.exec("ALTER TABLE payments ADD COLUMN rent_month TEXT DEFAULT NULL");
        }
      } catch (err) {
        console.warn('Migration 003: rent_month column might already exist', err?.message);
      }
    },
  },
  {
    id: '004-add-transport-to-market-payment-category',
    version: '2.2.0',
    description: 'Allow transport_to_market as a tracked payment category so market transport is fully reconciled',
    async up(db) {
      try {
        // SQLite cannot ALTER a CHECK constraint — must recreate the table.
        // All existing rows are preserved via INSERT INTO ... SELECT *.
        await db.exec(`PRAGMA foreign_keys = OFF`);
        await db.exec(`
          CREATE TABLE IF NOT EXISTS payments_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payment_date TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN (
              'wages_operator','wages_knuckler','rent','supplier',
              'sack','transport_to_market','other'
            )),
            payee_user_id INTEGER REFERENCES users(id),
            payee_supplier_id INTEGER REFERENCES suppliers(id),
            payee_name TEXT,
            rent_month TEXT DEFAULT NULL,
            amount REAL NOT NULL CHECK(amount > 0),
            notes TEXT DEFAULT '',
            recorded_by INTEGER NOT NULL REFERENCES users(id),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.exec(`INSERT INTO payments_v2 SELECT * FROM payments`);
        await db.exec(`DROP TABLE payments`);
        await db.exec(`ALTER TABLE payments_v2 RENAME TO payments`);
        await db.exec(`PRAGMA foreign_keys = ON`);
      } catch (err) {
        console.warn('Migration 004:', err?.message);
        try { await db.exec(`PRAGMA foreign_keys = ON`); } catch(_) {}
      }
    },
  },
  {
    id: '005-add-show-rent-dashboard-config',
    version: '2.3.0',
    description: 'Add show_rent_dashboard config key — off by default',
    async up(db) {
      try {
        await db.prepare(
          `INSERT OR IGNORE INTO config(key, value) VALUES('show_rent_dashboard', '0')`
        ).run();
      } catch (err) {
        console.warn('Migration 005:', err?.message);
      }
    },
  },
];

// Track which migrations have been applied
async function getMigrationsTable(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        version TEXT
      )
    `);
  } catch (err) {
    console.warn('schema_migrations table might already exist:', err?.message);
  }
}

async function getAppliedMigrations(db) {
  try {
    const rows = await db.prepare(
      `SELECT id FROM schema_migrations ORDER BY applied_at`
    ).all();
    return rows.map(r => r.id);
  } catch (err) {
    return [];
  }
}

async function runMigrations(db) {
  console.log('🔄 Checking database migrations...');
  try {
    await getMigrationsTable(db);
    const applied = await getAppliedMigrations(db);
    let newMigrations = 0;
    for (const migration of MIGRATIONS) {
      if (!applied.includes(migration.id)) {
        console.log(`📦 Running migration: ${migration.id} (${migration.version})`);
        try {
          await migration.up(db);
          await db.prepare(
            `INSERT INTO schema_migrations (id, version) VALUES (?, ?)`
          ).run(migration.id, migration.version);
          newMigrations++;
          console.log(`✅ Migration complete: ${migration.id}`);
        } catch (err) {
          console.error(`❌ Migration failed: ${migration.id}`, err?.message);
          throw err;
        }
      }
    }
    if (newMigrations === 0) {
      console.log('✅ Database schema is up-to-date');
    } else {
      console.log(`✅ Applied ${newMigrations} migration(s)`);
    }
  } catch (err) {
    console.error('Migration system error:', err);
    throw err;
  }
}

module.exports = { runMigrations };

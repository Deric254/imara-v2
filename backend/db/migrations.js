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
  // Add future migrations here as you update the app
  // Example:
  // {
  //   id: '003-add-new-feature',
  //   version: '2.1.0',
  //   description: 'Add new reporting fields',
  //   async up(db) {
  //     await db.exec("ALTER TABLE reports ADD COLUMN new_field TEXT");
  //   },
  // },
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

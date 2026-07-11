// backend/db/migrations.js — Database schema migrations
// Ensures backwards compatibility when app updates

const fs = require('fs');
const path = require('path');

// A migration's catch block should only ever swallow an error that means
// "this exact change was already applied" (e.g. a column/table that already
// exists from a previous run of this same migration) — that's genuinely
// benign and expected on a re-run. Any other error means the migration
// actually failed partway and the schema is now in an unknown state; that
// must propagate up so runMigrations() aborts boot instead of recording a
// broken migration as successfully applied.
function isBenignSchemaError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('already exists') ||
         msg.includes('duplicate column name') ||
         msg.includes('duplicate column');
}

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
        if (!isBenignSchemaError(err)) throw err;
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
        if (!isBenignSchemaError(err)) throw err;
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
        try { await db.exec(`PRAGMA foreign_keys = ON`); } catch(_) {}
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 004:', err?.message);
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
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 005:', err?.message);
      }
    },
  },
  {
    id: '006-real-landing-cost-batches',
    version: '2.4.0',
    description: 'Add batch_name + kgs_remaining to purchases and purchase_id to production for real (non-averaged) per-batch landing costs, with FIFO backfill for existing rows',
    async up(db) {
      try {
        const pCols = await db.prepare('PRAGMA table_info(purchases)').all();
        if (!pCols.some(c => c.name === 'batch_name')) {
          await db.exec("ALTER TABLE purchases ADD COLUMN batch_name TEXT NOT NULL DEFAULT ''");
        }
        if (!pCols.some(c => c.name === 'kgs_remaining')) {
          await db.exec('ALTER TABLE purchases ADD COLUMN kgs_remaining REAL');
        }
        const prCols = await db.prepare('PRAGMA table_info(production)').all();
        if (!prCols.some(c => c.name === 'purchase_id')) {
          await db.exec('ALTER TABLE production ADD COLUMN purchase_id INTEGER REFERENCES purchases(id)');
        }

        // FIFO backfill: only rows that don't have kgs_remaining/purchase_id set yet.
        // For each gauge, walk purchases oldest→newest and unattributed production
        // oldest→newest, simulating FIFO draw-down. This does NOT change
        // SUM(kgs_bought) or SUM(kgs_used) anywhere — it only attributes the
        // existing totals to specific batches so the new per-batch fields are
        // consistent with the historical (gauge-pooled) totals.
        const gauges = await db.prepare(`SELECT DISTINCT COALESCE(gauge,'') AS g FROM purchases`).all();
        for (const { g } of gauges) {
          const batches = await db.prepare(
            `SELECT id, kgs_bought FROM purchases WHERE COALESCE(gauge,'')=? AND kgs_remaining IS NULL ORDER BY entry_date ASC, id ASC`
          ).all(g);
          if (!batches.length) continue;
          const prodRows = await db.prepare(
            `SELECT id, kgs_used FROM production WHERE COALESCE(gauge,'')=? AND purchase_id IS NULL ORDER BY entry_date ASC, id ASC`
          ).all(g);
          const remaining = batches.map(b => ({ id: b.id, left: parseFloat(b.kgs_bought) || 0 }));
          let bi = 0;
          for (const pr of prodRows) {
            let need = parseFloat(pr.kgs_used) || 0;
            let firstBatch = null;
            while (need > 0.0001 && bi < remaining.length) {
              const b = remaining[bi];
              if (b.left <= 0.0001) { bi++; continue; }
              if (firstBatch === null) firstBatch = b.id;
              const take = Math.min(b.left, need);
              b.left -= take; need -= take;
              if (b.left <= 0.0001) bi++;
            }
            if (firstBatch) await db.prepare(`UPDATE production SET purchase_id=? WHERE id=?`).run(firstBatch, pr.id);
          }
          for (const b of remaining) {
            await db.prepare(`UPDATE purchases SET kgs_remaining=? WHERE id=?`).run(Math.max(0, parseFloat(b.left.toFixed(4))), b.id);
          }
        }
        // Safety net: any purchase rows somehow still NULL (e.g. no production at all) get kgs_remaining = kgs_bought
        await db.exec(`UPDATE purchases SET kgs_remaining = kgs_bought WHERE kgs_remaining IS NULL`);
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 006:', err?.message);
      }
    },
  },
  {
    id: '007-production-batch-usage',
    version: '2.5.0',
    description: 'Add production_batch_usage table so one production entry can honestly draw from multiple wire batches (FIFO cascade) with a true weighted-average landed cost, while keeping per-batch traceability for accurate stock reversal on delete. Backfills existing production rows as single-batch usage records.',
    async up(db) {
      try {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS production_batch_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            production_id INTEGER NOT NULL REFERENCES production(id) ON DELETE CASCADE,
            purchase_id INTEGER NOT NULL REFERENCES purchases(id),
            kgs_drawn REAL NOT NULL CHECK(kgs_drawn > 0),
            landed_cost_per_kg REAL NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_pbu_production ON production_batch_usage(production_id)`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_pbu_purchase   ON production_batch_usage(purchase_id)`);

        // Backfill: every existing production row becomes a single-batch usage
        // record against its current purchase_id, using that batch's real
        // landed cost (purchase cost/transport are never edited post-entry,
        // so this matches what was actually charged at the time). Idempotent —
        // skips rows that already have a usage record.
        const rows = await db.prepare(`
          SELECT pr.id AS production_id, pr.kgs_used, pr.purchase_id,
                 p.kgs_bought, p.cost_per_kg, p.transport_cost
          FROM production pr
          JOIN purchases p ON pr.purchase_id = p.id
          WHERE pr.purchase_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM production_batch_usage pbu WHERE pbu.production_id = pr.id)
        `).all();
        for (const r of rows) {
          const landedCost = r.kgs_bought > 0
            ? (r.kgs_bought * r.cost_per_kg + r.transport_cost) / r.kgs_bought
            : 0;
          await db.prepare(
            `INSERT INTO production_batch_usage(production_id,purchase_id,kgs_drawn,landed_cost_per_kg) VALUES(?,?,?,?)`
          ).run(r.production_id, r.purchase_id, parseFloat(r.kgs_used) || 0, landedCost);
        }
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 007:', err?.message);
      }
    },
  },
  {
    id: '008-payment-integrity-view',
    version: '2.5.1',
    description: 'Add v_invoice_payment_integrity view so the owner can spot any drift between invoices.amount_paid and Σ(invoice_payments). Also heals any existing drift caused by the pre-fix arithmetic path.',
    async up(db) {
      try {
        // Materialise a view that exposes discrepancies — zero rows = system is clean.
        await db.exec(`
          CREATE VIEW IF NOT EXISTS v_invoice_payment_integrity AS
          SELECT
            i.id,
            i.invoice_number,
            i.customer_name,
            i.total_amount,
            i.amount_paid            AS stored_amount_paid,
            COALESCE(SUM(ip.amount),0) AS ledger_sum,
            ROUND(i.amount_paid - COALESCE(SUM(ip.amount),0), 2) AS drift
          FROM invoices i
          LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
          GROUP BY i.id
          HAVING ABS(ROUND(i.amount_paid - COALESCE(SUM(ip.amount),0), 2)) > 0.005
        `);
        console.log('✅  v_invoice_payment_integrity view created');
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 008 view:', err?.message);
      }

      // Heal any existing drift: re-derive amount_paid from the ledger for every invoice.
      // This is safe and idempotent: if there is no drift the UPDATE changes nothing.
      try {
        await db.exec(`
          UPDATE invoices
          SET amount_paid = (
            SELECT COALESCE(SUM(ip.amount), 0)
            FROM invoice_payments ip
            WHERE ip.invoice_id = invoices.id
          )
          WHERE ABS(
            amount_paid - (
              SELECT COALESCE(SUM(ip.amount), 0)
              FROM invoice_payments ip
              WHERE ip.invoice_id = invoices.id
            )
          ) > 0.005
        `);
        console.log('✅  Invoice payment drift healed');
      } catch (err) {
        // No benign case here — this is a data heal, not a schema change,
        // so any error here is a real failure and must propagate.
        throw err;
      }
    },
  },
  {
    id: '009-sales-wire-cost-per-kg',
    version: '2.6.0',
    description: 'Add wire_cost_per_kg to sales table. Stores the actual blended wire cost per kg at the time of sale, resolved by FIFO from production records for that piece type. Immutable after insert — permanent record of cost at point of sale.',
    async up(db) {
      try {
        const cols = await db.prepare('PRAGMA table_info(sales)').all();
        if (!cols.some(c => c.name === 'wire_cost_per_kg')) {
          await db.exec('ALTER TABLE sales ADD COLUMN wire_cost_per_kg REAL NOT NULL DEFAULT 0');
        }

        // Backfill existing sales rows: for each sale, compute the blended wire
        // cost per kg from all production runs for that piece_type_id up to and
        // including the sale's entry_date. Uses production.total_cost minus
        // overheads — the exact stored cost from actual FIFO batch draws.
        const sales = await db.prepare(
          `SELECT id, piece_type_id, entry_date FROM sales WHERE wire_cost_per_kg = 0`
        ).all();

        for (const sale of sales) {
          const result = await db.prepare(`
            SELECT
              COALESCE(SUM(pr.total_cost - pr.operator_cost - pr.knuckler_cost - pr.sack_cost - pr.rent_allocation), 0) AS total_wire_cost,
              COALESCE(SUM(pr.kgs_used), 0) AS total_kgs
            FROM production pr
            JOIN production_items pi ON pi.production_id = pr.id
            WHERE pi.piece_type_id = ?
              AND pr.entry_date <= ?
          `).get(sale.piece_type_id, sale.entry_date);

          const wireCostPerKg = result.total_kgs > 0
            ? result.total_wire_cost / result.total_kgs
            : 0;

          await db.prepare(
            `UPDATE sales SET wire_cost_per_kg = ? WHERE id = ?`
          ).run(wireCostPerKg, sale.id);
        }
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 009:', err?.message);
      }
    },
  },

  {
    id: '010-order-items-sale-delete-fix',
    version: '2.7.0',
    description: 'Fix order_items.sale_id foreign key to ON DELETE SET NULL. Previously had no delete rule, so deleting a sale that originated from a converted order was blocked by SQLite\'s foreign key constraint and returned a 500 error — even when the sale was unpaid and safe to delete.',
    async up(db) {
      try {
        const info = await db.prepare('PRAGMA foreign_key_list(order_items)').all();
        const needsFix = info.some(fk => fk.table === 'sales' && (fk.on_delete || 'NO ACTION').toUpperCase() !== 'SET NULL');
        if (!needsFix) return;

        await db.exec('PRAGMA foreign_keys = OFF');
        await db.exec('BEGIN TRANSACTION');
        try {
          await db.exec(`
            CREATE TABLE order_items_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
              piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
              quantity INTEGER NOT NULL CHECK(quantity > 0),
              selling_price REAL,
              gauge_source TEXT DEFAULT '',
              transport_to_market REAL,
              sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL
            )
          `);
          await db.exec(`
            INSERT INTO order_items_new (id, order_id, piece_type_id, quantity, selling_price, gauge_source, transport_to_market, sale_id)
            SELECT id, order_id, piece_type_id, quantity, selling_price, gauge_source, transport_to_market, sale_id FROM order_items
          `);
          await db.exec('DROP TABLE order_items');
          await db.exec('ALTER TABLE order_items_new RENAME TO order_items');
          await db.exec('COMMIT');
        } catch (innerErr) {
          await db.exec('ROLLBACK');
          throw innerErr;
        } finally {
          await db.exec('PRAGMA foreign_keys = ON');
        }
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 010:', err?.message);
      }
    },
  },

  {
    id: '011-invoice-reversal-source',
    version: '2.8.0',
    description: 'Add reversal_source to invoices. Distinguishes a manually-cancelled invoice from one reversed as a cascade of deleting its originating sale, so the UI can label the two differently while keeping both greyed out and fully in the audit trail.',
    async up(db) {
      try {
        const cols = await db.prepare('PRAGMA table_info(invoices)').all();
        if (!cols.some(c => c.name === 'reversal_source')) {
          await db.exec("ALTER TABLE invoices ADD COLUMN reversal_source TEXT DEFAULT NULL");
        }
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 011:', err?.message);
      }
    },
  },
  {
    id: '012-durable-name-snapshots',
    version: '2.9.0',
    description: 'Capture the actor/counterparty name at the moment each record is created (entered_by_name, operator_name, knuckler_name, supplier_name, created_by_name, recorded_by_name, payee_name, user_name on audit_log). Historical records and exports must show who/what it was AT THE TIME, permanently — renaming a worker, admin, or supplier later must never rewrite past records. Existing rows are backfilled with the best available approximation (their current linked name); every new write going forward captures the true name at that moment.',
    async up(db) {
      const addCol = async (table, col, def = "TEXT DEFAULT NULL") => {
        try {
          const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
          if (!cols.some(c => c.name === col)) {
            await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        } catch (err) {
          if (!isBenignSchemaError(err)) throw err;
          console.warn(`Migration 012: ${table}.${col} might already exist`, err?.message);
        }
      };

      try {
        await addCol('audit_log', 'user_name');
        await addCol('purchases', 'entered_by_name');
        await addCol('purchases', 'supplier_name');
        await addCol('production', 'entered_by_name');
        await addCol('production', 'operator_name');
        await addCol('production', 'knuckler_name');
        await addCol('sales', 'entered_by_name');
        await addCol('invoices', 'created_by_name');
        await addCol('invoice_payments', 'recorded_by_name');
        await addCol('payments', 'recorded_by_name');
        await addCol('orders', 'created_by_name');

        // Backfill: best-effort — true historical name isn't recoverable for
        // rows written before this migration, so existing rows get whatever
        // name is currently on file. From this point forward every INSERT
        // captures the real name at that exact moment, permanently.
        await db.exec(`
          UPDATE audit_log SET user_name = (SELECT full_name FROM users WHERE id = audit_log.user_id)
          WHERE user_name IS NULL AND user_id IS NOT NULL
        `);
        await db.exec(`
          UPDATE purchases SET
            entered_by_name = (SELECT full_name FROM users WHERE id = purchases.entered_by),
            supplier_name   = (SELECT name FROM suppliers WHERE id = purchases.supplier_id)
          WHERE entered_by_name IS NULL OR supplier_name IS NULL
        `);
        await db.exec(`
          UPDATE production SET
            entered_by_name = (SELECT full_name FROM users WHERE id = production.entered_by),
            operator_name   = (SELECT full_name FROM users WHERE id = production.operator_id),
            knuckler_name   = (SELECT full_name FROM users WHERE id = production.knuckler_id)
          WHERE entered_by_name IS NULL
        `);
        await db.exec(`
          UPDATE sales SET entered_by_name = (SELECT full_name FROM users WHERE id = sales.entered_by)
          WHERE entered_by_name IS NULL
        `);
        await db.exec(`
          UPDATE invoices SET created_by_name = (SELECT full_name FROM users WHERE id = invoices.created_by)
          WHERE created_by_name IS NULL
        `);
        await db.exec(`
          UPDATE invoice_payments SET recorded_by_name = (SELECT full_name FROM users WHERE id = invoice_payments.recorded_by)
          WHERE recorded_by_name IS NULL
        `);
        await db.exec(`
          UPDATE payments SET recorded_by_name = (SELECT full_name FROM users WHERE id = payments.recorded_by)
          WHERE recorded_by_name IS NULL
        `);
        // payee_name previously was only ever populated for free-text payee
        // categories (sack/other/transport_to_market) — backfill it for
        // user- and supplier-linked payments too, so it becomes the one
        // reliable durable field for every payment regardless of category.
        await db.exec(`
          UPDATE payments SET payee_name = (SELECT full_name FROM users WHERE id = payments.payee_user_id)
          WHERE payee_name IS NULL AND payee_user_id IS NOT NULL
        `);
        await db.exec(`
          UPDATE payments SET payee_name = (SELECT name FROM suppliers WHERE id = payments.payee_supplier_id)
          WHERE payee_name IS NULL AND payee_supplier_id IS NOT NULL
        `);
        await db.exec(`
          UPDATE orders SET created_by_name = (SELECT full_name FROM users WHERE id = orders.created_by)
          WHERE created_by_name IS NULL
        `);
      } catch (err) {
        // addCol() above already handles the one benign case (column exists).
        // Anything reaching here — including any backfill UPDATE failure —
        // is a real failure and must propagate.
        throw err;
      }
    },
  },
  {
    id: '013-drop-stock-reservations',
    version: '2.10.0',
    description: 'Drop stock_reservations table — dead schema from before the confirmed design decision that orders do not reserve stock. No route ever read or wrote this table.',
    async up(db) {
      try {
        await db.exec('DROP TABLE IF EXISTS stock_reservations');
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 013:', err?.message);
      }
    },
  },
  {
    id: '014-no-activity-days',
    version: '2.11.0',
    description: 'Add no_activity_days table so the Owner can confirm a date genuinely had zero business activity, distinct from data simply not having been entered yet — closes the daily-entry-discipline gap without fabricating placeholder rows.',
    async up(db) {
      try {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS no_activity_days (
            entry_date TEXT PRIMARY KEY,
            confirmed_by INTEGER NOT NULL REFERENCES users(id),
            confirmed_by_name TEXT,
            notes TEXT DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
      } catch (err) {
        if (!isBenignSchemaError(err)) throw err;
        console.warn('Migration 014:', err?.message);
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
    if (!isBenignSchemaError(err)) throw err;
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
    // Do NOT return [] here — that would make runMigrations() believe no
    // migration has ever been applied and re-run every migration from 001
    // against a database that's already been migrated. Some migrations
    // (e.g. 004) are destructive, non-idempotent table rewrites; replaying
    // them blind is far worse than simply failing to boot with a clear error.
    throw err;
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

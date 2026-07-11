// db/sqlite-schema.js — IMARA LINKS (SQLite3 Local)
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const os = require('os');
const { runMigrations } = require('./migrations');

// Database file path — stored in user's home directory
const dbPath = path.join(os.homedir(), '.imara', 'imara.db');

// Create .imara directory if it doesn't exist
const fs = require('fs');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let _db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    _db = new sqlite3.Database(dbPath, (err) => {
      if (err) reject(err);
      else {
        // WAL mode: allows concurrent reads during writes; doesn't block readers.
        // SYNCHRONOUS=FULL: every committed transaction is flushed to disk before
        //   returning — guarantees D (Durability) of ACID even on power loss.
        // FOREIGN_KEYS=ON: enforces referential integrity — guarantees C (Consistency).
        // TEMP_STORE=MEMORY: temp tables in memory for speed (no durability concern).
        // CACHE_SIZE: 64MB page cache reduces disk I/O for large aggregations.
        // BUSY_TIMEOUT: without this, two writes landing at the same instant throw
        //   SQLITE_BUSY immediately instead of one waiting briefly for the other —
        //   this is what turns a harmless near-simultaneous write into a raw
        //   "Internal server error" on the client. 5s is comfortably above any
        //   single write in this app.
        _db.serialize(() => {
          _db.run('PRAGMA journal_mode = WAL');
          _db.run('PRAGMA synchronous = FULL');
          _db.run('PRAGMA foreign_keys = ON');
          _db.run('PRAGMA temp_store = MEMORY');
          _db.run('PRAGMA busy_timeout = 5000');
          _db.run('PRAGMA cache_size = -65536', (err) => {
            if (err) reject(err);
            else resolve(_db);
          });
        });
      }
    });
  });
}


// ── SQL dialect translator — strips PostgreSQL-only syntax for SQLite ─────────
function toSQLite(sql) {
  return sql
    // Remove ::numeric, ::text, ::integer casts
    .replace(/::numeric/g, '')
    .replace(/::text/g, '')
    .replace(/::integer/g, '')
    .replace(/::bigint/g, '')
    // INTERVAL must be handled BEFORE NOW() replacement so the pattern can match
    // NOW() - INTERVAL 'N minutes/hours/days' → datetime('now', '-N minutes')
    .replace(/NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s*minutes'/gi, (_, m) => `datetime('now', '-${m} minutes')`)
    .replace(/NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s*hours'/gi,   (_, m) => `datetime('now', '-${m} hours')`)
    .replace(/NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s*days'/gi,    (_, m) => `datetime('now', '-${m} days')`)
    // NOW() → datetime('now')  (any remaining NOW() after INTERVAL patterns above)
    .replace(/\bNOW\(\)/g, "datetime('now')")
    // FULL OUTER JOIN → LEFT JOIN (SQLite doesn't support FULL OUTER JOIN;
    // the only usage here is for gauge stock aggregation where LEFT JOIN is equivalent
    // because the base table (purchases) always contains the gauges we care about)
    .replace(/FULL OUTER JOIN/gi, 'LEFT JOIN')
    // RETURNING id — SQLite 3.35+ supports RETURNING, but older builds don't.
    // Strip it and rely on lastInsertRowid instead.
    .replace(/\s+RETURNING\s+id\b/gi, '')
    // LEFT(col, n) → substr(col, 1, n)  — SQLite has no LEFT() function
    .replace(/\bLEFT\s*\(\s*([^,]+?)\s*,\s*(\d+)\s*\)/g, 'substr($1, 1, $2)')
    // LEAST(a, b) → MIN(a, b)  — SQLite has no LEAST() function
    .replace(/\bLEAST\s*\(/gi, 'MIN(')
    // GREATEST(a, b) → MAX(a, b)  — SQLite has no GREATEST() function
    .replace(/\bGREATEST\s*\(/gi, 'MAX(')
    // STRING_AGG(expr, sep) → GROUP_CONCAT(expr, sep)  — SQLite uses GROUP_CONCAT
    .replace(/\bSTRING_AGG\s*\(/gi, 'GROUP_CONCAT(')
    // ILIKE → LIKE  — SQLite LIKE is already case-insensitive for ASCII characters
    .replace(/\bILIKE\b/gi, 'LIKE')
    // NULLIF is supported in SQLite — no change needed
    ;
}

function getDb() {
  if (!_db) throw new Error('DB not initialised — await initDb() first');

  return {
    async exec(sql) {
      return new Promise((resolve, reject) => {
        _db.run(toSQLite(sql), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    prepare(sql) {
      return {
        async get(...params) {
          return new Promise((resolve, reject) => {
            _db.get(toSQLite(sql), params.flat(), (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
          });
        },

        async all(...params) {
          return new Promise((resolve, reject) => {
            _db.all(toSQLite(sql), params.flat(), (err, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            });
          });
        },

        async run(...params) {
          return new Promise((resolve, reject) => {
            _db.run(toSQLite(sql), params.flat(), function(err) {
              if (err) reject(err);
              else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
            });
          });
        },
      };
    },

    // True ACID transaction — BEGIN / COMMIT / ROLLBACK
    //
    // WHY THE REWRITE: the old implementation used _db.serialize(async () => { … }).
    // sqlite3's serialize() only serialises *synchronous* _db.run() callbacks; once fn()
    // hits its first `await`, the serialize queue releases and other in-flight requests
    // can inject queries between BEGIN and COMMIT, breaking atomicity entirely.
    //
    // THE FIX: we serialise at the JavaScript level using a per-database Promise chain
    // (_txQueue). Every transaction call appends to the tail of the chain so that:
    //   • only one transaction runs at a time
    //   • BEGIN, every statement inside fn(), and COMMIT/ROLLBACK all execute
    //     sequentially without any other request's statements interleaving
    //   • the queue advances regardless of success or failure (always resolves)
    async transaction(fn) {
      // Advance the tail; if a previous transaction is still running we wait for it.
      const run = () => new Promise((resolve, reject) => {
        const exec = (sql, cb) => _db.run(sql, cb);
        exec('BEGIN TRANSACTION', (err) => {
          if (err) return reject(err);
          fn().then(
            (result) => exec('COMMIT', (e) => (e ? reject(e) : resolve(result))),
            (e)      => exec('ROLLBACK', () => reject(e)),
          );
        });
      });

      // Chain onto the tail so this transaction waits for any in-progress one.
      _db._txQueue = (_db._txQueue || Promise.resolve()).then(
        () => run(),
        () => run(),  // previous tx failed — still run this one
      );
      return _db._txQueue;
    },

    close() {
      return new Promise((resolve, reject) => {
        if (_db) {
          _db.close((err) => {
            if (err) reject(err);
            else {
              _db = null;
              resolve();
            }
          });
        } else resolve();
      });
    },
  };
}

// ── Tables (SQLite compatible) ────────────────────────────────────────────────
const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','knuckler','operator')),
    full_name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    password_changed_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS security_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    q1 TEXT NOT NULL,
    a1_hash TEXT NOT NULL,
    q2 TEXT NOT NULL,
    a2_hash TEXT NOT NULL,
    q3 TEXT NOT NULL,
    a3_hash TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS piece_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    length_m REAL NOT NULL CHECK(length_m > 0),
    weight_kg REAL NOT NULL CHECK(weight_kg > 0),
    default_price REAL NOT NULL DEFAULT 0 CHECK(default_price >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    kgs_bought REAL NOT NULL CHECK(kgs_bought >= 0),
    cost_per_kg REAL NOT NULL CHECK(cost_per_kg >= 0),
    transport_cost REAL NOT NULL DEFAULT 0 CHECK(transport_cost >= 0),
    gauge TEXT DEFAULT '',
    batch_name TEXT NOT NULL DEFAULT '',
    kgs_remaining REAL,
    entered_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS production (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL,
    kgs_used REAL NOT NULL CHECK(kgs_used >= 0),
    gauge TEXT DEFAULT '',
    purchase_id INTEGER REFERENCES purchases(id),
    operator_id INTEGER REFERENCES users(id),
    knuckler_id INTEGER REFERENCES users(id),
    operator_cost REAL NOT NULL DEFAULT 0,
    knuckler_cost REAL NOT NULL DEFAULT 0,
    sack_cost REAL NOT NULL DEFAULT 0,
    rent_allocation REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    entered_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS production_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id INTEGER NOT NULL REFERENCES production(id) ON DELETE CASCADE,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    pieces_produced INTEGER NOT NULL CHECK(pieces_produced >= 0)
  )`,

  // Per-batch FIFO draw record for a production entry. A single production
  // row can draw from more than one wire batch (when the preferred/oldest
  // batch alone doesn't cover kgs_used) — this table is the source of truth
  // for exactly which batches were touched and how much, so deletes can
  // reverse kgs_remaining correctly on EVERY batch involved, not just one.
  `CREATE TABLE IF NOT EXISTS production_batch_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id INTEGER NOT NULL REFERENCES production(id) ON DELETE CASCADE,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id),
    kgs_drawn REAL NOT NULL CHECK(kgs_drawn > 0),
    landed_cost_per_kg REAL NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    quantity INTEGER NOT NULL CHECK(quantity >= 0),
    selling_price REAL NOT NULL CHECK(selling_price >= 0),
    default_price REAL NOT NULL DEFAULT 0,
    price_overridden INTEGER NOT NULL DEFAULT 0,
    transport_to_market REAL NOT NULL DEFAULT 0,
    buyer_name TEXT DEFAULT '',
    gauge_source TEXT DEFAULT '',
    entered_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    invoice_date TEXT NOT NULL,
    due_date TEXT DEFAULT '',
    customer_name TEXT NOT NULL,
    customer_phone TEXT DEFAULT '',
    customer_email TEXT DEFAULT '',
    customer_address TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'partial_payment' CHECK(status IN ('partial_payment','paid','cancelled')),
    subtotal REAL NOT NULL DEFAULT 0,
    discount_pct REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    tax_pct REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    amount_paid REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    sale_id INTEGER,
    reversal_source TEXT DEFAULT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    piece_type_id INTEGER REFERENCES piece_types(id),
    description TEXT NOT NULL,
    gauge TEXT DEFAULT '',
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price REAL NOT NULL CHECK(unit_price >= 0),
    line_total REAL NOT NULL CHECK(line_total >= 0)
  )`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    table_name TEXT,
    record_id INTEGER,
    old_values TEXT,
    new_values TEXT,
    ip_address TEXT,
    logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    role_target TEXT,
    type TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_date TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('wages_operator','wages_knuckler','rent','supplier','sack','transport_to_market','other')),
    payee_user_id INTEGER REFERENCES users(id),
    payee_supplier_id INTEGER REFERENCES suppliers(id),
    payee_name TEXT,
    rent_month TEXT DEFAULT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    notes TEXT DEFAULT '',
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS rent_months (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    amount_due REAL NOT NULL DEFAULT 0,
    paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)),
    payment_id INTEGER REFERENCES payments(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS invoice_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_date TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    payment_method TEXT NOT NULL DEFAULT 'cash',
    notes TEXT DEFAULT '',
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Customer orders — a request placed before it becomes a real sale. Pending
  // orders do NOT reserve stock (checked by user decision); availability is
  // checked at the moment an order is converted to a sale, same as any normal
  // Owner-only confirmation that a given date genuinely had no business
  // activity (holiday, closure, no deliveries) — distinct from silence.
  // Lets the daily-entry discipline check (yesterdayMissing) tell "confirmed
  // nothing happened" apart from "forgot to log it", without ever requiring
  // a fabricated placeholder purchase/production/sale row.
  `CREATE TABLE IF NOT EXISTS no_activity_days (
    entry_date TEXT PRIMARY KEY,
    confirmed_by INTEGER NOT NULL REFERENCES users(id),
    confirmed_by_name TEXT,
    notes TEXT DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // sale entry. Converting an order calls the exact same sale-creation logic
  // used by /daily/sales/batch, so a converted order's sales are indistinguishable
  // from a normal sale everywhere downstream (reconciliation, reports, invoices).
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_date TEXT NOT NULL,
    buyer_name TEXT NOT NULL DEFAULT 'Walk-in Customer',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'converted', 'cancelled')),
    notes TEXT DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    converted_at DATETIME,
    invoice_id INTEGER REFERENCES invoices(id)
  )`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    selling_price REAL,
    gauge_source TEXT DEFAULT '',
    transport_to_market REAL,
    sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL
  )`,
];

// ── Indexes ──────────────────────────────────────────────────────────────────
const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_purchases_date    ON purchases(entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_gauge   ON purchases(gauge)`,
  `CREATE INDEX IF NOT EXISTS idx_production_date   ON production(entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_production_gauge  ON production(gauge)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_date        ON sales(entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_gauge       ON sales(gauge_source)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_name)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_log(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(payment_date)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_category ON payments(category)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_payments_date    ON invoice_payments(payment_date)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_sale_id         ON invoices(sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order_id  ON order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, read)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_role    ON notifications(role_target, read)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_piece_type         ON sales(piece_type_id)`,
  `CREATE INDEX IF NOT EXISTS idx_production_items_prod_id ON production_items(production_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pbu_production           ON production_batch_usage(production_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pbu_purchase             ON production_batch_usage(purchase_id)`,
];

// ── initDb ────────────────────────────────────────────────────────────────────
async function initDb() {
  await openDb();
  const db = getDb();

  console.log('▶  Creating tables…');
  for (const stmt of TABLE_STATEMENTS) {
    await db.exec(stmt);
  }

  console.log('▶  Running migrations…');
  await runMigrations(db);

  console.log('▶  Creating indexes…');
  for (const stmt of INDEX_STATEMENTS) {
    await db.exec(stmt);
  }

  // Seed default config values
  const configKeys = [
    ['cost_per_kg',       '0'],
    ['transport_cost',    '0'],
    ['operator_cost',     '0'],
    ['knuckler_cost',     '0'],
    ['sack_cost',         '0'],
    ['rent_allocation',   '0'],
    ['stock_threshold',   '100'],
    ['show_rent_dashboard', '0'],
    ['business_name',     ''],
    ['business_slogan',   ''],
    ['currency',          'KES'],
    ['wire_gauges',       '12,14,16'],
    ['transport_to_market','0'],
    ['invoice_prefix',    'INV'],
    ['invoice_tax_pct',   '0'],
    // Backup resilience — added v2.4
    ['backup_second_path', ''],   // owner-set second save location (USB / network share)
    ['last_backup_at',     ''],   // ISO timestamp of last successful export
  ];

  for (const [k, v] of configKeys) {
    const stmt = await db.prepare('SELECT COUNT(*) as c FROM config WHERE key=?');
    const res = await stmt.all(k);
    if (!res[0]?.c) {
      await db.prepare('INSERT INTO config(key,value) VALUES(?,?)').run(k, v);
    }
  }

  // Seed default supplier
  const suppliers = await db.prepare('SELECT COUNT(*) as c FROM suppliers').all();
  if (!suppliers[0]?.c) {
    await db.prepare("INSERT INTO suppliers(name) VALUES(?)").run('Default Supplier');
  }

  // Seed default owner account
  const owners = await db.prepare("SELECT COUNT(*) as c FROM users WHERE role='owner'").all();
  if (!owners[0]?.c) {
    await db.prepare(
      'INSERT INTO users(username,password,role,full_name) VALUES(?,?,?,?)'
    ).run('owner', bcrypt.hashSync('owner1234', 12), 'owner', 'Business Owner');
    console.log('\n✅  Default owner created  →  username: owner  /  password: owner1234');
    console.log('⚠️   CHANGE THIS PASSWORD ON FIRST LOGIN\n');
  }

  console.log(`✅  IMARA LINKS DB ready (SQLite3 Local) — Database: ${dbPath}`);

  // ── Startup integrity check — payment drift ──────────────────────────────────
  // If invoices.amount_paid differs from Σ(invoice_payments) by more than half a
  // shilling, log a warning so the owner can investigate.  This is diagnostic
  // only — the live cash-payment route now derives amount_paid from the ledger
  // sum inside the transaction, so drift should not accumulate going forward.
  try {
    const drifted = await db.prepare(`
      SELECT i.invoice_number, i.customer_name,
             ROUND(i.amount_paid - COALESCE(SUM(ip.amount),0), 2) AS drift
      FROM invoices i
      LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
      GROUP BY i.id
      HAVING ABS(ROUND(i.amount_paid - COALESCE(SUM(ip.amount),0), 2)) > 0.005
    `).all();
    if (drifted && drifted.length) {
      console.warn(`⚠️   Payment integrity: ${drifted.length} invoice(s) have amount_paid drift > 0.005 — run migration 008 to heal.`);
      for (const d of drifted) {
        console.warn(`    ${d.invoice_number}  ${d.customer_name}  drift=${d.drift}`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Startup backup health check ──────────────────────────────────────────────
  // Write a notification if no backup has been exported in 48+ hours.
  // Never blocks startup. The notification shows on the owner's dashboard bell.
  try {
    const lastBkRow  = await db.prepare(`SELECT value FROM config WHERE key='last_backup_at'`).get();
    const lastBk     = lastBkRow?.value || null;
    const hoursSince = lastBk ? (Date.now() - new Date(lastBk).getTime()) / 36e5 : Infinity;
    if (hoursSince > 48) {
      const existing = await db.prepare(
        `SELECT id FROM notifications WHERE type='BACKUP_OVERDUE' AND read=0 LIMIT 1`
      ).get();
      if (!existing) {
        const daysOver = lastBk ? Math.floor(hoursSince / 24) : null;
        const msg = daysOver
          ? `⚠️ No backup exported in ${daysOver} day(s). Go to Backup page and export one now.`
          : `⚠️ No backup has ever been exported from this system. Go to the Backup page now.`;
        const ownerRow = await db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
        if (ownerRow) {
          await db.prepare(
            `INSERT INTO notifications(user_id, type, message, created_at)
             VALUES(?, 'BACKUP_OVERDUE', ?, datetime('now'))`
          ).run(ownerRow.id, msg);
          console.warn(`⚠️  ${msg}`);
        }
      }
    }
  } catch(_) { /* non-fatal — never block startup */ }

  try {
    const tokenCleanup = await db.prepare(
      "DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')"
    ).run();
    if (tokenCleanup.changes > 0)
      console.log(`🧹  Cleaned ${tokenCleanup.changes} expired reset token(s)`);
  } catch(e) { console.warn('Token cleanup skipped:', e.message); }

  // 2. Trim audit_log: keep last 180 days, delete older rows
  // The audit viewer already caps at 5000 rows so older rows are never shown anyway
  try {
    const auditCleanup = await db.prepare(
      "DELETE FROM audit_log WHERE logged_at < datetime('now', '-180 days')"
    ).run();
    if (auditCleanup.changes > 0)
      console.log(`🧹  Trimmed ${auditCleanup.changes} old audit log row(s) (>180 days)`);
  } catch(e) { console.warn('Audit trim skipped:', e.message); }

  // 3. Delete read notifications older than 30 days (unread ones are always kept)
  try {
    const notifCleanup = await db.prepare(
      "DELETE FROM notifications WHERE read=1 AND created_at < datetime('now', '-30 days')"
    ).run();
    if (notifCleanup.changes > 0)
      console.log(`🧹  Cleaned ${notifCleanup.changes} old read notification(s)`);
  } catch(e) { console.warn('Notification cleanup skipped:', e.message); }
}

module.exports = { getDb, initDb, openDb, dbPath, enqueue: () => {}, importDb: () => false };

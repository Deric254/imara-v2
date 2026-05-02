// db/schema.js — IMARA LINKS (Neon PostgreSQL) - v3 ACID
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

let _db = null;

async function openDb() {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
  _db = neon(process.env.DATABASE_URL);
  return _db;
}

function getDb() {
  if (!_db) throw new Error('DB not initialised — await initDb() first');

  const toPostgres = (sql) => {
    let s = sql.replace(/datetime\('now'\)/g, 'NOW()');
    if (s.includes('?')) {
      let i = 1;
      s = s.replace(/\?/g, () => `$${i++}`);
    }
    return s;
  };

  return {
    async exec(sql) {
      await _db(toPostgres(sql));
    },
    prepare(sql) {
      return {
        async get(...p)  { const r = await _db(toPostgres(sql), p.flat()); return r[0] || undefined; },
        async all(...p)  { const r = await _db(toPostgres(sql), p.flat()); return r || []; },
        async run(...p)  {
          const r = await _db(toPostgres(sql), p.flat());
          return { lastInsertRowid: r[0]?.id || null, changes: r.length || 0 };
        },
      };
    },
    // True ACID transaction — BEGIN / COMMIT / ROLLBACK
    async transaction(fn) {
      await _db('BEGIN');
      try {
        const result = await fn();
        await _db('COMMIT');
        return result;
      } catch (e) {
        try { await _db('ROLLBACK'); } catch (_) {}
        throw e;
      }
    },
    close() {},
  };
}

// ── Tables only (NO indexes here — indexes come after migrations) ─────────────
const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','knuckler','operator')),
    full_name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT NOW(),
    updated_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS security_questions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    q1 TEXT NOT NULL,
    a1_hash TEXT NOT NULL,
    q2 TEXT NOT NULL,
    a2_hash TEXT NOT NULL,
    q3 TEXT NOT NULL,
    a3_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT NOW(),
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS piece_types (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    length_m REAL NOT NULL CHECK(length_m > 0),
    weight_kg REAL NOT NULL CHECK(weight_kg > 0),
    default_price REAL NOT NULL DEFAULT 0 CHECK(default_price >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id SERIAL PRIMARY KEY,
    entry_date TEXT NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    kgs_bought REAL NOT NULL CHECK(kgs_bought >= 0),
    cost_per_kg REAL NOT NULL CHECK(cost_per_kg >= 0),
    transport_cost REAL NOT NULL DEFAULT 0 CHECK(transport_cost >= 0),
    gauge TEXT DEFAULT '',
    entered_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS production (
    id SERIAL PRIMARY KEY,
    entry_date TEXT NOT NULL,
    kgs_used REAL NOT NULL CHECK(kgs_used >= 0),
    gauge TEXT DEFAULT '',
    operator_id INTEGER REFERENCES users(id),
    knuckler_id INTEGER REFERENCES users(id),
    operator_cost REAL NOT NULL DEFAULT 0,
    knuckler_cost REAL NOT NULL DEFAULT 0,
    sack_cost REAL NOT NULL DEFAULT 0,
    rent_allocation REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    entered_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS production_items (
    id SERIAL PRIMARY KEY,
    production_id INTEGER NOT NULL REFERENCES production(id) ON DELETE CASCADE,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    pieces_produced INTEGER NOT NULL CHECK(pieces_produced >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
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
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
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
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT NOW(),
    updated_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    piece_type_id INTEGER REFERENCES piece_types(id),
    description TEXT NOT NULL,
    gauge TEXT DEFAULT '',
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price REAL NOT NULL CHECK(unit_price >= 0),
    line_total REAL NOT NULL CHECK(line_total >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    table_name TEXT,
    record_id INTEGER,
    old_values TEXT,
    new_values TEXT,
    ip_address TEXT,
    logged_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    role_target TEXT,
    type TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    payment_date TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('wages_operator','wages_knuckler','rent','supplier','sack','other')),
    payee_user_id INTEGER REFERENCES users(id),
    payee_supplier_id INTEGER REFERENCES suppliers(id),
    payee_name TEXT,
    rent_month TEXT DEFAULT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    notes TEXT DEFAULT '',
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rent_months (
    id SERIAL PRIMARY KEY,
    month TEXT NOT NULL UNIQUE,
    amount_due REAL NOT NULL DEFAULT 0,
    paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)),
    payment_id INTEGER REFERENCES payments(id),
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  // Cash-basis revenue ledger: each payment received against an invoice
  `CREATE TABLE IF NOT EXISTS invoice_payments (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_date TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    payment_method TEXT NOT NULL DEFAULT 'cash',
    notes TEXT DEFAULT '',
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS stock_reservations (
    id SERIAL PRIMARY KEY,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    reservation_type TEXT NOT NULL CHECK(reservation_type IN ('invoice', 'order')),
    reservation_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT NOW(),
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'fulfilled', 'expired', 'cancelled')),
    created_by INTEGER NOT NULL REFERENCES users(id)
  )`,
];

// ── Indexes — run AFTER migrations so columns are guaranteed to exist ─────────
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
  `CREATE INDEX IF NOT EXISTS idx_stock_reservations_piece  ON stock_reservations(piece_type_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_reservations_status ON stock_reservations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_piece_type         ON sales(piece_type_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_gauge_source       ON sales(gauge_source)`,
  `CREATE INDEX IF NOT EXISTS idx_production_items_prod_id ON production_items(production_id)`,
];

// ── Migrations — ADD COLUMN IF NOT EXISTS (idempotent, safe on existing DB) ──
async function runMigrations() {
  const cols = [
    { table: 'users',      col: 'phone',               def: "TEXT DEFAULT ''" },
    { table: 'users',      col: 'email',               def: "TEXT DEFAULT ''" },
    { table: 'payments',   col: 'payee_name',          def: 'TEXT' },
    // gauge columns — must exist BEFORE indexes are created below
    { table: 'purchases',  col: 'gauge',               def: "TEXT DEFAULT ''" },
    { table: 'production', col: 'gauge',               def: "TEXT DEFAULT ''" },
    { table: 'production', col: 'total_cost',          def: 'REAL DEFAULT 0' },
    { table: 'sales',      col: 'transport_to_market', def: 'REAL DEFAULT 0' },
    { table: 'sales',      col: 'buyer_name',          def: "TEXT DEFAULT ''" },
    { table: 'sales',      col: 'gauge_source',        def: "TEXT DEFAULT ''" },
    // sale_id links an auto-generated invoice back to the originating sale
    { table: 'invoices',       col: 'sale_id',   def: 'INTEGER' },
    // notifications: title + category — title shown in bell, category drives routing
    { table: 'notifications',  col: 'title',     def: "TEXT NOT NULL DEFAULT ''" },
    { table: 'notifications',  col: 'category',  def: "TEXT NOT NULL DEFAULT ''" },
    // auth: tracks when password was last changed so old JWTs are invalidated immediately
    { table: 'users',          col: 'password_changed_at', def: 'TIMESTAMPTZ' },
  ];

  // ── length_ft → length_m column rename (idempotent) ─────────────────────────
  // If the old column still exists, copy it to the new name then drop it.
  // If length_m already exists this is a no-op (IF NOT EXISTS guards it).
  try {
    const hasFt = await _db(
      "SELECT column_name FROM information_schema.columns WHERE table_name='piece_types' AND column_name='length_ft'",
      []
    );
    if (hasFt && hasFt.length) {
      await _db('ALTER TABLE piece_types ADD COLUMN IF NOT EXISTS length_m REAL NOT NULL DEFAULT 0', []);
      await _db('UPDATE piece_types SET length_m = length_ft WHERE length_m = 0 AND length_ft > 0', []);
      await _db('ALTER TABLE piece_types DROP COLUMN IF EXISTS length_ft', []);
      console.log('✅  piece_types.length_ft renamed to length_m');
    }
  } catch (e) {
    console.warn('⚠️   length_ft→length_m migration:', e.message);
  }

  for (const { table, col, def } of cols) {
    try {
      await _db(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`,
        []
      );
      console.log(`✅  ${table}.${col} OK`);
    } catch (e) {
      // IF NOT EXISTS means this is safe — log but never crash
      console.warn(`⚠️   ${table}.${col}: ${e.message}`);
    }
  }

  // Role rename (idempotent)
  try {
    await _db("UPDATE users SET role='knuckler' WHERE role='worker'", []);
  } catch (_) {}

  // Invoice status migration: 'draft' is no longer a valid status (CHECK constraint only allows
  // partial_payment, paid, cancelled). Migrate any legacy draft invoices to partial_payment.
  try {
    await _db("UPDATE invoices SET status='partial_payment' WHERE status='draft'", []);
  } catch (_) {}

  // Drop legacy constraints that break normal operation:
  // - check_due_date_after_invoice: blocks inserts where due_date is empty (optional field)
  // - check_tax_rate_valid: references tax_rate column which does not exist (column is tax_pct)
  for (const constraint of ['check_due_date_after_invoice', 'check_tax_rate_valid']) {
    try {
      await _db(`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS ${constraint}`, []);
      console.log(`✅  Dropped constraint ${constraint}`);
    } catch (e) {
      console.warn(`⚠️   Drop constraint ${constraint}: ${e.message}`);
    }
  }
}

// ── initDb — ORDER MATTERS: tables → migrations → indexes ────────────────────
async function initDb() {
  await openDb();
  const db = getDb();

  console.log('▶  Creating tables…');
  for (const stmt of TABLE_STATEMENTS) {
    await db.exec(stmt);
  }

  console.log('▶  Running column migrations…');
  await runMigrations();   // gauge columns added HERE — before indexes

  console.log('▶  Creating indexes…');
  for (const stmt of INDEX_STATEMENTS) {
    await db.exec(stmt);   // gauge index runs AFTER column exists ✓
  }

  // Seed default config values (ON CONFLICT DO NOTHING = safe to re-run)
  for (const [k, v] of [
    ['cost_per_kg',       '0'],
    ['transport_cost',    '0'],
    ['operator_cost',     '0'],
    ['knuckler_cost',     '0'],
    ['sack_cost',         '0'],
    ['rent_allocation',   '0'],
    ['stock_threshold',   '100'],
    ['business_name',     ''],
    ['business_slogan',   ''],
    ['currency',          'KES'],
    ['wire_gauges',       '12,14,16'],
    ['transport_to_market','0'],
    ['invoice_prefix',    'INV'],
    ['invoice_tax_pct',   '0'],
  ]) {
    await _db(
      'INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING',
      [k, v]
    );
  }

  // Clear legacy seeded branding that was never set by a real user
  await _db(
    "UPDATE config SET value='' WHERE key='business_name' AND updated_by IS NULL AND value='IMARA LINKS'",
    []
  );
  await _db(
    "UPDATE config SET value='' WHERE key='business_slogan' AND updated_by IS NULL AND value IN ('Biult strong by imara.','Slogan Pending')",
    []
  );
  await _db(
    "UPDATE config SET value='KES' WHERE key='currency' AND (value IS NULL OR value='')",
    []
  );

  // Seed default supplier
  const sc = await _db('SELECT COUNT(*) AS c FROM suppliers', []);
  if (!sc?.[0]?.c) {
    await _db("INSERT INTO suppliers(name) VALUES($1)", ['Default Supplier']);
  }

  // Seed default owner account
  const oc = await _db("SELECT COUNT(*) AS c FROM users WHERE role='owner'", []);
  if (!oc?.[0]?.c || parseInt(oc[0].c) === 0) {
    await _db(
      'INSERT INTO users(username,password,role,full_name) VALUES($1,$2,$3,$4)',
      ['owner', bcrypt.hashSync('owner1234', 12), 'owner', 'Business Owner']
    );
    console.log('\n✅  Default owner created  →  username: owner  /  password: owner1234');
    console.log('⚠️   CHANGE THIS PASSWORD ON FIRST LOGIN\n');
  }

  console.log('✅  IMARA LINKS DB ready (Neon PostgreSQL) — ACID enabled');
}

module.exports = { getDb, initDb, enqueue: () => {}, importDb: () => false };

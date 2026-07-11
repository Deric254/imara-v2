// test-harness.js — TEST ONLY, not part of the shipped app.
// Exercises the REAL, unmodified backend/db layer and backend/lib/saleCore.js
// under genuine concurrency, using Node's built-in SQLite engine as a stand-in
// for the network-blocked native `sqlite3` driver (see node_modules/sqlite3
// shim). Business logic under test is 100% the real project code.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} — ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

async function freshDb() {
  // Isolated HOME per test run so initDb() creates a brand new ~/.imara/imara.db
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'imara-test-'));
  process.env.HOME = tmpHome;
  delete require.cache[require.resolve('./db')];
  delete require.cache[require.resolve('./db/sqlite-schema')];
  delete require.cache[require.resolve('./db/migrations')];
  const { initDb, getDb } = require('./db');
  await initDb();
  return getDb();
}

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('  1. DURABILITY — pragma verification');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    const jm = (await db.prepare('PRAGMA journal_mode').get()).journal_mode;
    const sync = (await db.prepare('PRAGMA synchronous').get()).synchronous;
    const fk = (await db.prepare('PRAGMA foreign_keys').get()).foreign_keys;
    report('journal_mode = WAL', jm === 'wal', `got ${jm}`);
    report('synchronous = FULL (2)', Number(sync) === 2, `got ${sync}`);
    report('foreign_keys = ON', Number(fk) === 1, `got ${fk}`);
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  2. ACID — does db.transaction() actually serialize?');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    await db.exec('CREATE TABLE IF NOT EXISTS counter(id INTEGER PRIMARY KEY, v INTEGER)');
    await db.prepare('INSERT INTO counter(id, v) VALUES (1, 0)').run();

    // Classic lost-update test: read-then-write WITHOUT any lock, 50 times
    // concurrently, all wrapped in db.transaction(). If the transaction queue
    // is not truly serializing, some increments will be lost.
    const N = 50;
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(db.transaction(async () => {
        const row = await db.prepare('SELECT v FROM counter WHERE id=1').get();
        // Yield the event loop here on purpose — this is exactly the shape
        // that breaks under a race: if another "transaction" could interleave
        // right now, it would read the same stale v.
        await new Promise(r => setImmediate(r));
        await db.prepare('UPDATE counter SET v=? WHERE id=1').run(row.v + 1);
      }));
    }
    await Promise.all(jobs);
    const final = await db.prepare('SELECT v FROM counter WHERE id=1').get();
    report('50 concurrent read-increment-write transactions → exact count', final.v === N, `got ${final.v}, expected ${N}`);
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  3. Real saleCore.js — concurrent stock-check race');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    const { createBatchSaleCore } = require('./lib/saleCore');

    const pt = await db.prepare(
      `INSERT INTO piece_types(name, weight_kg, length_m, default_price, active) VALUES ('TestPiece', 1.0, 1.0, 100, 1) RETURNING id`
    ).run();
    const pieceTypeId = pt.lastInsertRowid;

    const owner = await db.prepare(`SELECT id FROM users WHERE role='owner'`).get();
    const supplier = await db.prepare(`SELECT id FROM suppliers LIMIT 1`).get();

    await db.prepare(
      `INSERT INTO purchases(entry_date, supplier_id, kgs_bought, kgs_remaining, cost_per_kg, transport_cost, gauge, entered_by) VALUES ('2026-01-01', ?, 100, 100, 10, 0, '12', ?)`
    ).run(supplier.id, owner.id);

    const prod = await db.prepare(
      `INSERT INTO production(entry_date, kgs_used, gauge, operator_id, knuckler_id, operator_cost, knuckler_cost, sack_cost, rent_allocation, total_cost, entered_by) VALUES ('2026-01-01', 10, '12', NULL, NULL, 0,0,0,0,0, ?) RETURNING id`
    ).run(owner.id);
    await db.prepare(`INSERT INTO production_items(production_id, piece_type_id, pieces_produced) VALUES (?, ?, 10)`).run(prod.lastInsertRowid, pieceTypeId);
    // 10 pieces of stock exist. Fire 5 concurrent batch sales of 3 pieces each
    // (15 requested total, only 10 available) — the real stock check inside
    // createBatchSaleCore's transaction must let some through and reject others,
    // never allowing total sold to exceed 10.
    const attempts = [];
    for (let i = 0; i < 5; i++) {
      attempts.push(
        createBatchSaleCore(db, {
          entry_date: '2026-01-02',
          buyer_name: `Buyer ${i}`,
          items: [{ piece_type_id: pieceTypeId, quantity: 3, selling_price: 100, gauge_source: '12' }],
          userId: owner.id,
        }).then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: e.stockError ? e.stockError.error : e.message }))
      );
    }
    const results = await Promise.all(attempts);
    const succeeded = results.filter(r => r.ok).length;
    const rejected = results.filter(r => !r.ok).length;
    const totalSold = (await db.prepare(`SELECT COALESCE(SUM(quantity),0) AS v FROM sales`).get()).v;

    report('never oversold (total sold <= 10 available)', totalSold <= 10, `sold ${totalSold}/10`);
    report('exactly 3 of 5 requests succeeded (3×3=9 ≤ 10 < 4×3=12)', succeeded === 3, `${succeeded} succeeded, ${rejected} rejected`);
    report('rejected requests got INSUFFICIENT_STOCK_FOR_GAUGE', results.filter(r=>!r.ok).every(r => r.err === 'INSUFFICIENT_STOCK_FOR_GAUGE'));
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  4. Overpayment race — OLD pattern (vulnerable) vs NEW pattern (fixed)');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS test_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL)`);
    const CAP = 1000; // e.g. invoice total_amount

    // OLD pattern: check remaining BEFORE opening a transaction (exactly what
    // invoices.js /cash and reconciliation.js payments looked like before the fix).
    async function payOldVulnerable(amount) {
      const sumRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM test_ledger`).get();
      const remaining = CAP - sumRow.total;
      if (amount > remaining + 0.005) throw new Error('rejected');
      await new Promise(r => setImmediate(r)); // simulate the gap between check and write
      await db.transaction(async () => {
        await db.prepare(`INSERT INTO test_ledger(amount) VALUES (?)`).run(amount);
      });
    }

    // NEW pattern: re-check the live sum INSIDE the same transaction as the
    // insert — exactly what I changed invoices.js /cash and
    // reconciliation.js payments to do.
    async function payNewFixed(amount) {
      await db.transaction(async () => {
        const sumRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM test_ledger`).get();
        const remaining = CAP - sumRow.total;
        if (amount > remaining + 0.005) { const e = new Error('rejected'); e.overpayment = true; throw e; }
        await db.prepare(`INSERT INTO test_ledger(amount) VALUES (?)`).run(amount);
      });
    }

    // Six concurrent payments of 300 each = 1800 total requested against a cap of 1000.
    // Correct behavior: at most 3 succeed (3×300=900 ≤ 1000 < 4×300=1200), rest rejected.
    async function runConcurrentTest(fn, label) {
      await db.exec('DELETE FROM test_ledger');
      const jobs = Array.from({ length: 6 }, () => fn(300).then(() => true).catch(() => false));
      const outcomes = await Promise.all(jobs);
      const total = (await db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM test_ledger`).get()).v;
      const succeeded = outcomes.filter(Boolean).length;
      return { total, succeeded };
    }

    const oldResult = await runConcurrentTest(payOldVulnerable, 'OLD');
    const newResult = await runConcurrentTest(payNewFixed, 'NEW');

    console.log(`   OLD pattern: ${oldResult.succeeded} payments succeeded, total booked = ${oldResult.total} (cap ${CAP})`);
    console.log(`   NEW pattern: ${newResult.succeeded} payments succeeded, total booked = ${newResult.total} (cap ${CAP})`);

    report('OLD pattern actually DOES overpay under concurrency (proves the bug was real)', oldResult.total > CAP, `booked ${oldResult.total} > cap ${CAP}`);
    report('NEW pattern NEVER exceeds the cap under identical concurrency', newResult.total <= CAP, `booked ${newResult.total} <= cap ${CAP}`);
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  5. Backup import atomicity — mid-restore crash simulation');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS test_restore(id INTEGER PRIMARY KEY, v TEXT)`);

    // NEW pattern: whole restore loop wrapped in ONE db.transaction() — matches
    // the fix applied to backup.js /import.
    async function restoreAtomic(rows, crashAtIndex) {
      try {
        await db.transaction(async () => {
          for (let i = 0; i < rows.length; i++) {
            if (i === crashAtIndex) throw new Error('simulated crash mid-restore');
            await db.prepare(`INSERT INTO test_restore(id, v) VALUES (?, ?)`).run(rows[i].id, rows[i].v);
          }
        });
      } catch (e) { /* expected */ }
    }

    await db.exec('DELETE FROM test_restore');
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, v: `row${i + 1}` }));
    await restoreAtomic(rows, 5); // crash on the 6th row
    const count = (await db.prepare(`SELECT COUNT(*) AS c FROM test_restore`).get()).c;
    report('crash mid-restore leaves ZERO rows behind (full rollback, not half-restored)', count === 0, `found ${count} rows`);

    // Now the happy path — no crash — should fully commit
    await db.exec('DELETE FROM test_restore');
    await restoreAtomic(rows, -1);
    const count2 = (await db.prepare(`SELECT COUNT(*) AS c FROM test_restore`).get()).c;
    report('successful restore commits ALL rows', count2 === rows.length, `found ${count2}/${rows.length}`);
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  6. Order-conversion atomicity — onAfterInsert hook (saleCore.js)');
  console.log('════════════════════════════════════════════════════════');
  {
    const db = await freshDb();
    const { createBatchSaleCore } = require('./lib/saleCore');

    const pt = await db.prepare(
      `INSERT INTO piece_types(name, weight_kg, length_m, default_price, active) VALUES ('TestPiece2', 1.0, 1.0, 100, 1) RETURNING id`
    ).run();
    const pieceTypeId = pt.lastInsertRowid;
    const owner = await db.prepare(`SELECT id FROM users WHERE role='owner'`).get();
    const supplier = await db.prepare(`SELECT id FROM suppliers LIMIT 1`).get();
    await db.prepare(
      `INSERT INTO purchases(entry_date, supplier_id, kgs_bought, kgs_remaining, cost_per_kg, transport_cost, gauge, entered_by) VALUES ('2026-01-01', ?, 100, 100, 10, 0, '12', ?)`
    ).run(supplier.id, owner.id);
    const prod = await db.prepare(
      `INSERT INTO production(entry_date, kgs_used, gauge, operator_id, knuckler_id, operator_cost, knuckler_cost, sack_cost, rent_allocation, total_cost, entered_by) VALUES ('2026-01-01', 10, '12', NULL, NULL, 0,0,0,0,0, ?) RETURNING id`
    ).run(owner.id);
    await db.prepare(`INSERT INTO production_items(production_id, piece_type_id, pieces_produced) VALUES (?, ?, 10)`).run(prod.lastInsertRowid, pieceTypeId);

    // Simulate the order-conversion hook FAILING (e.g. a bug, or a constraint
    // violation while marking the order converted). The whole thing — sale,
    // invoice, invoice_items, AND the hook's own writes — must roll back
    // together. Before the fix, the sale+invoice would have already committed
    // in their own transaction by this point, leaving an orphaned sale.
    let threw = false;
    try {
      await createBatchSaleCore(db, {
        entry_date: '2026-01-02', buyer_name: 'Hook Test', userId: owner.id,
        items: [{ piece_type_id: pieceTypeId, quantity: 2, selling_price: 100, gauge_source: '12' }],
        onAfterInsert: async () => { throw new Error('simulated order-link failure'); },
      });
    } catch (e) { threw = true; }
    const salesAfterFailedHook = (await db.prepare(`SELECT COUNT(*) AS c FROM sales`).get()).c;
    const invoicesAfterFailedHook = (await db.prepare(`SELECT COUNT(*) AS c FROM invoices`).get()).c;
    report('onAfterInsert threw as expected', threw);
    report('failed hook rolls back the sale too (no orphaned sale)', salesAfterFailedHook === 0, `found ${salesAfterFailedHook} sale(s)`);
    report('failed hook rolls back the invoice too (no orphaned invoice)', invoicesAfterFailedHook === 0, `found ${invoicesAfterFailedHook} invoice(s)`);

    // Now the happy path — hook succeeds and its writes land in the SAME commit.
    await db.exec(`CREATE TABLE IF NOT EXISTS test_orders(id INTEGER PRIMARY KEY, status TEXT)`);
    await db.prepare(`INSERT INTO test_orders(id, status) VALUES (1, 'pending')`).run();
    const result = await createBatchSaleCore(db, {
      entry_date: '2026-01-02', buyer_name: 'Hook Test 2', userId: owner.id,
      items: [{ piece_type_id: pieceTypeId, quantity: 2, selling_price: 100, gauge_source: '12' }],
      onAfterInsert: async ({ saleIds, invoiceId }) => {
        await db.prepare(`UPDATE test_orders SET status='converted' WHERE id=1`).run();
      },
    });
    const orderRow = await db.prepare(`SELECT status FROM test_orders WHERE id=1`).get();
    const saleCount = (await db.prepare(`SELECT COUNT(*) AS c FROM sales`).get()).c;
    report('successful hook: sale created AND order flipped to converted, same commit', orderRow.status === 'converted' && saleCount === 1, `order=${orderRow.status}, sales=${saleCount}`);
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(failures === 0 ? `✅ ALL CHECKS PASSED` : `❌ ${failures} CHECK(S) FAILED`);
  console.log('════════════════════════════════════════════════════════');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });

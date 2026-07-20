// test-sold-profit-fix.js — TEST ONLY, not part of the shipped app.
// Verifies Sold Gross/Net cost is PAYMENT-GATED (owner's explicit decision,
// 2026-07-17): a cost only counts once it has actually been paid — same
// rule revenue already follows. Matched to sold pieces via FIFO (never
// blended with unsold stock), but withheld until real cash has moved.

const path = require('path');
const os = require('os');
const fs = require('fs');

async function freshDb() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'imara-test-'));
  process.env.HOME = tmpHome;
  delete require.cache[require.resolve('./db')];
  delete require.cache[require.resolve('./db/sqlite-schema')];
  delete require.cache[require.resolve('./db/migrations')];
  const { initDb, getDb } = require('./db');
  await initDb();
  return getDb();
}

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} — ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

async function main() {
  const db = await freshDb();
  const { createBatchSaleCore } = require('./lib/saleCore');
  const { getPaymentGatedSoldCost } = require('./lib/paymentGatedCost');

  const owner = await db.prepare(`SELECT id FROM users LIMIT 1`).get();
  const userId = owner.id;

  let supplier = await db.prepare(`SELECT id FROM suppliers LIMIT 1`).get();
  let supplierId;
  if (supplier) {
    supplierId = supplier.id;
  } else {
    const supRes = await db.prepare(`INSERT INTO suppliers(name, active) VALUES ('Test Supplier',1) RETURNING id`).run();
    supplierId = supRes.lastInsertRowid;
  }
  await db.prepare(`INSERT INTO piece_types(id, name, length_m, weight_kg, default_price, active) VALUES (1,'4-inch Nail',0.1,0.01,10,1)`).run();
  await db.prepare(`UPDATE config SET value='2' WHERE key='transport_to_market'`).run();

  await db.prepare(`
    INSERT INTO purchases(id, entry_date, supplier_id, gauge, kgs_bought, cost_per_kg, transport_cost, kgs_remaining, entered_by)
    VALUES (1, '2026-05-30', ?, 'G1', 10, 110, 0, 10, ?)
  `).run(supplierId, userId);

  await db.prepare(`
    INSERT INTO production(id, entry_date, kgs_used, operator_cost, knuckler_cost, sack_cost, rent_allocation, total_cost, gauge, purchase_id, entered_by)
    VALUES (1, '2026-06-01', 10, 500, 300, 100, 0, 2000, 'G1', 1, ?)
  `).run(userId);
  await db.prepare(`INSERT INTO production_items(production_id, piece_type_id, pieces_produced) VALUES (1,1,1000)`).run();
  await db.prepare(`
    INSERT INTO production_batch_usage(production_id, purchase_id, kgs_drawn, landed_cost_per_kg)
    VALUES (1, 1, 10, 110)
  `).run();

  const result = await createBatchSaleCore(db, {
    entry_date: '2026-06-05',
    buyer_name: 'Test Buyer',
    items: [{ piece_type_id: 1, quantity: 100, selling_price: 15, gauge_source: 'G1' }],
    userId,
  });

  const sale = await db.prepare('SELECT * FROM sales WHERE id = ?').get(result.saleIds[0]);
  report('wire_cost_per_kg snapshot = 110', Math.abs(sale.wire_cost_per_kg - 110) < 0.001, `got ${sale.wire_cost_per_kg}`);
  report('conversion_cost_per_piece snapshot = 0.9', Math.abs(sale.conversion_cost_per_piece - 0.9) < 0.001, `got ${sale.conversion_cost_per_piece}`);
  report('transport_to_market snapshot = 200 (2/pc * 100)', Math.abs(sale.transport_to_market - 200) < 0.001, `got ${sale.transport_to_market}`);

  let gated = await getPaymentGatedSoldCost(db, '2026-06-01', '2026-06-30');
  report('BEFORE any payment: paid_wire_cost = 0', gated.paid_wire_cost === 0, `got ${gated.paid_wire_cost}`);
  report('BEFORE any payment: paid_conversion_cost = 0', gated.paid_conversion_cost === 0, `got ${gated.paid_conversion_cost}`);
  report('BEFORE any payment: paid_transport_cost = 0', gated.paid_transport_cost === 0, `got ${gated.paid_transport_cost}`);

  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-05','wages_operator', 5000, 'bulk wage payment, far more than owed', ?)
  `).run(userId);

  gated = await getPaymentGatedSoldCost(db, '2026-06-01', '2026-06-30');
  report('Paying wages_operator does not leak into paid_wire_cost', gated.paid_wire_cost === 0, `got ${gated.paid_wire_cost}`);
  report('Paying only wages_operator gates conversion cost to operator share only',
    Math.abs(gated.paid_conversion_cost - 50) < 0.01, `got ${gated.paid_conversion_cost}`);

  await db.prepare(`
    INSERT INTO payments(payment_date, category, payee_supplier_id, amount, notes, recorded_by)
    VALUES ('2026-06-06','supplier', ?, 1100, 'full purchase payment', ?)
  `).run(supplierId, userId);
  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-06','wages_knuckler', 300, 'full knuckler payment', ?)
  `).run(userId);
  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-06','sack', 100, 'full sack payment', ?)
  `).run(userId);
  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-06','transport_to_market', 200, 'full transport payment', ?)
  `).run(userId);

  gated = await getPaymentGatedSoldCost(db, '2026-06-01', '2026-06-30');
  report('AFTER full payment: paid_wire_cost = 110 (matches accrual exactly)',
    Math.abs(gated.paid_wire_cost - 110) < 0.01, `got ${gated.paid_wire_cost}`);
  report('AFTER full payment: paid_conversion_cost = 90 (matches accrual exactly)',
    Math.abs(gated.paid_conversion_cost - 90) < 0.01, `got ${gated.paid_conversion_cost}`);
  report('AFTER full payment: paid_transport_cost = 200 (matches accrual exactly)',
    Math.abs(gated.paid_transport_cost - 200) < 0.01, `got ${gated.paid_transport_cost}`);

  const invoice = await db.prepare(`
    INSERT INTO invoices(invoice_number, invoice_date, customer_name, status,
      subtotal, total_amount, amount_paid, sale_id, created_by)
    VALUES ('TEST-0001', '2026-06-05', 'Test Buyer', 'partial_payment',
      1500, 1500, 0, ?, ?)
    RETURNING id
  `).run(result.saleIds[0], userId);
  const invoiceId = invoice.lastInsertRowid;
  await db.prepare(`
    INSERT INTO invoice_payments(invoice_id, payment_date, amount, recorded_by)
    VALUES (?, '2026-06-10', 900, ?)
  `).run(invoiceId, userId);
  await db.prepare(`
    INSERT INTO invoice_payments(invoice_id, payment_date, amount, recorded_by)
    VALUES (?, '2026-07-05', 600, ?)
  `).run(invoiceId, userId);

  const manualInvoice = await db.prepare(`
    INSERT INTO invoices(invoice_number, invoice_date, customer_name, status,
      subtotal, total_amount, amount_paid, created_by)
    VALUES ('TEST-0002', '2026-06-06', 'Misc Buyer', 'paid', 300, 300, 300, ?)
    RETURNING id
  `).run(userId);
  await db.prepare(`
    INSERT INTO invoice_payments(invoice_id, payment_date, amount, recorded_by)
    VALUES (?, '2026-06-11', 300, ?)
  `).run(manualInvoice.lastInsertRowid, userId);

  async function soldRevenueFor(fromDate, toDate) {
    const row = await db.prepare(`
      SELECT COALESCE(SUM(ip.amount), 0) AS total
      FROM invoice_payments ip
      JOIN invoices i ON ip.invoice_id = i.id
      WHERE ip.payment_date BETWEEN ? AND ?
        AND i.sale_id IS NOT NULL
        AND i.status != 'cancelled'
    `).get(fromDate, toDate);
    return row.total;
  }

  const juneSoldRevenue = await soldRevenueFor('2026-06-01', '2026-06-30');
  const julySoldRevenue = await soldRevenueFor('2026-07-01', '2026-07-31');
  report('June sold_revenue = 900 (cash received in June only, manual invoice excluded)', juneSoldRevenue === 900, `got ${juneSoldRevenue}`);
  report('July sold_revenue = 600 (remaining balance received in July)', julySoldRevenue === 600, `got ${julySoldRevenue}`);
  report('June + July sold_revenue = 1500 (nothing lost or doubled)', (juneSoldRevenue + julySoldRevenue) === 1500, `got ${juneSoldRevenue + julySoldRevenue}`);

  const juneCogsDirectCosts = gated.paid_wire_cost + gated.paid_conversion_cost + gated.paid_transport_cost;
  const juneCogsGrossProfit = juneSoldRevenue - juneCogsDirectCosts;
  report('June Sold Gross Profit = 500 (900 cash minus full 400 cost, all now paid)', Math.abs(juneCogsGrossProfit - 500) < 0.01, `got ${juneCogsGrossProfit}`);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

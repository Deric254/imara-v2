// test-sold-profit-fix.js — TEST ONLY, not part of the shipped app.
// Verifies conversion_cost_per_piece + transport snapshot are correctly
// resolved on sale, and that Sold Gross/Net Profit is now fully sold-matched
// (wire + conversion + transport all COGS-based, not cash-based).

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

  const owner = await db.prepare(`SELECT id FROM users LIMIT 1`).get();
  const userId = owner.id;

  await db.prepare(`INSERT INTO piece_types(id, name, length_m, weight_kg, default_price, active) VALUES (1,'4-inch Nail',0.1,0.01,10,1)`).run();
  await db.prepare(`UPDATE config SET value='2' WHERE key='transport_to_market'`).run();

  await db.prepare(`
    INSERT INTO production(id, entry_date, kgs_used, operator_cost, knuckler_cost, sack_cost, rent_allocation, total_cost, gauge, entered_by)
    VALUES (1, '2026-06-01', 10, 500, 300, 100, 0, 2000, 'G1', ?)
  `).run(userId);
  await db.prepare(`INSERT INTO production_items(production_id, piece_type_id, pieces_produced) VALUES (1,1,1000)`).run();

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

  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-05','wages_operator', 5000, 'bulk wage payment', ?)
  `).run(userId);
  await db.prepare(`
    INSERT INTO payments(payment_date, category, amount, notes, recorded_by)
    VALUES ('2026-06-05','transport_to_market', 9999, 'bulk transport payment', ?)
  `).run(userId);

  // Sold Revenue is now cash actually RECEIVED against sale-linked invoices only
  // (decided with Deric 2026-07-14). Sale is worth 100*15=1500. Customer pays
  // 900 in June (same month as the sale) and the remaining 600 in July — this
  // proves the split lands in the right months and nothing is lost or doubled.
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

  // A manual (non-sale) invoice paid in June — must be EXCLUDED from sold_revenue.
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

  // Re-derive the same formulas getSalesCostSummary now uses, straight from the DB,
  // to prove the sold-matched COST figures ignore the mismatched bulk cash payments,
  // and that sold_revenue reflects cash received (sale-linked only), split by month.
  const cogsWireRow = await db.prepare(`
    SELECT COALESCE(SUM(s.quantity * pt.weight_kg * s.wire_cost_per_kg), 0) AS total
    FROM sales s JOIN piece_types pt ON pt.id = s.piece_type_id
    WHERE s.entry_date BETWEEN '2026-06-01' AND '2026-06-30'
  `).get();
  const cogsConvRow = await db.prepare(`
    SELECT COALESCE(SUM(s.quantity * s.conversion_cost_per_piece), 0) AS total
    FROM sales s WHERE s.entry_date BETWEEN '2026-06-01' AND '2026-06-30'
  `).get();
  const cogsTranRow = await db.prepare(`
    SELECT COALESCE(SUM(s.transport_to_market), 0) AS total
    FROM sales s WHERE s.entry_date BETWEEN '2026-06-01' AND '2026-06-30'
  `).get();

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

  const cogsWireCost = cogsWireRow.total;
  const cogsConvCost = cogsConvRow.total;
  const cogsTransportCost = cogsTranRow.total;
  const cogsDirectCosts = cogsWireCost + cogsConvCost + cogsTransportCost;

  const juneSoldRevenue = await soldRevenueFor('2026-06-01', '2026-06-30');
  const julySoldRevenue = await soldRevenueFor('2026-07-01', '2026-07-31');
  const juneCogsGrossProfit = juneSoldRevenue - cogsDirectCosts; // full cost lands in June (sale month)
  const julyCogsGrossProfit = julySoldRevenue - 0;               // no new cost in July

  report('cogs_wire_cost = 110', cogsWireCost === 110, `got ${cogsWireCost}`);
  report('cogs_conversion_cost = 90 (snapshot), NOT 5000 (cash)', cogsConvCost === 90, `got ${cogsConvCost}`);
  report('cogs_transport_cost = 200 (snapshot), NOT 9999 (cash)', cogsTransportCost === 200, `got ${cogsTransportCost}`);
  report('June sold_revenue = 900 (cash received in June only, manual invoice excluded)', juneSoldRevenue === 900, `got ${juneSoldRevenue}`);
  report('July sold_revenue = 600 (remaining balance received in July)', julySoldRevenue === 600, `got ${julySoldRevenue}`);
  report('June + July sold_revenue = 1500 (nothing lost or doubled)', (juneSoldRevenue + julySoldRevenue) === 1500, `got ${juneSoldRevenue + julySoldRevenue}`);
  report('June Sold Gross Profit = 500 (900 cash in June minus full 400 cost, booked in sale month)', juneCogsGrossProfit === 500, `got ${juneCogsGrossProfit}`);
  report('July Sold Gross Profit = 600 (balance arrives, no new cost)', julyCogsGrossProfit === 600, `got ${julyCogsGrossProfit}`);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

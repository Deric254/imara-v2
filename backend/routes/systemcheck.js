// routes/systemcheck.js — IMARA LINKS
//
// A real system tester, not a status page. Every check below runs a live,
// read-only query against the actual database and reports the actual
// numbers it found — it does not just confirm "the code looks fine". If
// something is wrong, this says so plainly, with the rows/amounts involved,
// so it can be verified and fixed rather than argued about.
//
// Strictly read-only: every query here is a SELECT/PRAGMA. This endpoint
// cannot modify, delete, or move anything — running it carries zero risk to
// stock or money, by construction.

const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

async function runChecks(db) {
  const checks = [];
  const push = (id, label, status, detail, extra = {}) =>
    checks.push({ id, label, status, detail, ...extra });

  // ── 1. Foreign key enforcement is actually active ─────────────────────────
  try {
    const fk = await db.prepare('PRAGMA foreign_keys').get();
    const on = fk && (fk.foreign_keys === 1 || fk.foreign_keys === '1');
    push('fk_enforcement', 'Foreign key enforcement', on ? 'pass' : 'fail',
      on ? 'Enabled on this connection.' : 'DISABLED — referential integrity constraints are not being enforced right now.');
  } catch (e) {
    push('fk_enforcement', 'Foreign key enforcement', 'fail', `Could not check: ${e.message}`);
  }

  // ── 2. Stock never oversold — sold must never exceed produced, per piece+gauge ──
  try {
    const rows = await db.prepare(`
      SELECT pt.name AS piece_name, x.gauge,
             COALESCE(x.produced,0) AS produced,
             COALESCE(y.sold,0)     AS sold
      FROM (
        SELECT pi.piece_type_id, pr.gauge, SUM(pi.pieces_produced) AS produced
        FROM production_items pi JOIN production pr ON pr.id = pi.production_id
        GROUP BY pi.piece_type_id, pr.gauge
      ) x
      LEFT JOIN (
        SELECT piece_type_id, gauge_source AS gauge, SUM(quantity) AS sold
        FROM sales GROUP BY piece_type_id, gauge_source
      ) y ON y.piece_type_id = x.piece_type_id AND y.gauge = x.gauge
      JOIN piece_types pt ON pt.id = x.piece_type_id
      WHERE COALESCE(y.sold,0) > COALESCE(x.produced,0)
    `).all();
    push('stock_oversell', 'Stock never oversold', rows.length ? 'fail' : 'pass',
      rows.length
        ? `${rows.length} piece/gauge combination(s) show more sold than ever produced: ` +
          rows.map(r => `${r.piece_name} gauge ${r.gauge} (produced ${r.produced}, sold ${r.sold})`).join('; ')
        : 'Every piece/gauge combination has sold ≤ produced. No oversell found in the data.');
  } catch (e) {
    push('stock_oversell', 'Stock never oversold', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 3. Wire used in production never exceeds wire bought, per gauge ───────
  try {
    const rows = await db.prepare(`
      SELECT b.gauge, COALESCE(b.bought,0) AS bought, COALESCE(u.used,0) AS used
      FROM (SELECT gauge, SUM(kgs_bought) AS bought FROM purchases GROUP BY gauge) b
      LEFT JOIN (SELECT gauge, SUM(kgs_used) AS used FROM production GROUP BY gauge) u
        ON u.gauge = b.gauge
      WHERE COALESCE(u.used,0) > COALESCE(b.bought,0) + 0.01
    `).all();
    push('wire_balance', 'Wire used never exceeds wire bought', rows.length ? 'fail' : 'pass',
      rows.length
        ? rows.map(r => `gauge ${r.gauge}: used ${r.used}kg vs bought ${r.bought}kg — ${(r.used-r.bought).toFixed(2)}kg unaccounted`).join('; ')
        : 'Every gauge has kg used ≤ kg bought, all-time. No phantom wire found.');
  } catch (e) {
    push('wire_balance', 'Wire used never exceeds wire bought', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 4. Converted orders actually produced a real sale/invoice ──────────────
  try {
    const brokenOrders = await db.prepare(`
      SELECT id, buyer_name, order_date FROM orders WHERE status = 'converted' AND invoice_id IS NULL
    `).all();
    const brokenItems = await db.prepare(`
      SELECT oi.id, oi.order_id FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'converted' AND oi.sale_id IS NULL
    `).all();
    const bad = brokenOrders.length + brokenItems.length;
    push('order_conversion_integrity', 'Converted orders have a real sale behind them', bad ? 'fail' : 'pass',
      bad
        ? `${brokenOrders.length} converted order(s) with no linked invoice, ${brokenItems.length} order item(s) with no linked sale.`
        : 'Every converted order has a linked invoice, and every converted item has a linked sale. No ghost conversions.');
  } catch (e) {
    push('order_conversion_integrity', 'Converted orders have a real sale behind them', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 5. Stale pending orders (operational flag, not a data bug) ────────────
  try {
    const rows = await db.prepare(`
      SELECT id, buyer_name, order_date, julianday('now') - julianday(order_date) AS age_days
      FROM orders WHERE status = 'pending' AND julianday('now') - julianday(order_date) > 14
      ORDER BY order_date ASC
    `).all();
    push('stale_orders', 'No orders pending for 14+ days', rows.length ? 'warn' : 'pass',
      rows.length
        ? `${rows.length} order(s) have been pending 14+ days — e.g. ${rows.slice(0,3).map(r => `${r.buyer_name} (${Math.floor(r.age_days)}d)`).join(', ')}. Not a data error, but worth finalizing, editing, or cancelling.`
        : 'No orders have been sitting pending for more than 14 days.');
  } catch (e) {
    push('stale_orders', 'No orders pending for 14+ days', 'warn', `Check could not run: ${e.message}`);
  }

  // ── 6. Invoice paid totals match their actual payment rows ────────────────
  try {
    const rows = await db.prepare(`
      SELECT i.id, i.invoice_number, i.amount_paid,
             COALESCE(SUM(p.amount),0) AS actual_paid
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.status != 'cancelled'
      GROUP BY i.id
      HAVING ABS(i.amount_paid - COALESCE(SUM(p.amount),0)) > 0.01
    `).all();
    push('invoice_payment_match', 'Invoice amount_paid matches its payment rows', rows.length ? 'fail' : 'pass',
      rows.length
        ? rows.map(r => `${r.invoice_number}: recorded ${r.amount_paid}, actual payments sum to ${r.actual_paid}`).join('; ')
        : `Checked every non-cancelled invoice — amount_paid matches its payment rows exactly.`);
  } catch (e) {
    push('invoice_payment_match', 'Invoice amount_paid matches its payment rows', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 7. Sales rows have the costing data reports depend on ─────────────────
  try {
    const rows = await db.prepare(`
      SELECT COUNT(*) AS n FROM sales
      WHERE wire_cost_per_kg IS NULL OR wire_cost_per_kg <= 0 OR gauge_source IS NULL OR TRIM(gauge_source) = ''
    `).get();
    push('sales_costing_complete', 'Every sale has gauge and wire cost recorded', rows.n > 0 ? 'fail' : 'pass',
      rows.n > 0
        ? `${rows.n} sale row(s) are missing a gauge and/or wire cost snapshot — these will silently distort COGS/margin figures wherever they're included.`
        : 'Every sale row has a gauge and a positive wire cost snapshot.');
  } catch (e) {
    push('sales_costing_complete', 'Every sale has gauge and wire cost recorded', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 8. Orphaned rows across key relationships ──────────────────────────────
  try {
    const orphanChecks = [
      ['order_items → orders',        `SELECT COUNT(*) n FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL`],
      ['invoice_items → invoices',    `SELECT COUNT(*) n FROM invoice_items ii LEFT JOIN invoices i ON i.id=ii.invoice_id WHERE i.id IS NULL`],
      ['invoice_payments → invoices', `SELECT COUNT(*) n FROM invoice_payments p LEFT JOIN invoices i ON i.id=p.invoice_id WHERE i.id IS NULL`],
      ['production_items → production', `SELECT COUNT(*) n FROM production_items pi LEFT JOIN production pr ON pr.id=pi.production_id WHERE pr.id IS NULL`],
      ['sales → piece_types',         `SELECT COUNT(*) n FROM sales s LEFT JOIN piece_types pt ON pt.id=s.piece_type_id WHERE pt.id IS NULL`],
    ];
    const results = [];
    for (const [label, sql] of orphanChecks) {
      const r = await db.prepare(sql).get();
      if (r.n > 0) results.push(`${label}: ${r.n} orphaned row(s)`);
    }
    push('referential_integrity', 'No orphaned rows in key relationships', results.length ? 'fail' : 'pass',
      results.length ? results.join('; ') : 'Checked 5 key relationships — no orphaned rows found.');
  } catch (e) {
    push('referential_integrity', 'No orphaned rows in key relationships', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 9. Cash-basis P&L ties out to Reconciliation, current month ───────────
  try {
    const now = new Date();
    const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const to   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);

    const paidByCat = await db.prepare(`
      SELECT category, COALESCE(SUM(amount),0) AS t FROM payments
      WHERE payment_date BETWEEN ? AND ? GROUP BY category
    `).all(from, to);
    const paidMap = {}; paidByCat.forEach(r => paidMap[r.category] = r.t);
    const cashCosts = (paidMap.supplier||0)+(paidMap.wages_operator||0)+(paidMap.wages_knuckler||0)+(paidMap.sack||0)+(paidMap.transport_to_market||0);
    const rentPaid  = paidMap.rent || 0;
    const totalPayments = Object.values(paidMap).reduce((a,b)=>a+b, 0);

    const outstanding = await db.prepare(`
      SELECT COALESCE(SUM(amount_due),0) AS due FROM rent_months WHERE month = ? AND paid = 0
    `).get(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`);

    const diff = Math.abs((cashCosts + rentPaid) - totalPayments);
    push('pnl_reconciliation_tie', `Cost of Sales + Rent ties to Reconciliation (${from} to ${to})`,
      diff < 0.01 ? 'pass' : 'warn',
      diff < 0.01
        ? `Cost of Sales + Rent (KES ${(cashCosts+rentPaid).toFixed(2)}) matches total payments (KES ${totalPayments.toFixed(2)}) exactly for the current month.`
        : `KES ${diff.toFixed(2)} gap between Cost of Sales+Rent and total payments this month. If there's an unpaid balance this can be expected — check Outstanding Payable; if not, this needs investigating.`);
  } catch (e) {
    push('pnl_reconciliation_tie', 'Cost of Sales + Rent ties to Reconciliation', 'warn', `Check could not run: ${e.message}`);
  }

  return checks;
}

router.get('/system-check', authenticate, requireRole('owner', 'admin'), async (_req, res) => {
  try {
    const db = getDb();
    const checks = await runChecks(db);
    const summary = {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    };
    res.json({ generated_at: new Date().toISOString(), summary, checks });
  } catch (e) {
    console.error('GET /system-check error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

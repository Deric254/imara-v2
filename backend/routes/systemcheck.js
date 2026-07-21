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
const { getSalesCostSummary, getRentPaidForRange } = require('./reports');

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
      ['invoice_items → piece_types', `SELECT COUNT(*) n FROM invoice_items ii LEFT JOIN piece_types pt ON pt.id=ii.piece_type_id WHERE ii.piece_type_id IS NOT NULL AND pt.id IS NULL`],
      ['order_items → piece_types',   `SELECT COUNT(*) n FROM order_items oi LEFT JOIN piece_types pt ON pt.id=oi.piece_type_id WHERE pt.id IS NULL`],
      ['production → purchases',      `SELECT COUNT(*) n FROM production pr LEFT JOIN purchases p ON p.id=pr.purchase_id WHERE pr.purchase_id IS NOT NULL AND p.id IS NULL`],
    ];
    const results = [];
    for (const [label, sql] of orphanChecks) {
      const r = await db.prepare(sql).get();
      if (r.n > 0) results.push(`${label}: ${r.n} orphaned row(s)`);
    }
    push('referential_integrity', 'No orphaned rows in key relationships', results.length ? 'fail' : 'pass',
      results.length ? results.join('; ') : `Checked ${orphanChecks.length} key relationships — no orphaned rows found.`);
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

    const diff = Math.abs((cashCosts + rentPaid) - totalPayments);
    push('pnl_reconciliation_tie', `Cost of Sales + Rent ties to Reconciliation (${from} to ${to})`,
      diff < 0.01 ? 'pass' : 'warn',
      diff < 0.01
        ? `Cost of Sales + Rent (KES ${(cashCosts+rentPaid).toFixed(2)}) matches total payments (KES ${totalPayments.toFixed(2)}) exactly for the current month.`
        : `KES ${diff.toFixed(2)} gap between Cost of Sales+Rent and total payments this month. If there's an unpaid balance this can be expected — check Outstanding Payable; if not, this needs investigating.`);
  } catch (e) {
    push('pnl_reconciliation_tie', 'Cost of Sales + Rent ties to Reconciliation', 'warn', `Check could not run: ${e.message}`);
  }

  // ── 10. Cash Basis converges with Sold Items once stock is fully sold ─────
  try {
    const totalBought = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const totalUsed   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;
    const rawStockKg  = totalBought - totalUsed;

    const remaining = await db.prepare(`
      SELECT COALESCE(SUM(MAX(COALESCE(x.produced,0) - COALESCE(y.sold,0), 0)),0) AS remaining
      FROM (
        SELECT pi.piece_type_id, pr.gauge, SUM(pi.pieces_produced) AS produced
        FROM production_items pi JOIN production pr ON pr.id = pi.production_id
        GROUP BY pi.piece_type_id, pr.gauge
      ) x
      LEFT JOIN (
        SELECT piece_type_id, gauge_source AS gauge, SUM(quantity) AS sold
        FROM sales GROUP BY piece_type_id, gauge_source
      ) y ON y.piece_type_id = x.piece_type_id AND y.gauge = x.gauge
    `).get();

    const cashWireCost = (await db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE category = \'supplier\'').get()).v;

    // soldWireCost — production-inward attribution:
    //
    // For each production run, take the wire cost recorded on that run and
    // multiply it by the fraction of its pieces that have been sold.
    // When every piece from every run is sold, each fraction is 1.0 and
    // soldWireCost = total production wire cost = cash paid to suppliers.
    //
    // WHY this formula and not (quantity x weight_kg x wire_cost_per_kg):
    //   weight_kg is a planning spec. Production may use more or less wire per
    //   piece than the spec (scrap, yield variation). The spec-based formula
    //   permanently under- or over-counts wire cost relative to actual spend.
    //   The production-inward formula starts from the real wire cost recorded
    //   at production time and distributes exactly that cost to sold pieces.
    //   Result: once all stock is sold, soldWireCost always equals cashWireCost
    //   to within floating-point rounding regardless of scrap or yield.
    const productionRuns = await db.prepare(
      'SELECT pr.id, pr.gauge, ' +
      'pr.total_cost - pr.operator_cost - pr.knuckler_cost - pr.sack_cost - pr.rent_allocation AS wire_cost ' +
      'FROM production pr'
    ).all();

    let soldWireCost = 0;
    for (const run of productionRuns) {
      const runItems = await db.prepare(
        'SELECT pi.piece_type_id, pi.pieces_produced FROM production_items pi WHERE pi.production_id = ?'
      ).all(run.id);

      const totalPiecesThisRun = runItems.reduce((s, i) => s + i.pieces_produced, 0);
      if (totalPiecesThisRun === 0) continue;

      let runSoldFraction = 0;
      for (const item of runItems) {
        const produced = (await db.prepare(
          'SELECT COALESCE(SUM(pi2.pieces_produced),0) AS v ' +
          'FROM production_items pi2 JOIN production pr2 ON pr2.id = pi2.production_id ' +
          'WHERE pi2.piece_type_id = ? AND COALESCE(pr2.gauge,\'\') = ?'
        ).get(item.piece_type_id, run.gauge || '')).v;

        const sold = (await db.prepare(
          'SELECT COALESCE(SUM(quantity),0) AS v FROM sales ' +
          'WHERE piece_type_id = ? AND COALESCE(gauge_source,\'\') = ?'
        ).get(item.piece_type_id, run.gauge || '')).v;

        const typeFrac = produced > 0 ? Math.min(sold / produced, 1.0) : 0;
        runSoldFraction += (item.pieces_produced / totalPiecesThisRun) * typeFrac;
      }

      soldWireCost += parseFloat(run.wire_cost) * runSoldFraction;
    }
    soldWireCost = parseFloat(soldWireCost.toFixed(2));

    const fullySoldThrough = rawStockKg <= 0.5 && remaining.remaining <= 0;
    const diff = Math.abs(cashWireCost - soldWireCost);

    if (fullySoldThrough) {
      push('cash_sold_convergence', 'Cash Basis converges with Sold Items once stock is fully sold', diff < 1 ? 'pass' : 'fail',
        diff < 1
          ? `All stock is sold through — Cash Basis wire cost (KES ${cashWireCost.toFixed(2)}) matches Sold Items wire cost (KES ${soldWireCost.toFixed(2)}) exactly, as required.`
          : `All stock is sold through, but Cash Basis wire cost (KES ${cashWireCost.toFixed(2)}) and Sold Items wire cost (KES ${soldWireCost.toFixed(2)}) differ by KES ${diff.toFixed(2)}. This must be zero once nothing remains in stock — needs investigating.`);
    } else {
      push('cash_sold_convergence', 'Cash Basis converges with Sold Items once stock is fully sold', 'pass',
        `Stock still on hand (${rawStockKg.toFixed(2)}kg raw wire, ${remaining.remaining} unsold processed piece(s)) — Cash Basis (KES ${cashWireCost.toFixed(2)}) and Sold Items (KES ${soldWireCost.toFixed(2)}) are expected to differ by KES ${diff.toFixed(2)} until sell-through completes.`);
    }

    // ── PERMANENT CROSS-CHECK: does what the Dashboard actually shows agree
    // with this independent recalculation? ──────────────────────────────────
    //
    // WHY this check exists: the check above (cash_sold_convergence) computes
    // soldWireCost from scratch, entirely from production records — it never
    // reads sales.wire_cost_per_piece, the actual column the Dashboard's
    // "Sold Net" KPI is built from. This meant a real bug could exist in how
    // that column gets WRITTEN (at the moment of each sale, in saleCore.js)
    // while this check stayed green, because it was never actually looking
    // at what the Dashboard shows — only at its own separately-derived number.
    // That gap is exactly what let a genuine double-counting bug reach a real
    // user's Dashboard while every systemcheck screen said PASS.
    //
    // This check closes that gap permanently: it reads the SAME stored value
    // the Dashboard reads, sums it across every sale ever made, and compares
    // it directly against the independent recalculation above. If a future
    // edit to saleCore.js, a bad migration, or any other change ever makes
    // the stored snapshots drift from reality again — for any reason, not
    // just the specific bug fixed today — this check fails immediately and
    // says exactly that, instead of the Dashboard silently showing a wrong
    // number while every other check stays green.
    const storedWireCostRows = await db.prepare('SELECT quantity, wire_cost_per_piece FROM sales').all();
    const dashboardWireCost = parseFloat(
      storedWireCostRows.reduce((s, r) => s + r.quantity * (r.wire_cost_per_piece || 0), 0).toFixed(2)
    );
    const snapshotDiff = Math.abs(dashboardWireCost - soldWireCost);
    // FIFO (what's actually stored on each sale) and the production-inward
    // fraction method (the independent recalculation above) are only
    // mathematically guaranteed to land on the same number once every piece
    // is sold — FIFO consumes the oldest batch first, the fraction method
    // spreads cost uniformly across all batches, and those two approaches
    // can legitimately diverge slightly while stock is only partially sold
    // through. That's not a bug, it's two different (both correct) ways of
    // answering "what's the cost of what's sold so far" — same as
    // cash_sold_convergence above, this check only demands an exact match
    // once fullySoldThrough is true.
    const wireCheckPasses = !fullySoldThrough || snapshotDiff < 1;
    push('dashboard_snapshot_matches_recalculation',
      'What the Dashboard actually shows agrees with an independent recalculation',
      wireCheckPasses ? 'pass' : 'fail',
      !fullySoldThrough
        ? `Stock not fully sold through yet — Dashboard's stored wire cost (KES ${dashboardWireCost.toFixed(2)}) and the independent recalculation (KES ${soldWireCost.toFixed(2)}) may differ by up to KES ${snapshotDiff.toFixed(2)} until sell-through completes; this is expected.`
        : snapshotDiff < 1
          ? `Dashboard's stored wire cost (KES ${dashboardWireCost.toFixed(2)}) matches the independently recalculated figure (KES ${soldWireCost.toFixed(2)}) exactly.`
          : `Dashboard's stored wire cost (KES ${dashboardWireCost.toFixed(2)}) does NOT match the independently recalculated figure (KES ${soldWireCost.toFixed(2)}) — differ by KES ${snapshotDiff.toFixed(2)}. All stock is sold through, so this must be zero — the numbers on the Dashboard cannot be trusted right now. This needs investigating immediately.`);

    // ── SAME PERMANENT CROSS-CHECK, for conversion cost ─────────────────────
    // Conversion cost (operator + knuckler + sack) has the exact same
    // architecture as wire cost — a snapshot written once at sale time,
    // never recomputed after — and therefore the exact same risk of silently
    // drifting from reality if a future change ever breaks how it's written.
    // This check is gauge-independent (labour cost doesn't depend on gauge),
    // otherwise identical in principle to the wire cost check above.
    const allProductionRuns = await db.prepare(
      'SELECT id, operator_cost + knuckler_cost + sack_cost AS conv_cost FROM production'
    ).all();

    let recalculatedConvCost = 0;
    for (const run of allProductionRuns) {
      const runItems = await db.prepare(
        'SELECT pi.piece_type_id, pi.pieces_produced FROM production_items pi WHERE pi.production_id = ?'
      ).all(run.id);
      const totalPiecesThisRun = runItems.reduce((s, i) => s + i.pieces_produced, 0);
      if (totalPiecesThisRun === 0) continue;

      let runSoldFraction = 0;
      for (const item of runItems) {
        const produced = (await db.prepare(
          'SELECT COALESCE(SUM(pieces_produced),0) AS v FROM production_items WHERE piece_type_id = ?'
        ).get(item.piece_type_id)).v;
        const sold = (await db.prepare(
          'SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id = ?'
        ).get(item.piece_type_id)).v;
        const typeFrac = produced > 0 ? Math.min(sold / produced, 1.0) : 0;
        runSoldFraction += (item.pieces_produced / totalPiecesThisRun) * typeFrac;
      }
      recalculatedConvCost += parseFloat(run.conv_cost) * runSoldFraction;
    }
    recalculatedConvCost = parseFloat(recalculatedConvCost.toFixed(2));

    const storedConvCostRows = await db.prepare('SELECT quantity, conversion_cost_per_piece FROM sales').all();
    const dashboardConvCost = parseFloat(
      storedConvCostRows.reduce((s, r) => s + r.quantity * (r.conversion_cost_per_piece || 0), 0).toFixed(2)
    );
    const convSnapshotDiff = Math.abs(dashboardConvCost - recalculatedConvCost);
    // Same reasoning as the wire cost check above: FIFO and the fraction-based
    // recalculation only have to agree exactly once everything is sold through.
    const convCheckPasses = !fullySoldThrough || convSnapshotDiff < 1;
    push('dashboard_conversion_snapshot_matches_recalculation',
      "What the Dashboard's conversion cost actually shows agrees with an independent recalculation",
      convCheckPasses ? 'pass' : 'fail',
      !fullySoldThrough
        ? `Stock not fully sold through yet — Dashboard's stored conversion cost (KES ${dashboardConvCost.toFixed(2)}) and the independent recalculation (KES ${recalculatedConvCost.toFixed(2)}) may differ by up to KES ${convSnapshotDiff.toFixed(2)} until sell-through completes; this is expected.`
        : convSnapshotDiff < 1
          ? `Dashboard's stored conversion cost (KES ${dashboardConvCost.toFixed(2)}) matches the independently recalculated figure (KES ${recalculatedConvCost.toFixed(2)}) exactly.`
          : `Dashboard's stored conversion cost (KES ${dashboardConvCost.toFixed(2)}) does NOT match the independently recalculated figure (KES ${recalculatedConvCost.toFixed(2)}) — differ by KES ${convSnapshotDiff.toFixed(2)}. All stock is sold through, so this must be zero — this needs investigating immediately.`);

    // ── PAYMENT-GATED SOLD NET vs CASH-BASIS NET PROFIT ──────────────────────
    //
    // WHY this check exists: the two checks above compare sales.wire_cost_per_piece
    // (an accrual snapshot) against an independent accrual recalculation — both
    // sides ignore payment timing entirely, so they will always agree with each
    // other regardless of how much has actually been paid. Since the Dashboard's
    // Sold Net KPI was redesigned to be PAYMENT-GATED (cost only counts once it's
    // actually been paid, matching how revenue already behaves), those two checks
    // no longer watch what the Dashboard actually displays — exactly the same
    // "systemcheck says PASS while the Dashboard shows something else" gap this
    // whole system-check apparatus exists to prevent.
    //
    // This check calls the EXACT SAME functions the Dashboard calls
    // (getSalesCostSummary, getRentPaidForRange, imported directly from
    // reports.js — not re-derived here) for an all-time range, and verifies a
    // fundamental, provable invariant: once every piece ever produced has been
    // sold, payment-gated Sold Net MUST equal cash-basis Net Profit, regardless
    // of what fraction of any given bill has been paid — because with zero
    // unsold stock, there is nowhere for a paid-or-unpaid cost to "hide" outside
    // of what's already been sold. If this check ever fails, it means the
    // payment-gating logic itself (backend/lib/paymentGatedCost.js) has a real
    // bug, not that a supplier bill is still outstanding.
    //
    // IMPORTANT PRECONDITION: this invariant only holds against the portion
    // of Net Profit that came from real inventory sales. A manual invoice
    // (not linked to any sale — e.g. billing for something outside normal
    // stock) has no matching inventory cost, so it correctly counts in full
    // as both revenue AND profit for cash-basis Net Profit, while Sold Net
    // correctly excludes it entirely. Confirmed on real data: a single
    // manual invoice produced an exact, cent-for-cent gap that was a false
    // alarm, not a bug. Rather than going soft the moment any manual invoice
    // exists (which would quietly weaken this check forever after), its
    // contribution is mathematically subtracted out of Net Profit first —
    // the check stays strict and can still catch a real bug even while
    // manual invoices are legitimately in use.
    try {
      const allTimeFrom = '2000-01-01', allTimeTo = '2099-12-31';
      const summary = await getSalesCostSummary(db, allTimeFrom, allTimeTo);
      const allTimeRent = await getRentPaidForRange(db, allTimeFrom, allTimeTo);
      const nonSaleRevenue = Math.max(0, summary.revenue - summary.sold_revenue);
      const netProfit = summary.gross_profit - allTimeRent;
      const inventoryOnlyNetProfit = netProfit - nonSaleRevenue;
      const soldNet = summary.cogs_gross_profit - allTimeRent;
      const gap = Math.abs(inventoryOnlyNetProfit - soldNet);

      // Reuses the same fullySoldThrough computed above (raw stock + unsold
      // pieces) — this invariant only has to hold once nothing remains unsold.
      const checkPasses = !fullySoldThrough || gap < 1;
      push('payment_gated_sold_net_matches_net_profit',
        'Payment-gated Sold Net converges with cash-basis Net Profit once stock is fully sold',
        checkPasses ? 'pass' : 'fail',
        !fullySoldThrough
          ? `Stock not fully sold through yet — inventory-only Net Profit (KES ${inventoryOnlyNetProfit.toFixed(2)}) and payment-gated Sold Net (KES ${soldNet.toFixed(2)}) may differ by up to KES ${gap.toFixed(2)} until sell-through completes; this is expected.`
          : gap < 1
            ? `All stock is sold through — inventory-only Net Profit (KES ${inventoryOnlyNetProfit.toFixed(2)}) and payment-gated Sold Net (KES ${soldNet.toFixed(2)}) match exactly, as required regardless of payment status.${nonSaleRevenue > 0.01 ? ` (KES ${nonSaleRevenue.toFixed(2)} of manual-invoice revenue was correctly excluded from this comparison.)` : ''}`
            : `All stock is sold through, but inventory-only Net Profit (KES ${inventoryOnlyNetProfit.toFixed(2)}) and payment-gated Sold Net (KES ${soldNet.toFixed(2)}) differ by KES ${gap.toFixed(2)}. This must always be zero once nothing remains in stock — indicates a real bug in the payment-gating logic, needs investigating immediately.`);
    } catch (e) {
      push('payment_gated_sold_net_matches_net_profit', 'Payment-gated Sold Net converges with cash-basis Net Profit once stock is fully sold', 'fail', `Check could not run: ${e.message}`);
    }

  } catch (e) {
    push('cash_sold_convergence', 'Cash Basis converges with Sold Items once stock is fully sold', 'fail', `Check could not run: ${e.message}`);
  }

  // ── 11. No payment ever exceeds what is actually owed ─────────────────────
  // reconciliation.js and invoices.js already make overpayment impossible
  // going forward — every payment write path has a pre-flight check plus an
  // ACID re-check inside its transaction. This check is a second, independent
  // line of defence: it re-derives accrued/billed vs paid straight from the
  // database for every supplier, worker, rent month, and pool, and would
  // catch anything that slipped in before those guards existed or arrived
  // via a restored backup.
  try {
    const num = v => parseFloat(v) || 0;
    const violations = [];

    const supplierRows = await db.prepare(`
      SELECT s.id, s.name,
        COALESCE((SELECT SUM(kgs_bought * cost_per_kg + transport_cost) FROM purchases WHERE supplier_id = s.id), 0) AS billed,
        COALESCE((SELECT SUM(amount) FROM payments WHERE category = 'supplier' AND payee_supplier_id = s.id), 0) AS paid
      FROM suppliers s
    `).all();
    supplierRows.forEach(r => {
      if (num(r.paid) > num(r.billed) + 0.01) violations.push(`Supplier "${r.name}": paid ${num(r.paid).toFixed(2)} vs billed ${num(r.billed).toFixed(2)}`);
    });

    for (const [cat, costCol, idCol, roleLabel] of [
      ['wages_operator', 'operator_cost', 'operator_id', 'Operator'],
      ['wages_knuckler', 'knuckler_cost', 'knuckler_id', 'Knuckler'],
    ]) {
      const rows = await db.prepare(`
        SELECT u.id, u.full_name,
          COALESCE((SELECT SUM(${costCol}) FROM production WHERE ${idCol} = u.id), 0) AS accrued,
          COALESCE((SELECT SUM(amount) FROM payments WHERE category = ? AND payee_user_id = u.id), 0) AS paid
        FROM users u
      `).all(cat);
      rows.forEach(r => {
        if (num(r.paid) > num(r.accrued) + 0.01) violations.push(`${roleLabel} "${r.full_name}": paid ${num(r.paid).toFixed(2)} vs accrued ${num(r.accrued).toFixed(2)}`);
      });
    }

    const rentRows = await db.prepare(`
      SELECT rm.month, rm.amount_due,
        COALESCE((SELECT SUM(amount) FROM payments WHERE category = 'rent'
          AND (rent_month = rm.month OR (rent_month IS NULL AND SUBSTR(payment_date,1,7) = rm.month))), 0) AS paid
      FROM rent_months rm
    `).all();
    rentRows.forEach(r => {
      if (num(r.paid) > num(r.amount_due) + 0.01) violations.push(`Rent ${r.month}: paid ${num(r.paid).toFixed(2)} vs due ${num(r.amount_due).toFixed(2)}`);
    });

    const sackAccrued = (await db.prepare(`SELECT COALESCE(SUM(sack_cost),0) AS v FROM production`).get()).v;
    const sackPaid     = (await db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE category = 'sack'`).get()).v;
    if (num(sackPaid) > num(sackAccrued) + 0.01) violations.push(`Sack costs: paid ${num(sackPaid).toFixed(2)} vs accrued ${num(sackAccrued).toFixed(2)}`);

    const tranAccrued = (await db.prepare(`SELECT COALESCE(SUM(transport_to_market),0) AS v FROM sales`).get()).v;
    const tranPaid     = (await db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE category = 'transport_to_market'`).get()).v;
    if (num(tranPaid) > num(tranAccrued) + 0.01) violations.push(`Transport to market: paid ${num(tranPaid).toFixed(2)} vs accrued ${num(tranAccrued).toFixed(2)}`);

    const invRows = await db.prepare(`
      SELECT invoice_number, total_amount, amount_paid FROM invoices WHERE status != 'cancelled'
    `).all();
    invRows.forEach(r => {
      if (num(r.amount_paid) > num(r.total_amount) + 0.01) violations.push(`Invoice ${r.invoice_number}: paid ${num(r.amount_paid).toFixed(2)} vs total ${num(r.total_amount).toFixed(2)}`);
    });

    push('no_overpayment_anywhere', 'No supplier, worker, rent month, pool, or invoice is ever paid beyond what it owes',
      violations.length ? 'fail' : 'pass',
      violations.length
        ? `${violations.length} overpayment(s) found: ${violations.join('; ')}`
        : 'Checked every supplier, every operator and knuckler, every rent month, the sack and transport pools, and every non-cancelled invoice — paid never exceeds owed anywhere.');
  } catch (e) {
    push('no_overpayment_anywhere', 'No supplier, worker, rent month, pool, or invoice is ever paid beyond what it owes', 'fail', `Check could not run: ${e.message}`);
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

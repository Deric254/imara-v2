// routes/dashboard.js — IMARA LINKS Dashboard
// Revenue  = money RECEIVED on invoices  (invoice_payments.payment_date)
// Purchase = money PAID to suppliers     (payments WHERE category='supplier')
// Production stays accrual (cost basis)
const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

// GET /api/dashboard
router.get('/', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const db = getDb();

    const fromDate = from || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];

    const [purchasesCash, productionSummary, salesCash, invoicesSummary, inventorySummary, payablesSummary] =
      await Promise.allSettled([

        // CASH-BASIS PURCHASES: money actually paid to suppliers in this period
        db.prepare(`
          SELECT
            COUNT(*)                AS count,
            COALESCE(SUM(amount),0) AS total_cost
          FROM payments
          WHERE category='supplier' AND payment_date BETWEEN ? AND ?
        `).get(fromDate, toDate),

        // Production — accrual (unchanged)
        db.prepare(`
          SELECT
            COUNT(*)                                            AS count,
            COALESCE(SUM(kgs_used), 0)                         AS total_kgs_used,
            COALESCE(SUM(total_cost), 0)                       AS total_cost,
            COALESCE(SUM(operator_cost + knuckler_cost), 0)    AS total_labour_cost
          FROM production
          WHERE entry_date BETWEEN ? AND ?
        `).get(fromDate, toDate),

        // CASH-BASIS SALES: money actually received from customers in this period
        db.prepare(`
          SELECT
            COUNT(*)                AS count,
            COALESCE(SUM(ip.amount),0) AS total_revenue
          FROM invoice_payments ip
          JOIN invoices i ON ip.invoice_id = i.id
          WHERE ip.payment_date BETWEEN ? AND ?
            AND i.status != 'cancelled'
        `).get(fromDate, toDate),

        // Invoice pipeline snapshot (outstanding balances)
        db.prepare(`
          SELECT
            COUNT(*)                                                  AS count,
            COALESCE(SUM(total_amount), 0)                           AS total_amount,
            COALESCE(SUM(amount_paid), 0)                            AS paid_amount,
            COALESCE(SUM(total_amount - amount_paid), 0)             AS outstanding_amount,
            COUNT(*) FILTER(WHERE status='paid')                     AS paid_count,
            COUNT(*) FILTER(WHERE status='partial_payment')          AS partial_count
          FROM invoices
          WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'
        `).get(fromDate, toDate),

        // Inventory summary (unchanged)
        db.prepare(`
          SELECT
            COUNT(*)                                                      AS total_piece_types,
            COUNT(CASE WHEN available > 0 THEN 1 END)                    AS in_stock,
            COUNT(CASE WHEN available <= 0 THEN 1 END)                   AS out_of_stock,
            COUNT(CASE WHEN available > 0 AND available <= 10 THEN 1 END) AS low_stock
          FROM (
            SELECT pt.id,
              (COALESCE(SUM(pi.pieces_produced),0) - COALESCE(SUM(s.quantity),0)) AS available
            FROM piece_types pt
            LEFT JOIN production_items pi ON pt.id = pi.piece_type_id
            LEFT JOIN sales s ON pt.id = s.piece_type_id
            WHERE pt.active=1 GROUP BY pt.id
          ) inventory
        `).get(),

        // All-time payables snapshot (accrued minus paid, not date-filtered)
        (async () => {
          // Supplier outstanding
          const suppAccrued = await db.prepare(`SELECT COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost),0) AS total FROM purchases`).get();
          const suppPaid    = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='supplier'`).get();
          const suppOut     = Math.max(0, parseFloat(suppAccrued.total) - parseFloat(suppPaid.total));

          // Wages outstanding
          const wageOpAccrued = await db.prepare(`SELECT COALESCE(SUM(operator_cost),0) AS total FROM production`).get();
          const wageKnAccrued = await db.prepare(`SELECT COALESCE(SUM(knuckler_cost),0) AS total FROM production`).get();
          const wageOpPaid    = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='wages_operator'`).get();
          const wageKnPaid    = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='wages_knuckler'`).get();
          const wageOut       = Math.max(0,
            (parseFloat(wageOpAccrued.total) - parseFloat(wageOpPaid.total)) +
            (parseFloat(wageKnAccrued.total) - parseFloat(wageKnPaid.total))
          );

          // Rent outstanding (using rent_month column with legacy fallback)
          const rentRows = await db.prepare(`
            SELECT rm.amount_due,
                   COALESCE(SUM(p.amount), 0) AS paid
            FROM rent_months rm
            LEFT JOIN payments p ON p.category = 'rent'
              AND (p.rent_month = rm.month OR (p.rent_month IS NULL AND LEFT(p.payment_date, 7) = rm.month))
            GROUP BY rm.id, rm.amount_due
          `).all();
          const rentOut = Math.max(0, rentRows.reduce((s, r) => s + Math.max(0, r.amount_due - r.paid), 0));

          // Sack outstanding
          const sackAccrued = await db.prepare(`SELECT COALESCE(SUM(sack_cost),0) AS total FROM production`).get();
          const sackPaid    = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='sack'`).get();
          const sackOut     = Math.max(0, parseFloat(sackAccrued.total) - parseFloat(sackPaid.total));

          const totalOut = parseFloat((suppOut + wageOut + rentOut + sackOut).toFixed(2));
          return { supplier_outstanding: parseFloat(suppOut.toFixed(2)), wages_outstanding: parseFloat(wageOut.toFixed(2)), rent_outstanding: parseFloat(rentOut.toFixed(2)), sack_outstanding: parseFloat(sackOut.toFixed(2)), outstanding_payable: totalOut };
        })(),
      ]);

    // Daily cash-basis trends
    const cashOutTrend = await db.prepare(`
      SELECT DATE(payment_date) AS date, 'purchases' AS type,
             COUNT(*) AS count, COALESCE(SUM(amount),0) AS value
      FROM payments
      WHERE category='supplier' AND payment_date BETWEEN ? AND ?
      GROUP BY DATE(payment_date)
    `).all(fromDate, toDate);

    const prodTrend = await db.prepare(`
      SELECT DATE(entry_date) AS date, 'production' AS type,
             COUNT(*) AS count, COALESCE(SUM(kgs_used),0) AS value
      FROM production WHERE entry_date BETWEEN ? AND ?
      GROUP BY DATE(entry_date)
    `).all(fromDate, toDate);

    const cashInTrend = await db.prepare(`
      SELECT DATE(ip.payment_date) AS date, 'sales' AS type,
             COUNT(*) AS count, COALESCE(SUM(ip.amount),0) AS value
      FROM invoice_payments ip
      JOIN invoices i ON ip.invoice_id = i.id
      WHERE ip.payment_date BETWEEN ? AND ?
        AND i.status != 'cancelled'
      GROUP BY DATE(ip.payment_date)
    `).all(fromDate, toDate);

    const dailyTrend = [...cashOutTrend, ...prodTrend, ...cashInTrend]
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    // Top pieces by cash received
    const topPieces = await db.prepare(`
      SELECT pt.name,
             COUNT(DISTINCT s.id)       AS sales_count,
             COALESCE(SUM(s.quantity),0) AS total_sold,
             COALESCE(SUM(ip.amount),0)  AS total_revenue
      FROM piece_types pt
      JOIN sales s ON pt.id = s.piece_type_id
      JOIN invoices i ON i.sale_id = s.id
      JOIN invoice_payments ip ON ip.invoice_id = i.id
      WHERE ip.payment_date BETWEEN ? AND ?
      GROUP BY pt.id, pt.name
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(fromDate, toDate).catch(() => []);

    // Recent activity
    const recentActivity = await db.prepare(`
      (SELECT 'payment_out' AS activity_type, payment_date AS activity_date,
              id AS reference_id, amount AS quantity, 'Supplier payment' AS description
       FROM payments WHERE category='supplier' AND payment_date BETWEEN ? AND ?
       ORDER BY payment_date DESC LIMIT 5)
      UNION ALL
      (SELECT 'production' AS activity_type, entry_date AS activity_date,
              id AS reference_id, kgs_used AS quantity, 'Kgs used in production' AS description
       FROM production WHERE entry_date BETWEEN ? AND ?
       ORDER BY entry_date DESC LIMIT 5)
      UNION ALL
      (SELECT 'payment_in' AS activity_type, ip.payment_date AS activity_date,
              ip.invoice_id AS reference_id, ip.amount AS quantity, 'Cash received' AS description
       FROM invoice_payments ip
       JOIN invoices i ON ip.invoice_id = i.id
       WHERE ip.payment_date BETWEEN ? AND ?
         AND i.status != 'cancelled'
       ORDER BY ip.payment_date DESC LIMIT 5)
      ORDER BY activity_date DESC LIMIT 10
    `).all(fromDate, toDate, fromDate, toDate, fromDate, toDate);

    // Assemble
    const purchases  = purchasesCash.status     === 'fulfilled' ? purchasesCash.value     : { count: 0, total_cost: 0 };
    const production = productionSummary.status === 'fulfilled' ? productionSummary.value : { count: 0, total_kgs_used: 0, total_cost: 0, total_labour_cost: 0 };
    const sales      = salesCash.status         === 'fulfilled' ? salesCash.value         : { count: 0, total_revenue: 0 };
    const invoices   = invoicesSummary.status   === 'fulfilled' ? invoicesSummary.value   : { count: 0, total_amount: 0, paid_amount: 0, outstanding_amount: 0, paid_count: 0, partial_count: 0 };
    const inventory  = inventorySummary.status  === 'fulfilled' ? inventorySummary.value  : { total_piece_types: 0, in_stock: 0, out_of_stock: 0, low_stock: 0 };
    const payables   = payablesSummary.status   === 'fulfilled' ? payablesSummary.value   : { outstanding_payable: 0, supplier_outstanding: 0, wages_outstanding: 0, rent_outstanding: 0, sack_outstanding: 0 };

    const cashIn     = parseFloat(sales.total_revenue)      || 0;
    const cashOut    = parseFloat(purchases.total_cost)     || 0;
    const labourCost = parseFloat(production.total_labour_cost) || 0;
    const netCash    = parseFloat((cashIn - cashOut - labourCost).toFixed(2));
    const profitMargin = cashIn > 0 ? parseFloat(((netCash / cashIn) * 100).toFixed(2)) : 0;

    res.json({
      period: { from: fromDate, to: toDate },
      accounting_basis: 'cash',
      summary: {
        purchases: {
          count: parseInt(purchases.count) || 0,
          total_cost: cashOut,
          note: 'Cash paid to suppliers',
          outstanding_payable:  payables.outstanding_payable,
          supplier_outstanding: payables.supplier_outstanding,
          wages_outstanding:    payables.wages_outstanding,
          rent_outstanding:     payables.rent_outstanding,
          sack_outstanding:     payables.sack_outstanding,
        },
        production: {
          count: parseInt(production.count) || 0,
          total_kgs_used: parseFloat(production.total_kgs_used) || 0,
          total_cost: parseFloat(production.total_cost) || 0,
          total_labour_cost: labourCost,
        },
        sales: { count: parseInt(sales.count) || 0, total_revenue: cashIn, note: 'Cash received from customers' },
        invoices: {
          count:              parseInt(invoices.count)                || 0,
          total_amount:       parseFloat(invoices.total_amount)       || 0,
          paid_amount:        parseFloat(invoices.paid_amount)        || 0,
          outstanding_amount: parseFloat(invoices.outstanding_amount) || 0,
          paid_count:         parseInt(invoices.paid_count)           || 0,
          partial_count:      parseInt(invoices.partial_count)        || 0,
        },
        inventory,
      },
      metrics: {
        cash_in:       cashIn,
        cash_out:      cashOut,
        labour_cost:   labourCost,
        net_cash:      netCash,
        profit_margin: profitMargin,
        // Legacy aliases so existing frontend charts don't break
        total_revenue: cashIn,
        total_cost:    cashOut + labourCost,
        profit:        netCash,
        material_cost: cashOut,
      },
      trends:          dailyTrend,
      top_pieces:      topPieces,
      recent_activity: recentActivity,
      stock_alerts:    { out_of_stock: inventory.out_of_stock || 0, low_stock: inventory.low_stock || 0 },
    });

  } catch (error) {
    console.error('Dashboard data error:', error);
    res.status(500).json({ error: 'Failed to load dashboard data', details: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

// GET /api/dashboard/inventory
router.get('/inventory', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const inventory = await db.prepare(`
      SELECT pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price, pt.active,
             COALESCE(SUM(pi.pieces_produced),0) AS total_produced,
             COALESCE(SUM(s.quantity),0)          AS total_sold,
             (COALESCE(SUM(pi.pieces_produced),0)-COALESCE(SUM(s.quantity),0)) AS available,
             CASE
               WHEN (COALESCE(SUM(pi.pieces_produced),0)-COALESCE(SUM(s.quantity),0)) <= 0  THEN 'out_of_stock'
               WHEN (COALESCE(SUM(pi.pieces_produced),0)-COALESCE(SUM(s.quantity),0)) <= 10 THEN 'low_stock'
               ELSE 'in_stock'
             END AS stock_status
      FROM piece_types pt
      LEFT JOIN production_items pi ON pt.id = pi.piece_type_id
      LEFT JOIN sales s ON pt.id = s.piece_type_id
      WHERE pt.active=1
      GROUP BY pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price, pt.active
      ORDER BY pt.name
    `).all();
    res.json(inventory);
  } catch (error) {
    console.error('Inventory data error:', error);
    res.status(500).json({ error: 'Failed to load inventory data' });
  }
});

// GET /api/dashboard/metrics — current month cash-basis KPIs
router.get('/metrics', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const currentMonth = new Date().toISOString().slice(0, 7);

    const [monthlyPurchasesCash, monthlyProduction, monthlySalesCash, monthlyInvoices] =
      await Promise.allSettled([
        db.prepare(`SELECT COALESCE(SUM(amount),0) AS cost FROM payments WHERE category='supplier' AND payment_date LIKE ?`).get(currentMonth + '%'),
        db.prepare(`SELECT COALESCE(SUM(kgs_used),0) AS kgs, COALESCE(SUM(total_cost),0) AS cost FROM production WHERE entry_date LIKE ?`).get(currentMonth + '%'),
        db.prepare(`SELECT COALESCE(SUM(ip.amount),0) AS revenue FROM invoice_payments ip JOIN invoices i ON ip.invoice_id=i.id WHERE ip.payment_date LIKE ? AND i.status!='cancelled'`).get(currentMonth + '%'),
        db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount FROM invoices WHERE invoice_date LIKE ?`).get(currentMonth + '%'),
      ]);

    const purchases  = monthlyPurchasesCash.status === 'fulfilled' ? monthlyPurchasesCash.value : { cost: 0 };
    const production = monthlyProduction.status    === 'fulfilled' ? monthlyProduction.value    : { kgs: 0, cost: 0 };
    const sales      = monthlySalesCash.status     === 'fulfilled' ? monthlySalesCash.value     : { revenue: 0 };
    const invoices   = monthlyInvoices.status      === 'fulfilled' ? monthlyInvoices.value      : { count: 0, amount: 0 };

    res.json({
      month: currentMonth,
      accounting_basis: 'cash',
      purchases:  { cost:    parseFloat(purchases.cost)   || 0 },
      production: { kgs:     parseFloat(production.kgs)   || 0, cost: parseFloat(production.cost) || 0 },
      sales:      { revenue: parseFloat(sales.revenue)    || 0 },
      invoices:   { count:   parseInt(invoices.count)     || 0, amount: parseFloat(invoices.amount) || 0 },
    });
  } catch (error) {
    console.error('Metrics error:', error);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

// GET /api/dashboard/cash-flow — daily cash-in vs cash-out for charts
router.get('/cash-flow', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const to   = req.query.to   || new Date().toISOString().split('T')[0];

    const cashIn = await db.prepare(`
      SELECT DATE(ip.payment_date) AS date, ROUND(SUM(ip.amount),2) AS amount
      FROM invoice_payments ip
      JOIN invoices i ON ip.invoice_id = i.id
      WHERE ip.payment_date BETWEEN ? AND ?
        AND i.status != 'cancelled'
      GROUP BY DATE(ip.payment_date) ORDER BY date
    `).all(from, to);

    const cashOut = await db.prepare(`
      SELECT DATE(payment_date) AS date, ROUND(SUM(amount),2) AS amount
      FROM payments WHERE category='supplier' AND payment_date BETWEEN ? AND ?
      GROUP BY DATE(payment_date) ORDER BY date
    `).all(from, to);

    const dateSet = new Set([...cashIn.map(r => r.date), ...cashOut.map(r => r.date)]);
    const inMap   = Object.fromEntries(cashIn.map(r  => [r.date, parseFloat(r.amount)]));
    const outMap  = Object.fromEntries(cashOut.map(r => [r.date, parseFloat(r.amount)]));

    const rows = [...dateSet].sort().map(date => ({
      date,
      cash_in:  inMap[date]  || 0,
      cash_out: outMap[date] || 0,
      net:      parseFloat(((inMap[date] || 0) - (outMap[date] || 0)).toFixed(2)),
    }));

    res.json({ period: { from, to }, rows });
  } catch (error) {
    console.error('Cash-flow error:', error);
    res.status(500).json({ error: 'Failed to load cash flow data' });
  }
});

module.exports = router;

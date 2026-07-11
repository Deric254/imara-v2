// routes/reconciliation.js — IMARA LINKS
const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { isFutureDate } = require('../lib/dateGuard');

const OWNER_ONLY  = [authenticate, requireRole('owner')];
const OWNER_ADMIN = [authenticate, requireRole('owner', 'admin')];

function num(v) { return parseFloat(v) || 0; }

// ensureRentMonths intentionally removed.
// Rent months are ONLY created explicitly by the owner in the reconciliation UI.
// Auto-inserting rent for every past month caused phantom rent to appear when
// backdating to periods where no rent had been recorded.
async function ensureRentMonths(_db, _ownerId) { /* no-op — explicit entry only */ }

// GET /api/reconciliation/summary
router.get('/summary', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db = getDb();
    await ensureRentMonths(db, req.user.id);

    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    // FIX: ROUND + add u_op.full_name, u_kn.full_name to GROUP BY
    const wagesRows = await db.prepare(`
      SELECT
        pr.operator_id,
        pr.knuckler_id,
        u_op.full_name  AS operator_name,
        u_kn.full_name  AS knuckler_name,
        ROUND(SUM(pr.operator_cost), 2) AS total_operator,
        ROUND(SUM(pr.knuckler_cost), 2) AS total_knuckler
      FROM production pr
      LEFT JOIN users u_op ON pr.operator_id = u_op.id
      LEFT JOIN users u_kn ON pr.knuckler_id = u_kn.id
      WHERE pr.entry_date BETWEEN ? AND ?
      GROUP BY pr.operator_id, pr.knuckler_id, u_op.full_name, u_kn.full_name
    `).all(from, to);

    // Load all users upfront so names are always available regardless of period filter
    const allUsers = await db.prepare(`SELECT id, full_name FROM users`).all([]);
    const userNameMap = {};
    for (const u of allUsers) userNameMap[u.id] = u.full_name;

    const wageMap = {};
    for (const r of wagesRows) {
      if (r.operator_id) {
        wageMap[r.operator_id] = wageMap[r.operator_id] || { user_id: r.operator_id, name: userNameMap[r.operator_id], accrued_operator: 0, accrued_knuckler: 0 };
        wageMap[r.operator_id].accrued_operator += num(r.total_operator);
      }
      if (r.knuckler_id) {
        wageMap[r.knuckler_id] = wageMap[r.knuckler_id] || { user_id: r.knuckler_id, name: userNameMap[r.knuckler_id], accrued_operator: 0, accrued_knuckler: 0 };
        wageMap[r.knuckler_id].accrued_knuckler += num(r.total_knuckler);
      }
    }

    const wagesPaid = await db.prepare(`
      SELECT payee_user_id, category,
             ROUND(SUM(amount), 2) AS paid
      FROM payments
      WHERE payment_date BETWEEN ? AND ?
        AND category IN ('wages_operator','wages_knuckler')
      GROUP BY payee_user_id, category
    `).all(from, to);

    for (const p of wagesPaid) {
      if (!p.payee_user_id) continue;
      if (!wageMap[p.payee_user_id]) {
        wageMap[p.payee_user_id] = { user_id: p.payee_user_id, name: userNameMap[p.payee_user_id], accrued_operator: 0, accrued_knuckler: 0 };
      }
      if (p.category === 'wages_operator') wageMap[p.payee_user_id].paid_operator = num(p.paid);
      if (p.category === 'wages_knuckler') wageMap[p.payee_user_id].paid_knuckler = num(p.paid);
    }

    const wages = Object.values(wageMap).map(w => ({
      ...w,
      paid_operator:    w.paid_operator  || 0,
      paid_knuckler:    w.paid_knuckler  || 0,
      balance_operator: parseFloat((w.accrued_operator - (w.paid_operator||0)).toFixed(2)),
      balance_knuckler: parseFloat((w.accrued_knuckler - (w.paid_knuckler||0)).toFixed(2)),
    }));

    // All-time per-worker accrued/paid — same reasoning as the supplier fix.
    // The "Pay Op"/"Pay Kn" buttons must pre-fill an amount the all-time
    // overpayment safeguard (below, in POST /payments) will actually accept.
    // Pre-filling the period-scoped balance_operator/balance_knuckler caused
    // false "Overpayment not allowed" errors whenever a wage payment for this
    // worker landed in a different period than the work it was settling.
    const allWagesAccruedRows = await db.prepare(`
      SELECT operator_id, knuckler_id,
             ROUND(SUM(operator_cost), 2) AS total_operator,
             ROUND(SUM(knuckler_cost), 2) AS total_knuckler
      FROM production
      GROUP BY operator_id, knuckler_id
    `).all([]);
    const allWagesPaidRows = await db.prepare(`
      SELECT payee_user_id, category, ROUND(SUM(amount), 2) AS paid
      FROM payments
      WHERE category IN ('wages_operator','wages_knuckler')
      GROUP BY payee_user_id, category
    `).all([]);
    const allWageAccruedMap = {};
    for (const r of allWagesAccruedRows) {
      if (r.operator_id) {
        allWageAccruedMap[r.operator_id] = allWageAccruedMap[r.operator_id] || { operator: 0, knuckler: 0 };
        allWageAccruedMap[r.operator_id].operator += num(r.total_operator);
      }
      if (r.knuckler_id) {
        allWageAccruedMap[r.knuckler_id] = allWageAccruedMap[r.knuckler_id] || { operator: 0, knuckler: 0 };
        allWageAccruedMap[r.knuckler_id].knuckler += num(r.total_knuckler);
      }
    }
    const allWagePaidMap = {};
    for (const p of allWagesPaidRows) {
      if (!p.payee_user_id) continue;
      allWagePaidMap[p.payee_user_id] = allWagePaidMap[p.payee_user_id] || { operator: 0, knuckler: 0 };
      if (p.category === 'wages_operator') allWagePaidMap[p.payee_user_id].operator = num(p.paid);
      if (p.category === 'wages_knuckler') allWagePaidMap[p.payee_user_id].knuckler = num(p.paid);
    }
    for (const w of wages) {
      const acc  = allWageAccruedMap[w.user_id] || { operator: 0, knuckler: 0 };
      const paid = allWagePaidMap[w.user_id]    || { operator: 0, knuckler: 0 };
      w.all_time_balance_operator = parseFloat((acc.operator - paid.operator).toFixed(2));
      w.all_time_balance_knuckler = parseFloat((acc.knuckler - paid.knuckler).toFixed(2));
    }

    // FIX: ROUND + add s.name to GROUP BY
    const supplierAccrued = await db.prepare(`
      SELECT p.supplier_id, s.name AS supplier_name,
             ROUND(SUM(p.kgs_bought * p.cost_per_kg + p.transport_cost), 2) AS total_billed
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.entry_date BETWEEN ? AND ?
      GROUP BY p.supplier_id, s.name
    `).all(from, to);

    // FIX: ROUND
    const supplierPaid = await db.prepare(`
      SELECT payee_supplier_id,
             ROUND(SUM(amount), 2) AS paid
      FROM payments
      WHERE payment_date BETWEEN ? AND ?
        AND category = 'supplier'
      GROUP BY payee_supplier_id
    `).all(from, to);

    const supplierPaidMap = {};
    for (const p of supplierPaid) supplierPaidMap[p.payee_supplier_id] = num(p.paid);

    // All-time accrued/paid per supplier — used ONLY to decide settled vs owing,
    // so a supplier paid in a different period than they were billed still
    // correctly shows as paid. The period-scoped total_billed/total_paid/balance
    // above are unchanged and still drive the "Billed/Paid this period" line.
    const allSupplierAccrued = await db.prepare(`
      SELECT supplier_id, ROUND(SUM(kgs_bought * cost_per_kg + transport_cost), 2) AS total
      FROM purchases GROUP BY supplier_id
    `).all([]);
    const allSupplierPaid = await db.prepare(`
      SELECT payee_supplier_id, ROUND(SUM(amount), 2) AS total
      FROM payments WHERE category = 'supplier' GROUP BY payee_supplier_id
    `).all([]);
    const allSupplierAccruedMap = {};
    for (const r of allSupplierAccrued) allSupplierAccruedMap[r.supplier_id] = num(r.total);
    const allSupplierPaidMap = {};
    for (const r of allSupplierPaid) allSupplierPaidMap[r.payee_supplier_id] = num(r.total);

    // Names for suppliers who appear in payments but had no purchase in this
    // period (so they wouldn't otherwise have a name available below).
    const allSuppliersList = await db.prepare(`SELECT id, name FROM suppliers`).all([]);
    const supplierNameMap = {};
    for (const sp of allSuppliersList) supplierNameMap[sp.id] = sp.name;

    const supplierAccruedMap = {};
    for (const s of supplierAccrued) supplierAccruedMap[s.supplier_id] = num(s.total_billed);

    // Union of supplier IDs with EITHER a purchase OR a payment in this period —
    // previously only suppliers with a purchase in-period appeared, so a
    // supplier who only paid this period (settling a bill from an earlier
    // period) was invisible here even though they have real activity to show.
    const periodSupplierIds = new Set([
      ...supplierAccrued.map(s => s.supplier_id),
      ...supplierPaid.map(p => p.payee_supplier_id).filter(id => id != null),
    ]);

    const suppliers = Array.from(periodSupplierIds).map(supplier_id => ({
      supplier_id,
      supplier_name: supplierNameMap[supplier_id] || 'Unknown Supplier',
      total_billed:  supplierAccruedMap[supplier_id] || 0,
      total_paid:    supplierPaidMap[supplier_id] || 0,
      balance:       parseFloat(((supplierAccruedMap[supplier_id] || 0) - (supplierPaidMap[supplier_id] || 0)).toFixed(2)),
      all_time_balance: parseFloat(
        ((allSupplierAccruedMap[supplier_id] || 0) - (allSupplierPaidMap[supplier_id] || 0)).toFixed(2)
      ),
    }));

    // FIX: ROUND
    const sackAccrued = await db.prepare(
      `SELECT ROUND(SUM(sack_cost), 2) AS total FROM production WHERE entry_date BETWEEN ? AND ?`
    ).get(from, to);
    const sackPaid = await db.prepare(
      `SELECT ROUND(SUM(amount), 2) AS total FROM payments WHERE payment_date BETWEEN ? AND ? AND category='sack'`
    ).get(from, to);
    const sackBalance = parseFloat((num(sackAccrued?.total) - num(sackPaid?.total)).toFixed(2));

    const rentMonths = await db.prepare(`
      SELECT rm.*,
             COALESCE(SUM(p.amount), 0) AS total_paid_amount
      FROM rent_months rm
      LEFT JOIN payments p ON p.category = 'rent'
        AND (p.rent_month = rm.month OR (p.rent_month IS NULL AND SUBSTR(p.payment_date, 1, 7) = rm.month))
      GROUP BY rm.id, rm.month, rm.amount_due, rm.paid, rm.payment_id, rm.created_at
      ORDER BY rm.month DESC
    `).all();

    const rentAccrued = rentMonths.reduce((s, r) => s + num(r.amount_due), 0);
    const rentPaid    = rentMonths.reduce((s, r) => s + num(r.total_paid_amount), 0);
    const rentBalance = parseFloat((rentAccrued - rentPaid).toFixed(2));

    // FIX: ROUND
    const otherPaid = await db.prepare(
      `SELECT ROUND(SUM(amount),2) AS total FROM payments WHERE payment_date BETWEEN ? AND ? AND category='other'`
    ).get(from, to);

    // Transport to market — accrued from sales, paid via reconciliation payments
    // This is the market transport cost saved on each sale at time of entry.
    // It is a real cash cost that must be fully tracked just like wages and sacks.
    // Accrued = SUM(sales.transport_to_market) for sales in the period.
    // Paid    = SUM(payments) where category = 'transport_to_market' in the period.
    const transportAccrued = await db.prepare(
      `SELECT ROUND(COALESCE(SUM(transport_to_market),0),2) AS total FROM sales WHERE entry_date BETWEEN ? AND ?`
    ).get(from, to);
    const transportPaid = await db.prepare(
      `SELECT ROUND(COALESCE(SUM(amount),0),2) AS total FROM payments WHERE payment_date BETWEEN ? AND ? AND category='transport_to_market'`
    ).get(from, to);
    const transportBalance = parseFloat(
      (parseFloat(transportAccrued?.total||0) - parseFloat(transportPaid?.total||0)).toFixed(2)
    );

    // All-time transport (for the grand banner)
    const allTransportAccrued = parseFloat(
      ((await db.prepare(`SELECT COALESCE(SUM(transport_to_market),0) AS t FROM sales`).get()).t || 0)
    );
    const allTransportPaid = parseFloat(
      ((await db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE category='transport_to_market'`).get()).t || 0)
    );

    const totalWagesAccrued   = wages.reduce((s, w) => s + w.accrued_operator + w.accrued_knuckler, 0);
    const totalWagesPaid      = wages.reduce((s, w) => s + w.paid_operator    + w.paid_knuckler,    0);
    const totalWagesBalance   = parseFloat((totalWagesAccrued - totalWagesPaid).toFixed(2));
    const totalSupplierBilled = suppliers.reduce((s, x) => s + x.total_billed, 0);
    const totalSupplierPaid   = suppliers.reduce((s, x) => s + x.total_paid,   0);
    const totalSupplierBal    = parseFloat((totalSupplierBilled - totalSupplierPaid).toFixed(2));
    // Period-filtered grand (wages+suppliers+sack+transport use date filter; rent is always all-time)
    const grandLiability = parseFloat(
      (totalWagesBalance + totalSupplierBal + sackBalance + transportBalance + rentBalance).toFixed(2)
    );

    // All-time true liability (used for the grand banner so it always matches the dashboard)
    const allWagesOpAccrued = num((await db.prepare(`SELECT COALESCE(SUM(operator_cost),0) AS t FROM production`).get()).t);
    const allWagesKnAccrued = num((await db.prepare(`SELECT COALESCE(SUM(knuckler_cost),0) AS t FROM production`).get()).t);
    const allWagesOpPaid    = num((await db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE category='wages_operator'`).get()).t);
    const allWagesKnPaid    = num((await db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE category='wages_knuckler'`).get()).t);
    const allWagesBal       = Math.max(0, parseFloat(((allWagesOpAccrued + allWagesKnAccrued) - (allWagesOpPaid + allWagesKnPaid)).toFixed(2)));

    const allSuppAccrued    = num((await db.prepare(`SELECT COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost),0) AS t FROM purchases`).get()).t);
    const allSuppPaid       = num((await db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE category='supplier'`).get()).t);
    const allSuppBal        = Math.max(0, parseFloat((allSuppAccrued - allSuppPaid).toFixed(2)));

    const allSackAccrued    = num((await db.prepare(`SELECT COALESCE(SUM(sack_cost),0) AS t FROM production`).get()).t);
    const allSackPaid       = num((await db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE category='sack'`).get()).t);
    const allSackBal        = Math.max(0, parseFloat((allSackAccrued - allSackPaid).toFixed(2)));

    const allTransportBal   = Math.max(0, parseFloat((allTransportAccrued - allTransportPaid).toFixed(2)));

    // Rent is already all-time
    const allTimeGrand = parseFloat(
      (allWagesBal + allSuppBal + allSackBal + allTransportBal + rentBalance).toFixed(2)
    );

    res.json({
      period: { from, to },
      wages: { workers: wages, total_accrued: parseFloat(totalWagesAccrued.toFixed(2)), total_paid: parseFloat(totalWagesPaid.toFixed(2)), balance: totalWagesBalance },
      suppliers: { breakdown: suppliers, total_billed: parseFloat(totalSupplierBilled.toFixed(2)), total_paid: parseFloat(totalSupplierPaid.toFixed(2)), balance: totalSupplierBal },
      sack: {
        accrued: parseFloat(num(sackAccrued?.total).toFixed(2)),
        paid:    parseFloat(num(sackPaid?.total).toFixed(2)),
        balance: sackBalance,
        // All-time balance — used by the UI to decide red/owing vs green/settled,
        // so a sack cost incurred in one month but paid in another doesn't show
        // as outstanding when the all-time books are actually settled.
        all_time_balance: allSackBal,
      },
      transport_to_market: {
        accrued:           parseFloat(num(transportAccrued?.total).toFixed(2)),
        paid:              parseFloat(num(transportPaid?.total).toFixed(2)),
        balance:           transportBalance,
        all_time_balance:  allTransportBal,
      },
      rent: {
        months: rentMonths.map(r => ({
          ...r,
          total_paid_amount: parseFloat(num(r.total_paid_amount).toFixed(2)),
          balance:           parseFloat((num(r.amount_due) - num(r.total_paid_amount)).toFixed(2)),
          status:            num(r.total_paid_amount) <= 0         ? 'unpaid'
                           : num(r.total_paid_amount) >= num(r.amount_due) ? 'paid'
                           : 'partial',
        })),
        total_accrued: parseFloat(rentAccrued.toFixed(2)),
        total_paid:    parseFloat(rentPaid.toFixed(2)),
        balance:       rentBalance,
      },
      other_paid: parseFloat(num(otherPaid?.total).toFixed(2)),
      grand_total_outstanding: allTimeGrand,
      grand_total_period: grandLiability,
    });
  } catch (e) {
    console.error('Reconciliation summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/payments
router.get('/payments', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from     || '2000-01-01';
    const to   = req.query.to       || '2099-12-31';
    const cat  = req.query.category || null;

    let sql = `
      SELECT py.*,
             COALESCE(py.payee_name, u.full_name) AS payee_user_name,
             COALESCE(py.payee_name, s.name)      AS payee_supplier_name,
             COALESCE(py.recorded_by_name, r.full_name) AS recorded_by_name
      FROM payments py
      LEFT JOIN users u     ON py.payee_user_id     = u.id
      LEFT JOIN suppliers s ON py.payee_supplier_id = s.id
      LEFT JOIN users r     ON py.recorded_by       = r.id
      WHERE py.payment_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (cat) { sql += ' AND py.category = ?'; params.push(cat); }
    sql += ' ORDER BY py.payment_date DESC, py.created_at DESC';

    res.json(await db.prepare(sql).all(...params));
  } catch (e) {
    console.error('List payments error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reconciliation/payments
router.post('/payments', ...OWNER_ONLY, async (req, res) => {
  try {
    const db = getDb();
    const { payment_date, category, amount, notes = '', payee_user_id, payee_supplier_id, payee_name } = req.body;

    if (!payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date) || isNaN(Date.parse(payment_date)))
      return res.status(400).json({ error: 'payment_date must be a valid date in YYYY-MM-DD format' });
    if (isFutureDate(payment_date))
      return res.status(400).json({ error: 'payment_date cannot be in the future' });
    const validCats = ['wages_operator','wages_knuckler','rent','supplier','sack','transport_to_market','other'];
    if (!validCats.includes(category)) return res.status(400).json({ error: 'Invalid category' });
    const parsedAmount = parseFloat(amount);
    if (amount === undefined || amount === null || amount === '' || isNaN(parsedAmount) || parsedAmount <= 0)
      return res.status(400).json({ error: 'amount must be a valid number greater than 0' });
    if ((category === 'wages_operator' || category === 'wages_knuckler') && !payee_user_id)
      return res.status(400).json({ error: 'payee_user_id required for wage payments' });
    if (category === 'supplier' && !payee_supplier_id)
      return res.status(400).json({ error: 'payee_supplier_id required for supplier payments' });

    // SAFEGUARD: prevent overpayment to a supplier beyond their total billed amount
    if (category === 'supplier' && payee_supplier_id) {
      const billed = await db.prepare(`
        SELECT COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost), 0) AS total
        FROM purchases WHERE supplier_id = ?
      `).get(parseInt(payee_supplier_id));
      const alreadyPaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category = 'supplier' AND payee_supplier_id = ?
      `).get(parseInt(payee_supplier_id));
      const totalBilled   = parseFloat(billed.total)      || 0;
      const totalPaid     = parseFloat(alreadyPaid.total) || 0;
      const remaining     = parseFloat((totalBilled - totalPaid).toFixed(2));
      const paying        = parseFloat(amount);
      if (paying > remaining + 0.005) {
        return res.status(400).json({
          error: `Overpayment not allowed. Outstanding supplier balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`
        });
      }
    }

    // SAFEGUARD: prevent wage overpayment beyond accrued amount
    if ((category === 'wages_operator' || category === 'wages_knuckler') && payee_user_id) {
      const col = category === 'wages_operator' ? 'operator_cost' : 'knuckler_cost';
      const accrued = await db.prepare(`
        SELECT COALESCE(SUM(${col}), 0) AS total FROM production WHERE ${
          category === 'wages_operator' ? 'operator_id' : 'knuckler_id'
        } = ?
      `).get(parseInt(payee_user_id));
      const alreadyPaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category = ? AND payee_user_id = ?
      `).get(category, parseInt(payee_user_id));
      const totalAccrued  = parseFloat(accrued.total)      || 0;
      const totalPaid     = parseFloat(alreadyPaid.total)  || 0;
      const remaining     = parseFloat((totalAccrued - totalPaid).toFixed(2));
      const paying        = parseFloat(amount);
      if (paying > remaining + 0.005) {
        return res.status(400).json({
          error: `Overpayment not allowed. Accrued wage balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`
        });
      }
    }

    // SAFEGUARD: prevent rent overpayment for a specific month (must be before INSERT)
    if (category === 'rent' && req.body.rent_month) {
      const month    = req.body.rent_month;
      const existing = await db.prepare('SELECT id, amount_due FROM rent_months WHERE month=?').get(month);
      if (existing) {
        const alreadyPaidForMonth = await db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM payments WHERE category='rent'
            AND (rent_month = ? OR (rent_month IS NULL AND SUBSTR(payment_date, 1, 7) = ?))
        `).get(month, month);
        const remaining = parseFloat((num(existing.amount_due) - num(alreadyPaidForMonth.total)).toFixed(2));
        if (parseFloat(amount) > remaining + 0.005) {
          return res.status(400).json({
            error: `Overpayment not allowed. Remaining rent balance for this month is KES ${remaining.toFixed(2)}. You are trying to pay KES ${parseFloat(amount).toFixed(2)}.`
          });
        }
      }
    }

    // SAFEGUARD: prevent sack overpayment beyond total accrued sack cost
    if (category === 'sack') {
      const sackAccrued    = await db.prepare(`SELECT COALESCE(SUM(sack_cost), 0) AS total FROM production`).get();
      const sackAlreadyPaid = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = 'sack'`).get();
      const totalAccrued   = parseFloat(sackAccrued.total)     || 0;
      const totalPaid      = parseFloat(sackAlreadyPaid.total) || 0;
      const remaining      = parseFloat((totalAccrued - totalPaid).toFixed(2));
      const paying         = parseFloat(amount);
      if (paying > remaining + 0.005) {
        return res.status(400).json({
          error: `Overpayment not allowed. Outstanding sack balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`
        });
      }
    }

    // SAFEGUARD: prevent transport overpayment beyond total accrued transport cost
    if (category === 'transport_to_market') {
      const tAccrued   = await db.prepare(`SELECT COALESCE(SUM(transport_to_market), 0) AS total FROM sales`).get();
      const tAlreadyPaid = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = 'transport_to_market'`).get();
      const totalAccrued = parseFloat(tAccrued.total)      || 0;
      const totalPaid    = parseFloat(tAlreadyPaid.total)  || 0;
      const remaining    = parseFloat((totalAccrued - totalPaid).toFixed(2));
      const paying       = parseFloat(amount);
      if (paying > remaining + 0.005) {
        return res.status(400).json({
          error: `Overpayment not allowed. Outstanding transport balance is KES ${remaining.toFixed(2)}. You are trying to pay KES ${paying.toFixed(2)}.`
        });
      }
    }

    // Resolve a durable payee name at the moment of payment, regardless of
    // whether the payee is a linked user, a linked supplier, or free text.
    // This is what gets stored — never re-derived later — so renaming the
    // person/supplier afterward cannot change this payment's record.
    let resolvedPayeeName = payee_name || null;
    if (payee_user_id) {
      const pu = await db.prepare('SELECT full_name FROM users WHERE id=?').get(parseInt(payee_user_id));
      resolvedPayeeName = pu?.full_name || resolvedPayeeName;
    } else if (payee_supplier_id) {
      const ps = await db.prepare('SELECT name FROM suppliers WHERE id=?').get(parseInt(payee_supplier_id));
      resolvedPayeeName = ps?.name || resolvedPayeeName;
    }

    const paying = parseFloat(amount);
    let pid;

    try {
      await db.transaction(async () => {
        // ACID: every overpayment guard above ran BEFORE this transaction opened,
        // against a snapshot of accrued/paid totals. Two concurrent payments for
        // the same worker/supplier/category (double-click, or two people paying
        // at once) could both pass those checks before either had written a row.
        // Re-run the one applicable guard here, inside the transaction, against a
        // fresh read — this is the check that actually holds the cap, because the
        // transaction queue guarantees nothing else can write between this read
        // and the insert below.
        const overpay = (msg) => { const e = new Error(msg); e.overpayment = true; throw e; };

        if (category === 'supplier' && payee_supplier_id) {
          const billed = await db.prepare(`SELECT COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost), 0) AS total FROM purchases WHERE supplier_id = ?`).get(parseInt(payee_supplier_id));
          const paidSoFar = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = 'supplier' AND payee_supplier_id = ?`).get(parseInt(payee_supplier_id));
          const remaining = parseFloat((num(billed.total) - num(paidSoFar.total)).toFixed(2));
          if (paying > remaining + 0.005) overpay(`Overpayment not allowed. Outstanding supplier balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`);
        }

        if ((category === 'wages_operator' || category === 'wages_knuckler') && payee_user_id) {
          const col = category === 'wages_operator' ? 'operator_cost' : 'knuckler_cost';
          const idCol = category === 'wages_operator' ? 'operator_id' : 'knuckler_id';
          const accrued = await db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS total FROM production WHERE ${idCol} = ?`).get(parseInt(payee_user_id));
          const paidSoFar = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = ? AND payee_user_id = ?`).get(category, parseInt(payee_user_id));
          const remaining = parseFloat((num(accrued.total) - num(paidSoFar.total)).toFixed(2));
          if (paying > remaining + 0.005) overpay(`Overpayment not allowed. Accrued wage balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`);
        }

        if (category === 'rent' && req.body.rent_month) {
          const month = req.body.rent_month;
          const existing = await db.prepare('SELECT id, amount_due FROM rent_months WHERE month=?').get(month);
          if (existing) {
            const paidForMonth = await db.prepare(`
              SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category='rent'
                AND (rent_month = ? OR (rent_month IS NULL AND SUBSTR(payment_date, 1, 7) = ?))
            `).get(month, month);
            const remaining = parseFloat((num(existing.amount_due) - num(paidForMonth.total)).toFixed(2));
            if (paying > remaining + 0.005) overpay(`Overpayment not allowed. Remaining rent balance for this month is KES ${remaining.toFixed(2)}. You are trying to pay KES ${paying.toFixed(2)}.`);
          }
        }

        if (category === 'sack') {
          const sackAccrued = await db.prepare(`SELECT COALESCE(SUM(sack_cost), 0) AS total FROM production`).get();
          const sackPaidSoFar = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = 'sack'`).get();
          const remaining = parseFloat((num(sackAccrued.total) - num(sackPaidSoFar.total)).toFixed(2));
          if (paying > remaining + 0.005) overpay(`Overpayment not allowed. Outstanding sack balance is ${remaining.toFixed(2)}. You are trying to pay ${paying.toFixed(2)}.`);
        }

        if (category === 'transport_to_market') {
          const tAccrued = await db.prepare(`SELECT COALESCE(SUM(transport_to_market), 0) AS total FROM sales`).get();
          const tPaidSoFar = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE category = 'transport_to_market'`).get();
          const remaining = parseFloat((num(tAccrued.total) - num(tPaidSoFar.total)).toFixed(2));
          if (paying > remaining + 0.005) overpay(`Overpayment not allowed. Outstanding transport balance is KES ${remaining.toFixed(2)}. You are trying to pay KES ${paying.toFixed(2)}.`);
        }

        // FIX: RETURNING id, store rent_month on payment
        const result = await db.prepare(`
          INSERT INTO payments(payment_date,category,payee_user_id,payee_supplier_id,payee_name,amount,notes,recorded_by,rent_month,recorded_by_name)
          VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id
        `).run(
          payment_date, category,
          payee_user_id     ? parseInt(payee_user_id)     : null,
          payee_supplier_id ? parseInt(payee_supplier_id) : null,
          resolvedPayeeName,
          paying, notes,
          req.user.id,
          (category === 'rent' && req.body.rent_month) ? req.body.rent_month : null,
          req.user.full_name
        );

        pid = result.lastInsertRowid;

        if (category === 'rent' && req.body.rent_month) {
          const month    = req.body.rent_month;
          const existing = await db.prepare('SELECT id, amount_due FROM rent_months WHERE month=?').get(month);
          if (existing) {
            // Sum all rent payments for this month using rent_month column (with legacy fallback)
            const totalPaidForMonth = await db.prepare(`
              SELECT COALESCE(SUM(amount), 0) AS total
              FROM payments WHERE category='rent'
                AND (rent_month = ? OR (rent_month IS NULL AND SUBSTR(payment_date, 1, 7) = ?))
            `).get(month, month);
            const fullyPaid = num(totalPaidForMonth.total) >= num(existing.amount_due);
            await db.prepare('UPDATE rent_months SET paid=?, payment_id=? WHERE month=?')
              .run(fullyPaid ? 1 : 0, pid, month);
          }
        }
      });
    } catch (e) {
      if (e.overpayment) return res.status(400).json({ error: e.message });
      throw e;
    }

    await writeAudit(db, {
      userId: req.user.id, action: 'RECORD_PAYMENT', table: 'payments',
      recordId: pid, newVals: { category, amount, payment_date }, ip: req.ip,
    });

    const payment = await db.prepare(`
      SELECT py.*, COALESCE(py.payee_name, u.full_name) AS payee_user_name, COALESCE(py.payee_name, s.name) AS payee_supplier_name
      FROM payments py
      LEFT JOIN users u     ON py.payee_user_id     = u.id
      LEFT JOIN suppliers s ON py.payee_supplier_id = s.id
      WHERE py.id = ?
    `).get(pid);

    res.status(201).json(payment);
  } catch (e) {
    console.error('Record payment error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reconciliation/payments/:id
router.delete('/payments/:id', ...OWNER_ONLY, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const row = await db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Payment not found' });

    // ACID: delete payment and recalculate rent_months status atomically.
    // Blindly setting paid=0 on delete was wrong when multiple partial payments
    // existed — deleting the last one cleared the flag even though earlier
    // partials still remained, leaving the month status stale/incorrect.
    // Now we recompute from the surviving payments after the delete.
    await db.transaction(async () => {
      await db.prepare('DELETE FROM payments WHERE id=?').run(id);
      if (row.category === 'rent' && row.rent_month) {
        const month    = row.rent_month;
        const rmRow    = await db.prepare('SELECT id, amount_due FROM rent_months WHERE month=?').get(month);
        if (rmRow) {
          const remaining = await db.prepare(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM payments WHERE category='rent'
              AND (rent_month = ? OR (rent_month IS NULL AND SUBSTR(payment_date, 1, 7) = ?))
          `).get(month, month);
          const totalRemaining = num(remaining.total);
          const fullyPaid      = totalRemaining >= num(rmRow.amount_due);
          // Find the id of the most recent surviving payment for this month (for payment_id pointer)
          const lastPmt = fullyPaid
            ? await db.prepare(`
                SELECT id FROM payments WHERE category='rent'
                  AND (rent_month = ? OR (rent_month IS NULL AND SUBSTR(payment_date, 1, 7) = ?))
                ORDER BY payment_date DESC, created_at DESC LIMIT 1
              `).get(month, month)
            : null;
          await db.prepare('UPDATE rent_months SET paid=?, payment_id=? WHERE month=?')
            .run(fullyPaid ? 1 : 0, lastPmt ? lastPmt.id : null, month);
        }
      }
    });

    await writeAudit(db, { userId: req.user.id, action: 'DELETE_PAYMENT', table: 'payments', recordId: id, oldVals: row, ip: req.ip });
    res.json({ message: 'Payment deleted' });
  } catch (e) {
    console.error('Delete payment error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/rent-months
router.get('/rent-months', ...OWNER_ONLY, async (req, res) => {
  try {
    const db = getDb();
    await ensureRentMonths(db, req.user.id);
    res.json(await db.prepare(`
      SELECT rm.*,
             COALESCE(SUM(p.amount), 0) AS total_paid_amount,
             CASE
               WHEN COALESCE(SUM(p.amount), 0) <= 0              THEN 'unpaid'
               WHEN COALESCE(SUM(p.amount), 0) >= rm.amount_due  THEN 'paid'
               ELSE 'partial'
             END AS status
      FROM rent_months rm
      LEFT JOIN payments p ON p.category = 'rent'
        AND (p.rent_month = rm.month OR (p.rent_month IS NULL AND SUBSTR(p.payment_date, 1, 7) = rm.month))
      GROUP BY rm.id, rm.month, rm.amount_due, rm.paid, rm.payment_id, rm.created_at
      ORDER BY rm.month DESC
    `).all());
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reconciliation/rent-months
router.post('/rent-months', ...OWNER_ONLY, async (req, res) => {
  try {
    const db = getDb();
    const { month, amount_due } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'month must be YYYY-MM format' });
    if (!amount_due || parseFloat(amount_due) <= 0)
      return res.status(400).json({ error: 'amount_due must be > 0' });
    if (await db.prepare('SELECT id FROM rent_months WHERE month=?').get(month))
      return res.status(409).json({ error: 'Rent month already exists' });

    // FIX: RETURNING id
    const r = await db.prepare('INSERT INTO rent_months(month,amount_due) VALUES(?,?) RETURNING id').run(month, parseFloat(amount_due));
    await writeAudit(db, { userId: req.user.id, action: 'ADD_RENT_MONTH', table: 'rent_months', recordId: r.lastInsertRowid, ip: req.ip });
    res.status(201).json(await db.prepare('SELECT * FROM rent_months WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    console.error('Add rent month error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/workers
router.get('/workers', ...OWNER_ONLY, async (req, res) => {
  try {
    res.json(await getDb().prepare(
      "SELECT id, full_name, role FROM users WHERE active=1 AND role IN ('knuckler','operator','admin','owner') ORDER BY full_name"
    ).all());
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/accrual/worker/:id
// All production runs involving this worker — all time, for full traceability
router.get('/accrual/worker/:id', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const uid = parseInt(req.params.id);
    const rows = await db.prepare(`
      SELECT pr.id, pr.entry_date, pr.kgs_used, pr.gauge,
             pr.operator_cost, pr.knuckler_cost, pr.sack_cost,
             COALESCE(pr.operator_name, uop.full_name) AS operator_name,
             COALESCE(pr.knuckler_name, ukn.full_name) AS knuckler_name,
             CASE WHEN pr.operator_id = ? THEN 'operator'
                  WHEN pr.knuckler_id = ? THEN 'knuckler'
                  ELSE 'both' END AS role_in_run
      FROM production pr
      LEFT JOIN users uop ON pr.operator_id = uop.id
      LEFT JOIN users ukn ON pr.knuckler_id = ukn.id
      WHERE pr.operator_id = ? OR pr.knuckler_id = ?
      ORDER BY pr.entry_date ASC, pr.created_at ASC
    `).all(uid, uid, uid, uid);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/accrual/supplier/:id
// All purchases from this supplier — all time
router.get('/accrual/supplier/:id', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const sid = parseInt(req.params.id);
    const rows = await db.prepare(`
      SELECT p.id, p.entry_date, p.kgs_bought, p.cost_per_kg,
             p.transport_cost,
             ROUND(p.kgs_bought * p.cost_per_kg + p.transport_cost, 2) AS total_billed,
             p.batch_name, p.gauge
      FROM purchases p
      WHERE p.supplier_id = ?
      ORDER BY p.entry_date ASC, p.created_at ASC
    `).all(sid);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/accrual/sack
// All production runs with sack cost — all time
router.get('/accrual/sack', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT pr.id, pr.entry_date, pr.kgs_used, pr.gauge, pr.sack_cost,
             COALESCE(pr.operator_name, uop.full_name) AS operator_name
      FROM production pr
      LEFT JOIN users uop ON pr.operator_id = uop.id
      WHERE pr.sack_cost > 0
      ORDER BY pr.entry_date ASC, pr.created_at ASC
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reconciliation/accrual/transport
// All sales with transport cost — all time
router.get('/accrual/transport', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT s.id, s.entry_date, s.quantity, s.buyer_name,
             s.transport_to_market, s.gauge_source
      FROM sales s
      WHERE s.transport_to_market > 0
      ORDER BY s.entry_date ASC, s.created_at ASC
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
// routes/reports.js — IMARA LINKS
// Harmonization Plan fully applied:
//   §2  Snapshot accounting — transactions store history, reports read transactions
//   §3  Transport default = config rate * quantity, saved on sales.transport_to_market at insert time
//   §4  Cost of Sales = wire + labour + sacks + market transport (rent excluded)
//   §6  Rent months are source of truth; payments matched by rent_month column
//   §7  Rent Expense (accrued, period-prorated) ≠ Rent Payable (outstanding balance)
//   §8  Dashboard payables use rent_month matching, not payment_date range
//   §9  Net Profit remains period-based: revenue − cost_of_sales − rent_expense
//   §11 Transport detail rows join to sales.transport_to_market — never hardcoded 0
//   §12 Historical values never recalculated from current config

const router = require('express').Router();
const { getDb }  = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function writeNotification(db, { userId, roleTarget, type, category, message, title }) {
  try {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO notifications(user_id, role_target, type, category, title, message, read, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      userId     ?? null,
      roleTarget ?? null,
      type       || 'warn',
      category   || type || '',
      title      || '',
      message    || '',
      now
    );
  } catch (_) { /* never block the caller */ }
}

async function checkAndNotifyStock(db, enteredBy) {
  try {
    const threshold = parseFloat(
      (await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100
    );

    async function writeIfNew(type, title, message) {
      const recent = await db.prepare(`
        SELECT id FROM notifications
        WHERE role_target = 'owner'
          AND title = ?
          AND (strftime('%s', created_at) + 0) >= (strftime('%s', 'now') - 3600)
        LIMIT 1
      `).get(title);
      if (!recent) {
        await writeNotification(db, { roleTarget: 'owner', type, category: type, title, message });
      }
    }

    // Per-gauge raw material stock check
    const gaugeStocks = await db.prepare(`
      SELECT
        COALESCE(p.gauge, '') AS gauge,
        COALESCE(SUM(p.kgs_bought), 0) AS bought,
        COALESCE(SUM(pr.kgs_used), 0)  AS used
      FROM (SELECT gauge, kgs_bought FROM purchases) p
      FULL OUTER JOIN (SELECT gauge, kgs_used FROM production) pr
        ON COALESCE(p.gauge, '') = COALESCE(pr.gauge, '')
      GROUP BY COALESCE(p.gauge, '')
    `).all().catch(() => null);

    if (gaugeStocks && gaugeStocks.length > 0) {
      for (const gs of gaugeStocks) {
        const remaining = parseFloat(gs.bought) - parseFloat(gs.used);
        const label     = gs.gauge ? `Wire (${gs.gauge})` : 'Wire';
        if (remaining <= 0) {
          await writeIfNew('alert', `${label} Stock — OUT`,
            `${label} stock is depleted (${remaining.toFixed(1)} kg). Production for this gauge is now blocked. Restock immediately.`);
        } else if (remaining <= threshold) {
          await writeIfNew('warn', `${label} Stock Low`,
            `Only ${remaining.toFixed(1)} kg of ${label.toLowerCase()} remaining (threshold: ${threshold} kg). Plan a restock soon.`);
        }
      }
    } else {
      const raw = await db.prepare(`
        SELECT COALESCE(SUM(kgs_bought),0) AS bought, COALESCE(SUM(kgs_used),0) AS used
        FROM (SELECT kgs_bought, 0 AS kgs_used FROM purchases
              UNION ALL SELECT 0, kgs_used FROM production) t
      `).get();
      const remaining = parseFloat(raw.bought) - parseFloat(raw.used);
      if (remaining <= 0) {
        await writeIfNew('alert', 'Wire Stock — OUT',
          `Wire stock is depleted (${remaining.toFixed(1)} kg). Production is now blocked. Restock immediately.`);
      } else if (remaining <= threshold) {
        await writeIfNew('warn', 'Wire Stock Low',
          `Only ${remaining.toFixed(1)} kg of wire remaining (threshold: ${threshold} kg). Plan a restock soon.`);
      }
    }

    // Finished goods per piece-type and gauge
    const low = await db.prepare(`
      WITH produced AS (
        SELECT pi.piece_type_id, COALESCE(pr.gauge,'') AS gauge, COALESCE(SUM(pi.pieces_produced),0) AS qty
        FROM production_items pi
        JOIN production pr ON pi.production_id = pr.id
        GROUP BY pi.piece_type_id, COALESCE(pr.gauge,'')
      ),
      sold AS (
        SELECT s.piece_type_id, COALESCE(s.gauge_source,'') AS gauge, COALESCE(SUM(s.quantity),0) AS qty
        FROM sales s
        GROUP BY s.piece_type_id, COALESCE(s.gauge_source,'')
      ),
      combos AS (
        SELECT piece_type_id, gauge FROM produced
        UNION SELECT piece_type_id, gauge FROM sold
      )
      SELECT pt.name, c.gauge,
             COALESCE(p.qty,0) - COALESCE(s.qty,0) AS available
      FROM combos c
      JOIN piece_types pt ON pt.id = c.piece_type_id
      LEFT JOIN produced p ON p.piece_type_id = c.piece_type_id AND p.gauge = c.gauge
      LEFT JOIN sold    s ON s.piece_type_id = c.piece_type_id AND s.gauge = c.gauge
      WHERE pt.active = 1
        AND (COALESCE(p.qty,0) - COALESCE(s.qty,0)) < 5
        AND (COALESCE(p.qty,0) - COALESCE(s.qty,0)) >= 0
    `).all();

    for (const item of low) {
      const avail      = parseInt(item.available) || 0;
      const gaugeLabel = item.gauge ? ` (${item.gauge})` : '';
      const itemLabel  = `${item.name}${gaugeLabel}`;
      if (avail === 0) {
        await writeIfNew('alert', `Stock-Out: ${itemLabel}`, `${itemLabel} is completely out of stock.`);
      } else {
        await writeIfNew('warn',  `Low Stock: ${itemLabel}`,
          `${itemLabel} has only ${avail} piece${avail === 1 ? '' : 's'} remaining.`);
      }
    }
  } catch (_) {}
}

async function getCfgNumber(db, key) {
  return parseFloat((await db.prepare('SELECT value FROM config WHERE key=?').get(key))?.value || 0);
}

// Wire cost per kg for a given piece_type_id up to toDate — used only by
// getLandingCost (suggested price preview). Reads from stored production records.
async function getWireCostPerKgForPieceType(db, pieceTypeId, toDate) {
  const result = await db.prepare(`
    SELECT
      COALESCE(SUM(
        pr.total_cost - pr.operator_cost - pr.knuckler_cost - pr.sack_cost - pr.rent_allocation
      ), 0) AS total_wire_cost,
      COALESCE(SUM(pr.kgs_used), 0) AS total_kgs
    FROM production pr
    JOIN production_items pi ON pi.production_id = pr.id
    WHERE pi.piece_type_id = ?
      AND pr.entry_date <= ?
  `).get(pieceTypeId, toDate);

  if (result.total_kgs > 0) return result.total_wire_cost / result.total_kgs;
  return 0;
}

async function getLandingCost(db, pt) {
  const today         = new Date().toISOString().slice(0, 10);
  const wireCostPerKg = await getWireCostPerKgForPieceType(db, pt.id, today);
  const operator      = await getCfgNumber(db, 'operator_cost');
  const knuckler      = await getCfgNumber(db, 'knuckler_cost');
  const sack          = await getCfgNumber(db, 'sack_cost');
  return (wireCostPerKg * pt.weight_kg) + operator + knuckler + (sack * 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE P&L SUMMARY
// Revenue  = cash received on invoice_payments in the period
// Cost     = cost of goods sold in the period — uses sales.entry_date (accrual for cost)
// transport_to_market is read from the SAVED sale snapshot (§2, §3, §11, §12).
// wire_cost_per_kg is read from the SAVED sale snapshot — written at insert time
// from actual production records for that piece type. Immutable after insert.
// Cost of Sales = wire + labour + sacks + market transport (rent excluded — §4).
// ─────────────────────────────────────────────────────────────────────────────
async function getSalesCostSummary(db, fromDate, toDate) {
  // CASH-BASIS: revenue = money actually received in this period
  const cashReceived = await db.prepare(`
    SELECT COALESCE(SUM(ip.amount), 0) AS total
    FROM invoice_payments ip
    JOIN invoices i ON ip.invoice_id = i.id
    WHERE ip.payment_date BETWEEN ? AND ?
      AND i.status != 'cancelled'
  `).get(fromDate, toDate);
  const revenue = parseFloat(cashReceived.total) || 0;

  // CASH-BASIS COSTS: money actually paid out in this period, by category.
  // Source of truth is the payments table — same source as dashboard and reconciliation.
  // This ensures dashboard, P&L, and reconciliation always show the same numbers.
  const [wirePaid, operatorPaid, knucklerPaid, sackPaid, transportPaid] = await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='supplier'           AND payment_date BETWEEN ? AND ?`).get(fromDate, toDate),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='wages_operator'    AND payment_date BETWEEN ? AND ?`).get(fromDate, toDate),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='wages_knuckler'    AND payment_date BETWEEN ? AND ?`).get(fromDate, toDate),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='sack'              AND payment_date BETWEEN ? AND ?`).get(fromDate, toDate),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE category='transport_to_market' AND payment_date BETWEEN ? AND ?`).get(fromDate, toDate),
  ]);

  const wireCost      = parseFloat(wirePaid.total)       || 0;
  const operatorCost  = parseFloat(operatorPaid.total)   || 0;
  const knucklerCost  = parseFloat(knucklerPaid.total)   || 0;
  const sackCost      = parseFloat(sackPaid.total)       || 0;
  const transportCost = parseFloat(transportPaid.total)  || 0;
  const convCost      = operatorCost + knucklerCost + sackCost;

  // Operational metrics — pieces and kgs sold in period (for insights/reporting only,
  // not used to compute costs which come from payments above)
  const salesMetrics = await db.prepare(`
    SELECT
      COALESCE(SUM(s.quantity), 0)               AS pieces_sold,
      COALESCE(SUM(s.quantity * pt.weight_kg), 0) AS kgs_sold
    FROM sales s
    JOIN piece_types pt ON pt.id = s.piece_type_id
    WHERE s.entry_date BETWEEN ? AND ?
  `).get(fromDate, toDate);

  const piecesSold    = parseInt(salesMetrics.pieces_sold)      || 0;
  const kgsSold       = parseFloat(salesMetrics.kgs_sold)       || 0;
  const wireCostPerKg = kgsSold > 0 ? wireCost / kgsSold : 0;
  const convCostPerPc = piecesSold > 0 ? convCost / piecesSold : 0;

  const directCosts = wireCost + convCost + transportCost;
  const grossProfit = revenue - directCosts;

  // COGS-MATCHED wire cost: uses the wire_cost_per_kg snapshot saved on each sale
  // (resolved by FIFO from production at time of sale — immutable). This reflects
  // only wire actually embedded in pieces that have been SOLD, so a bulk supplier
  // payment for stock still sitting in the store does not distort profit.
  // Cash-basis wire_cost above is left untouched — reconciliation and payables
  // tracking still key off it, per the existing cash-basis contract.
  const cogsWireSales = await db.prepare(`
    SELECT COALESCE(SUM(s.quantity * pt.weight_kg * s.wire_cost_per_kg), 0) AS total
    FROM sales s
    JOIN piece_types pt ON pt.id = s.piece_type_id
    WHERE s.entry_date BETWEEN ? AND ?
  `).get(fromDate, toDate);
  const cogsWireCost   = parseFloat(cogsWireSales.total) || 0;
  const cogsDirectCosts = cogsWireCost + convCost + transportCost;
  const cogsGrossProfit = revenue - cogsDirectCosts;

  return {
    revenue,
    pieces_sold:               piecesSold,
    kgs_sold:                  kgsSold,
    wire_cost_per_kg:          wireCostPerKg,
    operator_rate:             piecesSold > 0 ? operatorCost / piecesSold : 0,
    knuckler_rate:             piecesSold > 0 ? knucklerCost / piecesSold : 0,
    sack_rate:                 piecesSold > 0 ? sackCost / piecesSold : 0,
    conversion_cost_per_piece: convCostPerPc,
    wire_cost:                 wireCost,
    conversion_cost:           convCost,
    transport_to_market_cost:  transportCost,
    direct_costs:              directCosts,
    gross_profit:              grossProfit,
    cogs_wire_cost:            cogsWireCost,
    cogs_direct_costs:         cogsDirectCosts,
    cogs_gross_profit:         cogsGrossProfit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function toUtcDateParts(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function utcDateStr(d) {
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// ─────────────────────────────────────────────────────────────────────────────
// RENT EXPENSE — obligation incurred, period-prorated (§7, §9)
//
// Rule: rent expense = rent_months.amount_due prorated over the overlap between
// the selected date range and each month the owner has explicitly added.
//
// Source of truth: rent_months table — rows the owner creates in reconciliation.
// No row = no rent for that month. The system never assumes, never auto-creates.
// Payment status is irrelevant here — obligation is incurred when the month
// is added, not when cash is paid.
//
// Proration: daily_rate = amount_due / days_in_month
//            rent_expense = daily_rate × overlap_days_in_range
//
// This is consistent with reconciliation which also reads rent_months.amount_due.
// ─────────────────────────────────────────────────────────────────────────────
async function getAccruedRentForRange(db, fromDate, toDate) {
  const from = toUtcDateParts(fromDate);
  const to   = toUtcDateParts(toDate);

  // Only months the owner has explicitly added — no fallback, no assumptions
  const months = await db.prepare(`
    SELECT month, amount_due FROM rent_months
    WHERE month BETWEEN ? AND ?
    ORDER BY month
  `).all(fromDate.slice(0, 7), toDate.slice(0, 7));

  let rent = 0;
  for (const row of months) {
    const [year, month] = String(row.month).split('-').map(Number);
    if (!year || !month) continue;
    const monthStart   = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd     = new Date(Date.UTC(year, month - 1, daysInMonth(year, month - 1)));
    const overlapStart = from > monthStart ? from : monthStart;
    const overlapEnd   = to   < monthEnd   ? to   : monthEnd;
    if (overlapStart > overlapEnd) continue;
    const overlapDays = Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
    const dailyRent   = (parseFloat(row.amount_due) || 0) / daysInMonth(year, month - 1);
    rent += dailyRent * overlapDays;
  }
  return rent;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENT PAYABLE — outstanding balance per rent_month (§6, §7, §8)
// Answers: "What do we still owe for rent months in this period?"
//
// Payments are matched by payments.rent_month column — NOT by payment_date.
// This means a June payment for May rent correctly reduces May's payable balance.
// Legacy fallback: payments with rent_month IS NULL fall back to
// SUBSTR(payment_date,1,7) matching so old records still work.
//
// This is the ONLY correct way to compute rent outstanding. Using payment_date
// range (the old broken approach) would miss late payments entirely.
// ─────────────────────────────────────────────────────────────────────────────
async function getRentPayable(db, fromYYYYMM, toYYYYMM) {
  const rows = await db.prepare(`
    SELECT rm.amount_due,
           COALESCE(SUM(p.amount), 0) AS paid
    FROM rent_months rm
    LEFT JOIN payments p ON p.category = 'rent'
      AND (p.rent_month = rm.month
           OR (p.rent_month IS NULL AND SUBSTR(p.payment_date, 1, 7) = rm.month))
    WHERE rm.month BETWEEN ? AND ?
    GROUP BY rm.id, rm.amount_due
  `).all(fromYYYYMM, toYYYYMM);
  // Net across all months in range (a credit in one month offsets a balance owed
  // in another), matching the netting logic used on the Reconciliation page —
  // both screens must report the same outstanding rent figure for the same range.
  const accrued = rows.reduce((s, r) => s + parseFloat(r.amount_due), 0);
  const paid    = rows.reduce((s, r) => s + parseFloat(r.paid), 0);
  return Math.max(0, parseFloat((accrued - paid).toFixed(2)));
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory — Owner/Admin full inventory
// ─────────────────────────────────────────────────────────────────────────────
router.get('/inventory', authenticate, requireRole('owner', 'admin'), async (_req, res) => {
  try {
    const db = getDb();

    const totalBought = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const totalUsed   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;

    const expectedUsed = (await db.prepare(`
      SELECT SUM(pi.pieces_produced * pt.weight_kg) AS v
      FROM production_items pi JOIN piece_types pt ON pi.piece_type_id = pt.id
    `).get())?.v || 0;

    const usageEfficiency = totalUsed > 0
      ? parseFloat(((expectedUsed / totalUsed) * 100).toFixed(1)) : 0;

    const rawStock  = totalBought - totalUsed;
    const threshold = parseFloat(
      (await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100
    );

    const pieceTypes = await db.prepare(`
      SELECT pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price,
             COALESCE(SUM(pi.pieces_produced),0) AS total_produced
      FROM piece_types pt
      LEFT JOIN production_items pi ON pi.piece_type_id = pt.id
      WHERE pt.active = 1
      GROUP BY pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price
    `).all();

    const finished = [];
    for (const r of pieceTypes) {
      const sold        = (await db.prepare('SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id=?').get(r.id)).v;
      const avail       = r.total_produced - sold;
      const landingCost = await getLandingCost(db, r);
      finished.push({
        ...r,
        total_sold:       sold,
        available_pieces: avail,
        available_kgs:    parseFloat((avail * (r.weight_kg || 0)).toFixed(2)),
        available_meters: parseFloat((avail * (r.length_m  || 0)).toFixed(2)),
        stock_value:      parseFloat((Math.max(0, avail) * r.default_price).toFixed(2)),
        landing_cost:     parseFloat(landingCost.toFixed(2)),
        suggested_price:  parseFloat((landingCost * 1.3).toFixed(2)),
      });
    }

    const totalSoldPieces      = finished.reduce((s, i) => s + i.total_sold, 0);
    const totalAvailablePieces = finished.reduce((s, i) => s + i.available_pieces, 0);
    const totalStockValue      = finished.reduce((s, i) => s + i.stock_value, 0);

    const recentNow  = new Date();
    const recentDate = utcDateStr(new Date(Date.UTC(
      recentNow.getUTCFullYear(), recentNow.getUTCMonth(), recentNow.getUTCDate() - 90
    )));
    const recentSales = await db.prepare(`
      SELECT s.piece_type_id, SUM(s.quantity) AS recent_sold, pt.default_price
      FROM sales s
      JOIN piece_types pt ON s.piece_type_id = pt.id
      WHERE s.entry_date >= ?
      GROUP BY s.piece_type_id, pt.default_price
    `).all(recentDate);

    let recentSoldValue  = 0;
    let recentSoldPieces = 0;
    for (const sale of recentSales) {
      const item = finished.find(f => f.id === sale.piece_type_id);
      if (item) {
        recentSoldValue  += sale.recent_sold * item.default_price;
        recentSoldPieces += sale.recent_sold;
      }
    }

    let stockTurnoverRatio = 0;
    let stockTurnoverDays  = 0;
    let turnoverTrend      = 'stable';

    if (totalStockValue > 0 && recentSoldValue > 0) {
      const annualizedSoldValue = (recentSoldValue / 90) * 365;
      stockTurnoverRatio = parseFloat((annualizedSoldValue / totalStockValue).toFixed(2));
      if (stockTurnoverRatio > 0) stockTurnoverDays = Math.round(365 / stockTurnoverRatio);
      if      (stockTurnoverRatio >= 4) turnoverTrend = 'fast';
      else if (stockTurnoverRatio >= 2) turnoverTrend = 'good';
      else if (stockTurnoverRatio >= 1) turnoverTrend = 'slow';
      else                              turnoverTrend = 'very_slow';
    }

    let avgDaysToSell = 0;
    if (recentSoldPieces > 0 && totalAvailablePieces > 0) {
      const dailySellRate = recentSoldPieces / 90;
      avgDaysToSell = Math.round(totalAvailablePieces / dailySellRate);
    }

    res.json({
      raw_material: {
        total_bought_kgs: parseFloat(totalBought.toFixed(2)),
        total_used_kgs:   parseFloat(totalUsed.toFixed(2)),
        remaining_kgs:    parseFloat(rawStock.toFixed(2)),
        remaining_pct:    totalBought > 0 ? parseFloat(((rawStock / totalBought) * 100).toFixed(1)) : 0,
        usage_efficiency: usageEfficiency,
        low_stock:        rawStock < threshold,
        out_of_stock:     rawStock <= 0,
        threshold,
      },
      finished_goods:    finished,
      total_stock_value: parseFloat(totalStockValue.toFixed(2)),
      stock_turnover: {
        ratio:                          stockTurnoverRatio,
        days_on_hand:                   stockTurnoverDays,
        total_sold_pieces:              totalSoldPieces,
        total_available_pieces:         totalAvailablePieces,
        recent_sold_pieces_90days:      recentSoldPieces,
        recent_sold_value_90days:       parseFloat(recentSoldValue.toFixed(2)),
        avg_days_to_sell_current_stock: avgDaysToSell,
        turnover_trend:                 turnoverTrend,
        calculation_period:             '90_days_annualized',
      },
    });
  } catch (e) {
    console.error('GET /inventory error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/worker — Production staff inventory (read-only, no pricing)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/inventory/worker', authenticate, async (_req, res) => {
  try {
    const db = getDb();

    const totalBought  = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const totalUsed    = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;
    const expectedUsed = (await db.prepare(`
      SELECT SUM(pi.pieces_produced * pt.weight_kg) AS v
      FROM production_items pi JOIN piece_types pt ON pi.piece_type_id = pt.id
    `).get())?.v || 0;

    const usageEfficiency = totalUsed > 0
      ? parseFloat(((expectedUsed / totalUsed) * 100).toFixed(1)) : 0;
    const rawStock  = totalBought - totalUsed;
    const threshold = parseFloat(
      (await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100
    );

    const pieceTypes = await db.prepare(`
      SELECT pt.id, pt.name, pt.length_m, pt.weight_kg,
             COALESCE(SUM(pi.pieces_produced),0) AS total_produced
      FROM piece_types pt
      LEFT JOIN production_items pi ON pi.piece_type_id = pt.id
      WHERE pt.active = 1
      GROUP BY pt.id, pt.name, pt.length_m, pt.weight_kg
    `).all();

    const finished = [];
    for (const r of pieceTypes) {
      const sold  = (await db.prepare('SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id=?').get(r.id)).v;
      const avail = r.total_produced - sold;
      finished.push({
        id:               r.id,
        name:             r.name,
        available_pieces: avail,
        available_kgs:    parseFloat((avail * (r.weight_kg || 0)).toFixed(2)),
        available_meters: parseFloat((avail * (r.length_m  || 0)).toFixed(2)),
      });
    }

    res.json({
      raw_material: {
        total_bought_kgs: parseFloat(totalBought.toFixed(2)),
        total_used_kgs:   parseFloat(totalUsed.toFixed(2)),
        remaining_kgs:    parseFloat(rawStock.toFixed(2)),
        remaining_pct:    totalBought > 0 ? parseFloat(((rawStock / totalBought) * 100).toFixed(1)) : 0,
        usage_efficiency: usageEfficiency,
        low_stock:        rawStock < threshold,
        out_of_stock:     rawStock <= 0,
        threshold,
      },
      finished_goods: finished,
    });
  } catch (e) {
    console.error('GET /inventory/worker error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard — Main analytics dashboard
//
// Revenue  : cash-basis (invoice_payments received in period)
// Cost     : accrual-basis cost of goods sold in period
// Net Profit: revenue − cost_of_sales − period_rent_expense (§9)
// Payables : rent_month matching so dashboard ≡ reconciliation (§8)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    const days = Math.min(Math.max(parseInt(req.query.period || 30), 1), 365);

    let fromDate, toDate;
    if (req.query.from && req.query.to) {
      fromDate = req.query.from;
      toDate   = req.query.to;
    } else {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days
      )));
    }

    const salesSummary = await getSalesCostSummary(db, fromDate, toDate);
    // Rent Expense — prorated for P&L only (§7, §9).
    // This is NOT the same as rent payable — see getRentPayable below.
    const rentCost    = await getAccruedRentForRange(db, fromDate, toDate);
    const grossProfit = salesSummary.gross_profit;           // revenue − cost_of_sales
    const netProfit   = grossProfit - rentCost;              // − period rent expense
    const grossMargin = salesSummary.revenue > 0 ? (grossProfit / salesSummary.revenue * 100) : 0;
    const netMargin   = salesSummary.revenue > 0 ? (netProfit   / salesSummary.revenue * 100) : 0;

    // COGS-matched equivalents — wire cost tied to what was actually sold, not
    // raw cash paid to suppliers this period. See getSalesCostSummary for detail.
    const cogsGrossProfit = salesSummary.cogs_gross_profit;
    const cogsNetProfit   = cogsGrossProfit - rentCost;
    const cogsGrossMargin = salesSummary.revenue > 0 ? (cogsGrossProfit / salesSummary.revenue * 100) : 0;
    const cogsNetMargin   = salesSummary.revenue > 0 ? (cogsNetProfit   / salesSummary.revenue * 100) : 0;

    // Best piece by cash received
    const best = await db.prepare(`
      SELECT pt.name, ROUND(COALESCE(SUM(ip_agg.amount),0),2) AS revenue
      FROM (
        SELECT invoice_id, SUM(amount) AS amount
        FROM invoice_payments ip_inner
        JOIN invoices i_inner ON ip_inner.invoice_id = i_inner.id
        WHERE ip_inner.payment_date BETWEEN ? AND ?
          AND i_inner.status != 'cancelled'
        GROUP BY ip_inner.invoice_id
      ) ip_agg
      JOIN invoices i    ON i.id  = ip_agg.invoice_id
      JOIN sales    s    ON s.id  = i.sale_id
      JOIN piece_types pt ON pt.id = s.piece_type_id
      GROUP BY pt.id, pt.name
      ORDER BY revenue DESC LIMIT 1
    `).get(fromDate, toDate);

    // Best customers — cash-basis
    const bestCustomers = await db.prepare(`
      SELECT
        COALESCE(NULLIF(i.customer_name,''), 'Anonymous') AS customer_name,
        COUNT(DISTINCT i.id)                               AS transaction_count,
        COALESCE(SUM(ii_qty.qty), 0)                       AS total_pieces,
        ROUND(COALESCE(SUM(ip.amount),0), 2)               AS total_revenue
      FROM (
        SELECT invoice_id, SUM(amount) AS amount
        FROM invoice_payments ip_inner
        JOIN invoices i_inner ON ip_inner.invoice_id = i_inner.id
        WHERE ip_inner.payment_date BETWEEN ? AND ?
          AND i_inner.status != 'cancelled'
        GROUP BY invoice_id
      ) ip
      JOIN invoices i ON i.id = ip.invoice_id
      LEFT JOIN (
        SELECT invoice_id, SUM(quantity) AS qty
        FROM invoice_items GROUP BY invoice_id
      ) ii_qty ON ii_qty.invoice_id = i.id
      WHERE i.customer_name IS NOT NULL AND i.customer_name != ''
      GROUP BY i.customer_name
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(fromDate, toDate);

    // Gauge breakdown — cash-basis, proportional line-item split
    const gaugeBreakdown = await db.prepare(`
      SELECT
        COALESCE(NULLIF(ii.gauge,''), 'Unknown') AS gauge_source,
        COUNT(DISTINCT ii.invoice_id)             AS transaction_count,
        CAST(SUM(ii.quantity) AS INTEGER)         AS total_pieces,
        ROUND(SUM(
          ip.amount * (ii.line_total / NULLIF(i.subtotal, 0))
        ), 2)                                     AS total_revenue
      FROM (
        SELECT invoice_id, SUM(amount) AS amount
        FROM invoice_payments ip_inner
        JOIN invoices i_inner ON ip_inner.invoice_id = i_inner.id
        WHERE ip_inner.payment_date BETWEEN ? AND ?
          AND i_inner.status != 'cancelled'
        GROUP BY invoice_id
      ) ip
      JOIN invoices      i  ON i.id  = ip.invoice_id
      JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE ii.piece_type_id IS NOT NULL
      GROUP BY COALESCE(NULLIF(ii.gauge,''), 'Unknown')
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(fromDate, toDate);

    const rawBought = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const rawUsed   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;
    const rawStock  = rawBought - rawUsed;
    const threshold = parseFloat(
      (await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100
    );
    const prodVol   = (await db.prepare(
      'SELECT COALESCE(SUM(kgs_used),0) AS v FROM production WHERE entry_date BETWEEN ? AND ?'
    ).get(fromDate, toDate)).v;
    // Same source/column the Production module sums — guarantees this figure
    // always matches what the user sees when totalling the Production tab.
    const prodCost  = (await db.prepare(
      'SELECT COALESCE(SUM(total_cost),0) AS v FROM production WHERE entry_date BETWEEN ? AND ?'
    ).get(fromDate, toDate)).v;

    // Trend buckets
    const [sy, sm, sd] = fromDate.split('-').map(Number);
    const [ey, em, ed] = toDate.split('-').map(Number);
    const utcStart = new Date(Date.UTC(sy, sm - 1, sd));
    const utcEnd   = new Date(Date.UTC(ey, em - 1, ed));
    const diffDays = Math.round((utcEnd - utcStart) / 86400000) + 1;

    // Always daily — one point per day for every range.
    // The chart has zoom/pan so large ranges are still navigable.
    // Bucketing (step>1) caused transactions to be labelled with the bucket
    // start date instead of the actual transaction date, shifting dates.
    const step = 1;

    const buckets = [];
    for (let d = new Date(utcStart); d <= utcEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      buckets.push({ ds: utcDateStr(d), de: utcDateStr(d) });
    }

    const [revRows, kgPRows, kgBRows] = await Promise.all([
      db.prepare(`
        SELECT SUBSTR(ip.payment_date, 1, 10) AS d, COALESCE(SUM(ip.amount),0) AS v
        FROM invoice_payments ip
        JOIN invoices i ON ip.invoice_id = i.id
        WHERE SUBSTR(ip.payment_date, 1, 10) BETWEEN ? AND ?
          AND i.status != 'cancelled'
        GROUP BY SUBSTR(ip.payment_date, 1, 10)
      `).all(fromDate, toDate),
      db.prepare(`
        SELECT SUBSTR(entry_date, 1, 10) AS d, COALESCE(SUM(kgs_used),0) AS v
        FROM production WHERE SUBSTR(entry_date, 1, 10) BETWEEN ? AND ?
        GROUP BY SUBSTR(entry_date, 1, 10)
      `).all(fromDate, toDate),
      db.prepare(`
        SELECT SUBSTR(entry_date, 1, 10) AS d, COALESCE(SUM(kgs_bought),0) AS v
        FROM purchases WHERE SUBSTR(entry_date, 1, 10) BETWEEN ? AND ?
        GROUP BY SUBSTR(entry_date, 1, 10)
      `).all(fromDate, toDate),
    ]);

    const revMap = Object.fromEntries(revRows.map(r => [String(r.d), parseFloat(r.v) || 0]));
    const kgPMap = Object.fromEntries(kgPRows.map(r => [String(r.d), parseFloat(r.v) || 0]));
    const kgBMap = Object.fromEntries(kgBRows.map(r => [String(r.d), parseFloat(r.v) || 0]));

    const trends = [];
    for (const { ds, de } of buckets) {
      let rev = 0, kgP = 0, kgB = 0;
      const [bs, bm, bd2]   = ds.split('-').map(Number);
      const [es2, em2, ed2] = de.split('-').map(Number);
      const bStart = new Date(Date.UTC(bs, bm - 1, bd2));
      const bEnd   = new Date(Date.UTC(es2, em2 - 1, ed2));
      for (let bd = new Date(bStart); bd <= bEnd; bd.setUTCDate(bd.getUTCDate() + 1)) {
        const key = utcDateStr(bd);
        rev += revMap[key] || 0;
        kgP += kgPMap[key] || 0;
        kgB += kgBMap[key] || 0;
      }
      trends.push({
        date: ds,
        date_label: (() => {
          const d0 = new Date(Date.UTC(...ds.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v)));
          if (step >= 28) return d0.toLocaleDateString('en-US', { month: 'short', year: diffDays > 365 ? '2-digit' : undefined, timeZone: 'UTC' });
          return d0.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        })(),
        revenue:       parseFloat(rev.toFixed(2)),
        kgs_produced:  parseFloat(kgP.toFixed(2)),
        kgs_purchased: parseFloat(kgB.toFixed(2)),
      });
    }

    // ── Period payables summary (§8) ─────────────────────────────────────────
    // Rent Payable uses getRentPayable (rent_month matching) so dashboard and
    // reconciliation always show the same rent outstanding balance.
    const summary = await (async () => {
      // Open receivables created in period
      const invRow = await db.prepare(`
        SELECT
          COUNT(*)                                                   AS count,
          COALESCE(SUM(total_amount), 0)                            AS total_amount,
          COALESCE(SUM(amount_paid), 0)                             AS paid_amount,
          COALESCE(SUM(total_amount - amount_paid), 0)              AS outstanding_amount,
          COUNT(*) FILTER(WHERE status = 'partial_payment')         AS partial_count
        FROM invoices
        WHERE invoice_date BETWEEN ? AND ?
          AND status NOT IN ('paid', 'cancelled')
          AND total_amount > amount_paid
      `).get(fromDate, toDate);

      // Supplier outstanding (period-filtered)
      const supplierBilled = await db.prepare(`
        SELECT COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost), 0) AS total
        FROM purchases WHERE entry_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const supplierPaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category = 'supplier' AND payment_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const supplierOutstanding = Math.max(0,
        parseFloat(supplierBilled.total) - parseFloat(supplierPaid.total)
      );

      // Wages outstanding (period-filtered)
      const wageBilled = await db.prepare(`
        SELECT COALESCE(SUM(operator_cost + knuckler_cost), 0) AS total
        FROM production WHERE entry_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const wagePaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category IN ('wages_operator', 'wages_knuckler')
          AND payment_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const wagesOutstanding = Math.max(0,
        parseFloat(wageBilled.total) - parseFloat(wagePaid.total)
      );

      // Rent Payable — §6, §8.
      // rent_month matching: a June payment for May rent still reduces May's balance.
      // This matches what the reconciliation page shows — dashboard and reconciliation agree.
      const rentOutstanding = await getRentPayable(db, fromDate.slice(0, 7), toDate.slice(0, 7));

      // Transport to market outstanding (period-filtered)
      // Accrued = transport saved on sales in period. Paid = transport_to_market payments in period.
      const transportBilled = await db.prepare(`
        SELECT COALESCE(SUM(transport_to_market), 0) AS total
        FROM sales WHERE entry_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const transportPaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category = 'transport_to_market' AND payment_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const transportOutstanding = Math.max(0,
        parseFloat(transportBilled.total) - parseFloat(transportPaid.total)
      );

      // Sack outstanding (period-filtered)
      const sackBilled = await db.prepare(`
        SELECT COALESCE(SUM(sack_cost), 0) AS total
        FROM production WHERE entry_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const sackPaid = await db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE category = 'sack' AND payment_date BETWEEN ? AND ?
      `).get(fromDate, toDate);
      const sackOutstanding = Math.max(0,
        parseFloat(sackBilled.total) - parseFloat(sackPaid.total)
      );

      const totalOutstanding = parseFloat(
        (supplierOutstanding + wagesOutstanding + rentOutstanding + sackOutstanding + transportOutstanding).toFixed(2)
      );

      return {
        invoices: {
          count:              parseInt(invRow.count)                || 0,
          total_amount:       parseFloat(invRow.total_amount)       || 0,
          paid_amount:        parseFloat(invRow.paid_amount)        || 0,
          outstanding_amount: parseFloat(invRow.outstanding_amount) || 0,
          partial_count:      parseInt(invRow.partial_count)        || 0,
        },
        purchases: {
          supplier_outstanding:   supplierOutstanding,
          wages_outstanding:      wagesOutstanding,
          rent_outstanding:       rentOutstanding,
          sack_outstanding:       sackOutstanding,
          transport_outstanding:  transportOutstanding,
          outstanding_payable:    totalOutstanding,
        },
      };
    })();

    res.json({
      period_days: days, from: fromDate, to: toDate,
      granularity: {
        unit:         'day',
        step:         1,
        label:        diffDays <= 31 ? 'Daily' : diffDays <= 90 ? 'Weekly' : diffDays <= 365 ? 'Monthly' : 'Quarterly',
        total_points: trends.length,
      },
      kpis: {
        total_revenue:             parseFloat(salesSummary.revenue.toFixed(2)),
        total_cogs:                parseFloat(salesSummary.direct_costs.toFixed(2)),
        direct_costs_sold:         parseFloat(salesSummary.direct_costs.toFixed(2)),
        gross_profit:              parseFloat(grossProfit.toFixed(2)),
        gross_margin_pct:          parseFloat(grossMargin.toFixed(1)),
        rent_cost:                 parseFloat(rentCost.toFixed(2)),
        net_profit:                parseFloat(netProfit.toFixed(2)),
        net_margin_pct:            parseFloat(netMargin.toFixed(1)),
        profit_margin_pct:         parseFloat(netMargin.toFixed(1)),
        cogs_wire_cost:            parseFloat(salesSummary.cogs_wire_cost.toFixed(2)),
        cogs_direct_costs_sold:    parseFloat(salesSummary.cogs_direct_costs.toFixed(2)),
        cogs_gross_profit:         parseFloat(cogsGrossProfit.toFixed(2)),
        cogs_gross_margin_pct:     parseFloat(cogsGrossMargin.toFixed(1)),
        cogs_net_profit:           parseFloat(cogsNetProfit.toFixed(2)),
        cogs_net_margin_pct:       parseFloat(cogsNetMargin.toFixed(1)),
        sold_wire_cost:            parseFloat(salesSummary.wire_cost.toFixed(2)),
        sold_conversion_cost:      parseFloat(salesSummary.conversion_cost.toFixed(2)),
        sales_transport_cost:      parseFloat(salesSummary.transport_to_market_cost.toFixed(2)),
        wire_cost_per_kg:          parseFloat(salesSummary.wire_cost_per_kg.toFixed(2)),
        conversion_cost_per_piece: parseFloat(salesSummary.conversion_cost_per_piece.toFixed(2)),
        total_pieces_sold:         salesSummary.pieces_sold,
        total_kgs_sold:            parseFloat(salesSummary.kgs_sold.toFixed(2)),
        total_kgs_produced:        parseFloat(prodVol.toFixed(2)),
        total_production_cost:     parseFloat(parseFloat(prodCost).toFixed(2)),
        raw_stock_kg:              parseFloat(rawStock.toFixed(2)),
        low_stock:                 rawStock < threshold,
        best_piece:                best?.name || '—',
        best_piece_revenue:        parseFloat(best?.revenue || 0),
        best_customer:             bestCustomers[0]?.customer_name || '—',
        best_customer_revenue:     parseFloat(bestCustomers[0]?.total_revenue || 0),
      },
      trends,
      analytics: {
        best_customers:  bestCustomers,
        gauge_breakdown: gaugeBreakdown,
      },
      summary,
    });
  } catch (e) {
    console.error('GET /dashboard error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/worker-summary — Production staff personal KPIs
// ─────────────────────────────────────────────────────────────────────────────
router.get('/worker-summary', authenticate, async (req, res) => {
  try {
    const db   = getDb();
    const days = Math.min(parseInt(req.query.period || 30), 365);
    const now  = new Date();
    const from = utcDateStr(new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days
    )));

    const myPurchases  = await db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(kgs_bought),0) AS kgs FROM purchases  WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);
    const myProduction = await db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(kgs_used),0)   AS kgs FROM production WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);
    const mySales      = await db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(quantity*selling_price),0) AS rev FROM sales WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);

    res.json({
      period_days:   days,
      my_purchases:  { count: myPurchases.c,  total_kgs:     parseFloat((myPurchases.kgs  || 0).toFixed(2)) },
      my_production: { count: myProduction.c, total_kgs:     parseFloat((myProduction.kgs || 0).toFixed(2)) },
      my_sales:      { count: mySales.c,      total_revenue: parseFloat((mySales.rev      || 0).toFixed(2)) },
    });
  } catch (e) {
    console.error('GET /worker-summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — GET and PUT
// Config sets DEFAULTS only. It must never rewrite saved transaction values.
// Changing transport_to_market in config only affects NEW sales (§12).
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_KEYS = [
  'cost_per_kg', 'transport_cost', 'transport_to_market', 'operator_cost',
  'knuckler_cost', 'sack_cost', 'rent_allocation', 'stock_threshold', 'wire_gauges',
  'business_name', 'business_slogan', 'currency', 'invoice_prefix', 'invoice_tax_pct',
  'show_rent_dashboard',
];

router.get('/config', authenticate, async (_req, res) => {
  try {
    const rows = await getDb().prepare('SELECT key, value FROM config').all();
    const cfg  = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json(cfg);
  } catch (e) {
    console.error('GET /config error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/config', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    for (const [key, value] of Object.entries(req.body)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      await db.prepare(
        `INSERT INTO config(key, value, updated_by, updated_at)
         VALUES(?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      ).run(key, String(value), req.user.id);
      await writeAudit(db, {
        userId: req.user.id, action: 'CONFIG_UPDATE',
        table: 'config', newVals: { key, value }, ip: req.ip,
      });
    }
    const rows = await db.prepare('SELECT key, value FROM config').all();
    const cfg  = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json({ message: 'Config updated', config: cfg });
  } catch (e) {
    console.error('PUT /config error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PIECE TYPES
// ─────────────────────────────────────────────────────────────────────────────
router.get('/piece-types', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare('SELECT * FROM piece_types WHERE active=1 ORDER BY name').all());
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/piece-types', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, length_m, weight_kg, default_price } = req.body;
    const parsedLength = parseFloat(length_m);
    const parsedWeight = parseFloat(weight_kg);
    if (!name || length_m === undefined || length_m === null || length_m === '' ||
        weight_kg === undefined || weight_kg === null || weight_kg === '')
      return res.status(400).json({ error: 'name, length_m, weight_kg required' });
    if (isNaN(parsedLength) || parsedLength <= 0) return res.status(400).json({ error: 'length_m must be a valid number > 0' });
    if (isNaN(parsedWeight) || parsedWeight <= 0) return res.status(400).json({ error: 'weight_kg must be a valid number > 0' });
    const db    = getDb();
    const price = parseFloat(default_price) || 0;
    const r = await db.prepare(
      'INSERT INTO piece_types(name, length_m, weight_kg, default_price) VALUES(?,?,?,?) RETURNING id'
    ).run(name, parsedLength, parsedWeight, price);
    res.status(201).json({ id: r.lastInsertRowid, name, length_m: parsedLength, weight_kg: parsedWeight, default_price: price, active: 1 });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Piece type name already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/piece-types/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, length_m, weight_kg, default_price } = req.body;
    const parsedLength = parseFloat(length_m);
    const parsedWeight = parseFloat(weight_kg);
    if (!name || length_m === undefined || length_m === null || length_m === '' ||
        weight_kg === undefined || weight_kg === null || weight_kg === '')
      return res.status(400).json({ error: 'name, length_m, weight_kg required' });
    if (isNaN(parsedLength) || parsedLength <= 0) return res.status(400).json({ error: 'length_m must be a valid number > 0' });
    if (isNaN(parsedWeight) || parsedWeight <= 0) return res.status(400).json({ error: 'weight_kg must be a valid number > 0' });
    const db       = getDb();
    const existing = await db.prepare('SELECT id FROM piece_types WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Piece type not found' });
    const price = parseFloat(default_price) || 0;
    await db.prepare('UPDATE piece_types SET name=?, length_m=?, weight_kg=?, default_price=? WHERE id=?')
      .run(name, parsedLength, parsedWeight, price, req.params.id);
    res.json({ message: 'Updated', id: req.params.id, name, length_m: parsedLength, weight_kg: parsedWeight, default_price: price });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/piece-types/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db      = getDb();
    const pieceId = parseInt(req.params.id, 10);
    const existing = await db.prepare('SELECT * FROM piece_types WHERE id=?').get(pieceId);
    if (!existing) return res.status(404).json({ error: 'Piece type not found' });
    const usedInProd  = (await db.prepare('SELECT COUNT(*) AS c FROM production_items WHERE piece_type_id=?').get(pieceId)).c;
    const usedInSales = (await db.prepare('SELECT COUNT(*) AS c FROM sales           WHERE piece_type_id=?').get(pieceId)).c;
    if (usedInProd > 0 || usedInSales > 0)
      return res.status(400).json({ error: 'Piece type cannot be deleted because it is already used in system records' });
    await db.prepare('DELETE FROM piece_types WHERE id=?').run(pieceId);
    await writeAudit(db, { userId: req.user.id, action: 'DELETE_PIECE_TYPE', table: 'piece_types', recordId: pieceId, oldVals: existing, ip: req.ip });
    res.json({ message: 'Piece type deleted' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIERS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/suppliers', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all());
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/suppliers', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const db        = getDb();
    const cleanName = name.trim();
    const existing  = await db.prepare('SELECT * FROM suppliers WHERE name=?').get(cleanName);
    if (existing && existing.active)  return res.status(409).json({ error: 'Supplier already exists' });
    if (existing && !existing.active) {
      await db.prepare('UPDATE suppliers SET active=1 WHERE id=?').run(existing.id);
      return res.status(200).json({ id: existing.id, name: cleanName, active: 1, restored: true });
    }
    const r = await db.prepare('INSERT INTO suppliers(name) VALUES(?) RETURNING id').run(cleanName);
    res.status(201).json({ id: r.lastInsertRowid, name: cleanName, active: 1 });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/suppliers/:id', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT id FROM suppliers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });
    await db.prepare('UPDATE suppliers SET active=0 WHERE id=?').run(req.params.id);
    res.json({ message: 'Supplier deactivated' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKERS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/workers', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare(
      "SELECT id, full_name, role FROM users WHERE active=1 AND role IN ('knuckler','operator','admin','owner') ORDER BY full_name"
    ).all());
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DB STATS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/db-stats', authenticate, requireRole('owner', 'admin'), async (_req, res) => {
  try {
    const db   = getDb();
    const fs   = require('fs');
    const path = require('path');
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '../db/imara.db');
    let fileSizeBytes = 0;
    try { fileSizeBytes = fs.statSync(dbPath).size; } catch (_) {}

    const tables = [
      'audit_log', 'password_reset_tokens', 'notifications',
      'invoices', 'users', 'purchases', 'production', 'sales', 'payments',
    ];
    const counts = {};
    for (const t of tables) {
      try {
        const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
        counts[t] = row?.n ?? 0;
      } catch (_) { counts[t] = null; }
    }

    let oldestRecord = null;
    try {
      const r = await db.prepare(`
        SELECT MIN(entry_date) AS oldest FROM (
          SELECT entry_date FROM purchases
          UNION ALL SELECT entry_date FROM production
          UNION ALL SELECT entry_date FROM sales
        )
      `).get();
      oldestRecord = r?.oldest || null;
    } catch (_) {}

    res.json({ file_size_bytes: fileSizeBytes, counts, oldest_record: oldestRecord });
  } catch (e) {
    console.error('db-stats error:', e);
    res.status(500).json({ error: 'Failed to load DB stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
router.get('/audit', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { from, to, limit = 500 } = req.query;
    let sql = `SELECT al.*, u.username, u.full_name AS user_name
               FROM audit_log al LEFT JOIN users u ON al.user_id = u.id`;
    const params = [], conds = [];
    if (from) { conds.push('al.logged_at >= ?'); params.push(from); }
    if (to)   { conds.push('al.logged_at <= ?'); params.push(to + 'T23:59:59'); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ` ORDER BY al.logged_at DESC LIMIT ${Math.min(parseInt(limit) || 500, 5000)}`;
    res.json(await getDb().prepare(sql).all(...params));
  } catch (e) {
    console.error('GET /audit error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
router.post('/notifications', authenticate, async (req, res) => {
  try {
    const { type, category, title, message, roleTarget } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });

    const SUPPRESSED_CATEGORIES = ['production', 'sales', 'purchases', 'payment', 'activity'];
    const SUPPRESSED_TYPES      = ['info'];
    if (SUPPRESSED_CATEGORIES.includes(category) || SUPPRESSED_TYPES.includes(type)) {
      return res.json({ ok: true });
    }

    const db = getDb();
    const recent = await db.prepare(`
      SELECT id FROM notifications
      WHERE (user_id=? OR role_target=?)
        AND title=?
        AND (strftime('%s', created_at) + 0) >= (strftime('%s', 'now') - 300)
      LIMIT 1
    `).get(req.user.id, roleTarget || 'owner', title);
    if (!recent) {
      await writeNotification(db, {
        userId:     req.user.id,
        roleTarget: roleTarget || null,
        type:       type     || 'warn',
        category:   category || type || 'alert',
        title,
        message,
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/notifications', authenticate, async (req, res) => {
  try {
    res.json(await getDb().prepare(`
      SELECT * FROM notifications
      WHERE (user_id=? OR role_target=?)
        AND (
          type IN ('alert', 'warn')
          OR (type = 'info' AND category = 'invoice')
        )
      ORDER BY created_at DESC LIMIT 150
    `).all(req.user.id, req.user.role));
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/notifications/mark-all-read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'UPDATE notifications SET read=1 WHERE (user_id=? OR role_target=?) AND read=0'
    ).run(req.user.id, req.user.role);
    res.json({ message: 'All marked read' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'UPDATE notifications SET read=1 WHERE id=? AND (user_id=? OR role_target=?)'
    ).run(req.params.id, req.user.id, req.user.role);
    res.json({ message: 'Marked read' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/notifications/read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'DELETE FROM notifications WHERE (user_id=? OR role_target=?) AND read=1'
    ).run(req.user.id, req.user.role);
    res.json({ message: 'Read notifications cleared' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER PRODUCTION ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/worker-production', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    const operatorData = await db.prepare(`
      SELECT
        COALESCE(u.full_name, 'Unknown Operator') AS worker_name,
        'operator'                                 AS role,
        COUNT(DISTINCT p.id)                       AS production_days,
        SUM(pi.pieces_produced)                    AS total_pieces,
        SUM(pi.pieces_produced * pt.weight_kg)     AS total_kgs
      FROM production p
      JOIN production_items pi ON p.id = pi.production_id
      JOIN piece_types pt ON pi.piece_type_id = pt.id
      LEFT JOIN users u ON p.operator_id = u.id
      WHERE p.entry_date BETWEEN ? AND ?
        AND p.operator_id IS NOT NULL
      GROUP BY p.operator_id, u.full_name
      ORDER BY total_pieces DESC
    `).all(fromDate, toDate);

    const knucklerData = await db.prepare(`
      SELECT
        COALESCE(u.full_name, 'Unknown Knuckler') AS worker_name,
        'knuckler'                                 AS role,
        COUNT(DISTINCT p.id)                       AS production_days,
        SUM(pi.pieces_produced)                    AS total_pieces,
        SUM(pi.pieces_produced * pt.weight_kg)     AS total_kgs
      FROM production p
      JOIN production_items pi ON p.id = pi.production_id
      JOIN piece_types pt ON pi.piece_type_id = pt.id
      LEFT JOIN users u ON p.knuckler_id = u.id
      WHERE p.entry_date BETWEEN ? AND ?
        AND p.knuckler_id IS NOT NULL
      GROUP BY p.knuckler_id, u.full_name
      ORDER BY total_pieces DESC
    `).all(fromDate, toDate);

    res.json({
      period:    { from: fromDate, to: toDate },
      operators: operatorData,
      knucklers: knucklerData,
      summary: {
        total_operators: operatorData.length,
        total_knucklers: knucklerData.length,
        total_pieces:    operatorData.reduce((s, o) => s + (o.total_pieces || 0), 0),
        total_kgs:       operatorData.reduce((s, o) => s + (o.total_kgs    || 0), 0),
      },
    });
  } catch (e) {
    console.error('GET /worker-production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SALES BY PIECE TYPE
// ─────────────────────────────────────────────────────────────────────────────
router.get('/sales-by-piece', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    const salesData = await db.prepare(`
      SELECT
        pt.name                                                            AS piece_name,
        pt.length_m,
        COUNT(DISTINCT ii.invoice_id)                                      AS transaction_count,
        CAST(SUM(ii.quantity) AS INTEGER)                                  AS total_pieces,
        ROUND(SUM(
          ip_agg.paid_in_period * (ii.line_total / NULLIF(i.subtotal, 0))
        ), 2)                                                              AS total_revenue,
        ROUND(AVG(ii.unit_price), 2)                                       AS avg_price
      FROM (
        SELECT invoice_id, SUM(amount) AS paid_in_period
        FROM invoice_payments ip_inner
        JOIN invoices i_inner ON ip_inner.invoice_id = i_inner.id
        WHERE ip_inner.payment_date BETWEEN ? AND ?
          AND i_inner.status != 'cancelled'
        GROUP BY invoice_id
      ) ip_agg
      JOIN invoices      i  ON i.id  = ip_agg.invoice_id
      JOIN invoice_items ii ON ii.invoice_id = i.id
      JOIN piece_types   pt ON pt.id = ii.piece_type_id
      WHERE ii.piece_type_id IS NOT NULL
      GROUP BY pt.id, pt.name, pt.length_m
      ORDER BY total_revenue DESC
    `).all(fromDate, toDate);

    res.json({
      period:     { from: fromDate, to: toDate },
      sales_data: salesData,
      summary: {
        total_transactions: salesData.reduce((s, x) => s + (x.transaction_count || 0), 0),
        total_pieces:       salesData.reduce((s, x) => s + (x.total_pieces       || 0), 0),
        total_revenue:      salesData.reduce((s, x) => s + parseFloat(x.total_revenue || 0), 0),
      },
    });
  } catch (e) {
    console.error('GET /sales-by-piece error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/revenue-breakdown — Full P&L with cost breakdown details
//
// §11: Transport detail rows join to sales.transport_to_market (the snapshot
//      saved at the time of sale). Never hardcoded 0, never from config.
//      invoices.sale_id links auto-generated invoices to their originating sale.
//      Manual invoices (sale_id IS NULL) correctly default to 0 via COALESCE.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/revenue-breakdown', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    const salesSummary = await getSalesCostSummary(db, fromDate, toDate);
    const rentCost     = await getAccruedRentForRange(db, fromDate, toDate);

    // Detail rows — §11: LEFT JOIN sales s ON s.id = i.sale_id to get the
    // saved transport snapshot. COALESCE(s.transport_to_market, 0) means:
    //   - auto-generated invoices: uses the actual saved sale transport value
    //   - manual invoices (sale_id IS NULL): defaults to 0 (correct — no sale)
    // This replaces the old broken approach of hardcoding 0 for all rows.
    const detailRows = await db.prepare(`
      SELECT
        i.invoice_date                                                         AS entry_date,
        pt.name                                                                AS piece_name,
        ii.quantity,
        pt.weight_kg,
        COALESCE(s.transport_to_market, 0)                                     AS transport_to_market,
        ii.unit_price                                                          AS selling_price,
        i.total_amount,
        ip_agg.paid_in_period,
        MIN(
          ip_agg.paid_in_period * (ii.line_total / NULLIF(i.subtotal, 0)) / NULLIF(ii.line_total, 0),
          1.0
        )                                                                      AS ratio
      FROM (
        SELECT invoice_id, SUM(amount) AS paid_in_period
        FROM invoice_payments ip_inner
        JOIN invoices i_inner ON ip_inner.invoice_id = i_inner.id
        WHERE ip_inner.payment_date BETWEEN ? AND ?
          AND i_inner.status != 'cancelled'
        GROUP BY invoice_id
      ) ip_agg
      JOIN invoices      i  ON i.id  = ip_agg.invoice_id
      JOIN invoice_items ii ON ii.invoice_id = i.id
      JOIN piece_types   pt ON pt.id = ii.piece_type_id
      LEFT JOIN sales    s  ON s.id  = i.sale_id
      WHERE ii.piece_type_id IS NOT NULL
      ORDER BY i.invoice_date DESC
    `).all(fromDate, toDate);

    const wireCostPerKg = salesSummary.wire_cost_per_kg;
    const convPerPiece  = salesSummary.conversion_cost_per_piece;

    // Wire cost drill-down: sourced from the SAME population and formula as the
    // COGS top-line above (sales entered in period, each row's own saved
    // wire_cost_per_kg) so these rows always sum to cost_breakdown.wire_cost.amount.
    // Deliberately separate from detailRows below, which is cash-received based
    // and still correctly backs conversion_cost/transport_cost (those remain
    // cash-basis, unchanged).
    const wireDetailRows = await db.prepare(`
      SELECT s.entry_date      AS entry_date,
             pt.name            AS piece_name,
             s.quantity         AS quantity,
             pt.weight_kg       AS weight_kg,
             s.wire_cost_per_kg AS wire_cost_per_kg,
             s.selling_price    AS selling_price
      FROM sales s
      JOIN piece_types pt ON pt.id = s.piece_type_id
      WHERE s.entry_date BETWEEN ? AND ?
      ORDER BY s.entry_date DESC
    `).all(fromDate, toDate);

    const wireCostDetails = wireDetailRows.map(r => ({
      entry_date:    r.entry_date,
      piece_name:    r.piece_name,
      quantity:      r.quantity,
      weight_kg:     r.weight_kg,
      kgs_sold:      parseFloat((r.quantity * r.weight_kg).toFixed(3)),
      wire_cost:     parseFloat((r.quantity * r.weight_kg * r.wire_cost_per_kg).toFixed(2)),
      selling_price: r.selling_price,
      revenue:       parseFloat((r.quantity * r.selling_price).toFixed(2)),
    }));

    const conversionCostDetails = detailRows.map(r => ({
      entry_date:      r.entry_date,
      piece_name:      r.piece_name,
      quantity:        Math.round(r.quantity * r.ratio),
      conversion_cost: parseFloat((r.quantity * r.ratio * convPerPiece).toFixed(2)),
      selling_price:   r.selling_price,
      revenue:         parseFloat(r.paid_in_period.toFixed(2)),
    }));

    // Transport details — only rows where a real transport amount was saved (§3)
    const transportCostDetails = detailRows
      .filter(r => parseFloat(r.transport_to_market) > 0)
      .map(r => ({
        entry_date:          r.entry_date,
        piece_name:          r.piece_name,
        quantity:            Math.round(r.quantity * r.ratio),
        transport_to_market: parseFloat((r.transport_to_market * r.ratio).toFixed(2)),
        selling_price:       r.selling_price,
        revenue:             parseFloat(r.paid_in_period.toFixed(2)),
      }));

    const rentDetails = await db.prepare(`
      SELECT month, amount_due FROM rent_months
      WHERE month BETWEEN ? AND ?
      ORDER BY month
    `).all(fromDate.slice(0, 7), toDate.slice(0, 7));

    // CASH-BASIS — same figures as /api/dashboard and Reconciliation, so this
    // breakdown's totals always tally with those two (see getSalesCostSummary).
    // The COGS-matched view (cost tied to units actually sold, FIFO-batch
    // priced) is still available via salesSummary.cogs_* for anyone who wants
    // "true sell-through margin" instead of "cash spent this period".
    const grossProfit = salesSummary.gross_profit;
    const netProfit   = grossProfit - rentCost;
    const grossMargin = salesSummary.revenue > 0 ? (grossProfit / salesSummary.revenue * 100) : 0;
    const netMargin   = salesSummary.revenue > 0 ? (netProfit   / salesSummary.revenue * 100) : 0;

    const wireCostPct      = salesSummary.revenue > 0 ? (salesSummary.wire_cost / salesSummary.revenue * 100) : 0;
    const convCostPct      = salesSummary.revenue > 0 ? (salesSummary.conversion_cost / salesSummary.revenue * 100) : 0;
    const transportCostPct = salesSummary.revenue > 0 ? (salesSummary.transport_to_market_cost / salesSummary.revenue * 100) : 0;
    const netProfitPct     = salesSummary.revenue > 0 ? (netProfit / salesSummary.revenue * 100) : 0;

    res.json({
      period: { from: fromDate, to: toDate },
      summary: {
        total_revenue: parseFloat(salesSummary.revenue.toFixed(2)),
        total_costs:   parseFloat((salesSummary.direct_costs + rentCost).toFixed(2)),
        rent_cost:     parseFloat(rentCost.toFixed(2)),
        net_profit:    parseFloat(netProfit.toFixed(2)),
        gross_margin:  parseFloat(grossMargin.toFixed(1)),
        net_margin:    parseFloat(netMargin.toFixed(1)),
      },
      cost_breakdown: {
        wire_cost: {
          amount:      parseFloat(salesSummary.wire_cost.toFixed(2)),
          percentage:  parseFloat(wireCostPct.toFixed(1)),
          description: 'Cash paid to suppliers for wire this period',
          cogs_amount: parseFloat(salesSummary.cogs_wire_cost.toFixed(2)),
          cogs_note:   'cogs_amount = FIFO-matched cost of wire actually embedded in pieces sold this period — informational only, not used in the totals above',
          details:     wireCostDetails,
        },
        conversion_cost: {
          amount:      parseFloat(salesSummary.conversion_cost.toFixed(2)),
          percentage:  parseFloat(convCostPct.toFixed(1)),
          description: 'Labour costs (operator + knuckler + sack costs)',
          details:     conversionCostDetails,
        },
        transport_cost: {
          amount:      parseFloat(salesSummary.transport_to_market_cost.toFixed(2)),
          percentage:  parseFloat(transportCostPct.toFixed(1)),
          description: 'Transport to market — read from saved sale records (§11)',
          details:     transportCostDetails,
        },
        rent_cost: {
          amount:      parseFloat(rentCost.toFixed(2)),
          percentage:  salesSummary.revenue > 0 ? parseFloat((rentCost / salesSummary.revenue * 100).toFixed(1)) : 0,
          description: 'Rent accrued for this period (prorated by calendar overlap)',
          details:     rentDetails,
        },
        net_profit: {
          amount:      parseFloat(netProfit.toFixed(2)),
          percentage:  parseFloat(netProfitPct.toFixed(1)),
          description: 'Revenue − Cost of Sales − Rent Expense',
        },
      },
      insights: {
        total_pieces_sold:             salesSummary.pieces_sold,
        total_kgs_sold:                parseFloat(salesSummary.kgs_sold.toFixed(2)),
        avg_wire_cost_per_kg:          parseFloat(salesSummary.wire_cost_per_kg.toFixed(2)),
        avg_conversion_cost_per_piece: parseFloat(salesSummary.conversion_cost_per_piece.toFixed(2)),
        cost_per_piece:                salesSummary.pieces_sold > 0
          ? parseFloat((salesSummary.direct_costs / salesSummary.pieces_sold).toFixed(2))
          : 0,
      },
    });
  } catch (e) {
    console.error('GET /revenue-breakdown error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

function csvRow(arr) {
  return arr.map(v => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',');
}

function buildCsv(headers, rows) {
  const BOM = '\uFEFF';
  return BOM + [headers, ...rows].map(r => csvRow(r)).join('\r\n');
}

function sendCsv(res, filename, headers, rows) {
  const csv = buildCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// GET /api/export/purchases
router.get('/export/purchases', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    const purchases = await db.prepare(`
      SELECT p.id, p.entry_date, s.name AS supplier, p.gauge,
             p.kgs_bought, p.cost_per_kg,
             ROUND((p.kgs_bought * p.cost_per_kg), 2)                          AS wire_cost,
             p.transport_cost,
             ROUND((p.kgs_bought * p.cost_per_kg + p.transport_cost), 2)       AS total_cost,
             ROUND(((p.kgs_bought * p.cost_per_kg + p.transport_cost)
                    / NULLIF(p.kgs_bought, 0)), 2)                              AS landed_per_kg,
             u.full_name AS entered_by, p.created_at
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      JOIN users u ON p.entered_by = u.id
      WHERE p.entry_date BETWEEN ? AND ?
      ORDER BY p.entry_date ASC, p.id ASC
    `).all(from, to);

    const allPayments = await db.prepare(`
      SELECT payee_supplier_id, ROUND(SUM(amount), 2) AS total_paid
      FROM payments WHERE category = 'supplier'
      GROUP BY payee_supplier_id
    `).all();
    const supplierPaidMap = {};
    for (const p of allPayments) supplierPaidMap[p.payee_supplier_id] = parseFloat(p.total_paid) || 0;

    const allPurchases = await db.prepare(`
      SELECT id, supplier_id, entry_date,
             ROUND((kgs_bought * cost_per_kg + transport_cost), 2) AS total_cost
      FROM purchases ORDER BY entry_date ASC, id ASC
    `).all();

    // FIFO allocation per supplier
    const purchaseAlloc = {};
    const supplierIds   = [...new Set(allPurchases.map(p => p.supplier_id))];
    for (const sid of supplierIds) {
      let pool = supplierPaidMap[sid] || 0;
      for (const p of allPurchases.filter(x => x.supplier_id === sid)) {
        const cost    = parseFloat(p.total_cost) || 0;
        const applied = Math.min(pool, cost);
        const balance = parseFloat((cost - applied).toFixed(2));
        pool          = parseFloat((pool - applied).toFixed(2));
        const status  = applied <= 0 ? 'Unpaid' : balance <= 0.01 ? 'Fully Paid' : 'Partially Paid';
        purchaseAlloc[p.id] = { amount_paid: parseFloat(applied.toFixed(2)), balance, status };
      }
    }

    const headers = [
      'Date', 'Supplier', 'Gauge', 'Kgs Bought', 'Cost/kg', 'Wire Cost', 'Transport',
      'Total Cost', 'Landed/kg', 'Amount Paid', 'Balance', 'Payment Status',
      'Entered By', 'Created At',
    ];
    sendCsv(res, `imara_purchases_${from}_to_${to}.csv`, headers,
      purchases.map(r => {
        const alloc = purchaseAlloc[r.id] || { amount_paid: 0, balance: parseFloat(r.total_cost) || 0, status: 'Unpaid' };
        return [
          r.entry_date, r.supplier, r.gauge, r.kgs_bought, r.cost_per_kg,
          r.wire_cost, r.transport_cost, r.total_cost, r.landed_per_kg,
          alloc.amount_paid, alloc.balance, alloc.status,
          r.entered_by, r.created_at,
        ];
      })
    );
  } catch (e) {
    console.error('Export purchases error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/sales
router.get('/export/sales', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    const pieceTypes = {};
    const userNames  = {};
    for (const p of await db.prepare('SELECT id, name FROM piece_types').all())
      pieceTypes[p.id] = p.name;
    for (const u of await db.prepare('SELECT id, full_name FROM users').all())
      userNames[u.id] = u.full_name;

    const invoices = await db.prepare(`
      SELECT id, invoice_number, invoice_date, customer_name,
             total_amount, amount_paid, status, tax_amount, notes
      FROM invoices
      WHERE invoice_date BETWEEN ? AND ?
      ORDER BY invoice_date DESC, id DESC
    `).all(from, to);

    const allItems = await db.prepare(`
      SELECT ii.invoice_id, ii.piece_type_id,
             COALESCE(ii.gauge,'') AS gauge,
             ii.quantity, ii.unit_price, ii.line_total
      FROM invoice_items ii
    `).all();
    const itemsByInv = {};
    for (const it of allItems) {
      if (!itemsByInv[it.invoice_id]) itemsByInv[it.invoice_id] = [];
      itemsByInv[it.invoice_id].push(it);
    }

    const allPmts = await db.prepare(`
      SELECT invoice_id, payment_date, amount, payment_method, notes
      FROM invoice_payments ORDER BY payment_date ASC, created_at ASC
    `).all();
    const pmtsByInv = {};
    for (const p of allPmts) {
      if (!pmtsByInv[p.invoice_id]) pmtsByInv[p.invoice_id] = [];
      pmtsByInv[p.invoice_id].push(p);
    }

    function statusLabel(inv) {
      if (inv.status === 'cancelled') return 'Cancelled';
      const bal = parseFloat(inv.total_amount) - parseFloat(inv.amount_paid);
      if (bal <= 0.01) return 'Fully Paid';
      if (parseFloat(inv.amount_paid) > 0) return 'Partial Payment';
      return 'Unpaid';
    }

    const headers = [
      'Invoice #', 'Date', 'Customer', 'Piece Types', 'Gauges', 'Total Qty',
      'Tax (KES)', 'Invoice Total (KES)', 'Amount Paid (KES)', 'Balance (KES)',
      'Payment Status', 'Payment History', 'Notes',
    ];
    sendCsv(res, `imara_sales_${from}_to_${to}.csv`, headers,
      invoices.map(inv => {
        const items       = itemsByInv[inv.id] || [];
        const pmts        = pmtsByInv[inv.id]  || [];
        const total       = parseFloat(inv.total_amount) || 0;
        const paid        = parseFloat(inv.amount_paid)  || 0;
        const bal         = parseFloat(Math.max(0, total - paid).toFixed(2));
        const pieceList   = items.map(it => pieceTypes[it.piece_type_id] || '').filter(Boolean).join('; ');
        const gaugeList   = [...new Set(items.map(it => it.gauge).filter(Boolean))].join('; ');
        const totalQty    = items.reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
        const pmtHistory  = pmts.length
          ? pmts.map(p => `${p.payment_date}: KES ${parseFloat(p.amount).toFixed(2)} via ${p.payment_method}${p.notes ? ` (${p.notes})` : ''}`).join(' | ')
          : '';
        return [
          inv.invoice_number, inv.invoice_date, inv.customer_name,
          pieceList, gaugeList, totalQty,
          parseFloat(inv.tax_amount) || 0, total, paid, bal,
          statusLabel(inv), pmtHistory, inv.notes || '',
        ];
      })
    );
  } catch (e) {
    console.error('Export sales error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/production
router.get('/export/production', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const rows = await db.prepare(`
      SELECT pr.entry_date, pr.gauge, pr.kgs_used,
             GROUP_CONCAT(pt.name || ' x' || pi.pieces_produced, ', ') AS items,
             u_op.full_name AS operator, u_kn.full_name AS knuckler,
             pr.operator_cost, pr.knuckler_cost, pr.sack_cost, pr.total_cost,
             u_en.full_name AS entered_by, pr.created_at
      FROM production pr
      LEFT JOIN production_items pi ON pi.production_id = pr.id
      LEFT JOIN piece_types pt ON pi.piece_type_id = pt.id
      LEFT JOIN users u_op ON pr.operator_id = u_op.id
      LEFT JOIN users u_kn ON pr.knuckler_id = u_kn.id
      JOIN users u_en ON pr.entered_by = u_en.id
      WHERE pr.entry_date BETWEEN ? AND ?
      GROUP BY pr.id, pr.entry_date, pr.gauge, pr.kgs_used, u_op.full_name, u_kn.full_name,
               pr.operator_cost, pr.knuckler_cost, pr.sack_cost, pr.total_cost, u_en.full_name, pr.created_at
      ORDER BY pr.entry_date DESC, pr.id DESC
    `).all(from, to);
    const headers = [
      'Date', 'Gauge', 'Kgs Used', 'Items Produced', 'Operator', 'Knuckler',
      'Operator Cost', 'Knuckler Cost', 'Sack Cost', 'Total Cost', 'Entered By', 'Created At',
    ];
    sendCsv(res, `imara_production_${from}_to_${to}.csv`, headers,
      rows.map(r => [
        r.entry_date, r.gauge, r.kgs_used, r.items, r.operator, r.knuckler,
        r.operator_cost, r.knuckler_cost, r.sack_cost, r.total_cost,
        r.entered_by, r.created_at,
      ])
    );
  } catch (e) {
    console.error('Export production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/gauge-analysis
router.get('/export/gauge-analysis', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const gauges = (await db.prepare(`
      SELECT DISTINCT gauge FROM purchases WHERE gauge != '' AND entry_date BETWEEN ? AND ?
      UNION
      SELECT DISTINCT gauge FROM production WHERE gauge != '' AND entry_date BETWEEN ? AND ?
      UNION
      SELECT DISTINCT gauge_source FROM sales WHERE gauge_source != '' AND entry_date BETWEEN ? AND ?
    `).all(from, to, from, to, from, to)).map(r => r.gauge || r.gauge_source).filter(Boolean);

    const rows = [];
    for (const gauge of gauges) {
      const b = await db.prepare(
        `SELECT COALESCE(SUM(kgs_bought),0) AS v
         FROM purchases WHERE gauge=? AND entry_date BETWEEN ? AND ?`
      ).get(gauge, from, to);
      const p = await db.prepare(
        `SELECT COALESCE(SUM(kgs_used),0) AS kgs, COALESCE(SUM(pi.pieces_produced),0) AS pcs,
                COALESCE(SUM(total_cost - operator_cost - knuckler_cost - sack_cost - rent_allocation),0) AS wire_cost
         FROM production pr LEFT JOIN production_items pi ON pi.production_id=pr.id
         WHERE pr.gauge=? AND pr.entry_date BETWEEN ? AND ?`
      ).get(gauge, from, to);
      const s = await db.prepare(
        `SELECT COALESCE(SUM(quantity),0) AS pcs, COALESCE(SUM(quantity*selling_price),0) AS rev
         FROM sales WHERE gauge_source=? AND entry_date BETWEEN ? AND ?`
      ).get(gauge, from, to);
      rows.push([
        gauge,
        parseFloat(b.v)         || 0, parseFloat(p.wire_cost) || 0,
        parseFloat(p.kgs)       || 0, parseInt(p.pcs)         || 0,
        parseInt(s.pcs)         || 0, parseFloat(s.rev)       || 0,
        parseFloat(((parseFloat(b.v) || 0) - (parseFloat(p.kgs) || 0)).toFixed(2)),
        Math.max(0, (parseInt(p.pcs) || 0) - (parseInt(s.pcs) || 0)),
      ]);
    }
    const headers = [
      'Gauge', 'Kgs Purchased', 'Wire Cost (KES)', 'Kgs Used in Production',
      'Pieces Produced', 'Pieces Sold', 'Revenue (KES)', 'Kgs in Stock', 'Pieces in Stock',
    ];
    sendCsv(res, `imara_gauge_analysis_${from}_to_${to}.csv`, headers, rows);
  } catch (e) {
    console.error('Export gauge-analysis error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/invoices
router.get('/export/invoices', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const rows = await db.prepare(`
      SELECT i.invoice_number, i.invoice_date, i.due_date, i.customer_name,
             i.customer_phone,
             CASE
               WHEN i.status = 'paid'            THEN 'Fully Paid'
               WHEN i.status = 'partial_payment' AND i.amount_paid > 0 THEN 'Partially Paid'
               WHEN i.status = 'partial_payment' THEN 'Unpaid'
               WHEN i.status = 'cancelled'        THEN 'Cancelled'
               ELSE i.status
             END                                                  AS payment_status,
             i.subtotal, i.discount_amount, i.tax_amount, i.total_amount,
             ROUND(i.amount_paid, 2)                              AS amount_paid,
             ROUND((i.total_amount - i.amount_paid), 2)           AS balance,
             u.full_name AS created_by, i.notes
      FROM invoices i JOIN users u ON i.created_by = u.id
      WHERE i.invoice_date BETWEEN ? AND ?
      ORDER BY i.invoice_date DESC, i.id DESC
    `).all(from, to);
    const headers = [
      'Invoice #', 'Date', 'Due Date', 'Customer', 'Phone', 'Payment Status',
      'Subtotal', 'Discount', 'Tax', 'Total', 'Amount Paid', 'Balance', 'Created By', 'Notes',
    ];
    sendCsv(res, `imara_invoices_${from}_to_${to}.csv`, headers,
      rows.map(r => [
        r.invoice_number, r.invoice_date, r.due_date, r.customer_name, r.customer_phone,
        r.payment_status, r.subtotal, r.discount_amount, r.tax_amount,
        r.total_amount, r.amount_paid, r.balance, r.created_by, r.notes,
      ])
    );
  } catch (e) {
    console.error('Export invoices error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/sales-xlsx
router.get('/export/sales-xlsx', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    const pieceTypes = {};
    for (const p of await db.prepare('SELECT id, name FROM piece_types').all())
      pieceTypes[p.id] = p.name;
    const userNames = {};
    for (const u of await db.prepare('SELECT id, full_name FROM users').all())
      userNames[u.id] = u.full_name;

    const invoices = await db.prepare(`
      SELECT id, invoice_number, invoice_date, due_date,
             customer_name, customer_phone,
             subtotal, discount_amount, tax_amount, total_amount,
             amount_paid, status, notes, created_by
      FROM invoices
      WHERE invoice_date BETWEEN ? AND ?
      ORDER BY invoice_date DESC, id DESC
    `).all(from, to);

    const allItems = await db.prepare(`
      SELECT invoice_id, piece_type_id, COALESCE(gauge,'') AS gauge,
             description, quantity, unit_price, line_total
      FROM invoice_items ORDER BY id ASC
    `).all();
    const itemsByInv = {};
    for (const it of allItems) {
      if (!itemsByInv[it.invoice_id]) itemsByInv[it.invoice_id] = [];
      itemsByInv[it.invoice_id].push(it);
    }

    const allPmts = await db.prepare(`
      SELECT invoice_id, payment_date, amount, payment_method, notes
      FROM invoice_payments ORDER BY payment_date ASC, created_at ASC
    `).all();
    const pmtsByInv = {};
    for (const p of allPmts) {
      if (!pmtsByInv[p.invoice_id]) pmtsByInv[p.invoice_id] = [];
      pmtsByInv[p.invoice_id].push(p);
    }

    function statusLabel(inv) {
      if (inv.status === 'cancelled') return 'Cancelled';
      const bal = parseFloat(inv.total_amount) - parseFloat(inv.amount_paid);
      if (bal <= 0.01) return 'Fully Paid';
      if (parseFloat(inv.amount_paid) > 0) return 'Partial Payment';
      return 'Unpaid';
    }

    const headers = [
      'Invoice #', 'Date', 'Due Date', 'Customer', 'Phone',
      'Piece Type', 'Gauge', 'Qty', 'Unit Price (KES)', 'Line Total (KES)',
      'Subtotal (KES)', 'Discount (KES)', 'Tax (KES)', 'Invoice Total (KES)',
      'Amount Paid (KES)', 'Balance (KES)', 'Payment Status',
      'Payment History', 'Generated By',
    ];

    const rows = [];
    for (const inv of invoices) {
      const items  = itemsByInv[inv.id] || [null];
      const pmts   = pmtsByInv[inv.id]  || [];
      const total  = parseFloat(inv.total_amount) || 0;
      const paid   = parseFloat(inv.amount_paid)  || 0;
      const bal    = parseFloat(Math.max(0, total - paid).toFixed(2));
      const pmtHistory = pmts.length
        ? pmts.map(p =>
            `${p.payment_date}: KES ${parseFloat(p.amount).toFixed(2)} via ${p.payment_method}${p.notes ? ` (${p.notes})` : ''}`
          ).join(' | ')
        : '';
      const status      = statusLabel(inv);
      const generatedBy = userNames[inv.created_by] || '';

      for (const item of items) {
        rows.push([
          inv.invoice_number, inv.invoice_date, inv.due_date || '',
          inv.customer_name, inv.customer_phone || '',
          item ? (pieceTypes[item.piece_type_id] || item.description || '') : '',
          item ? item.gauge      : '',
          item ? item.quantity   : '',
          item ? item.unit_price : '',
          item ? item.line_total : '',
          parseFloat(inv.subtotal)        || 0,
          parseFloat(inv.discount_amount) || 0,
          parseFloat(inv.tax_amount)      || 0,
          total, paid, bal,
          status, pmtHistory, generatedBy,
        ]);
      }
    }

    sendCsv(res, `imara_sales_detailed_${from}_to_${to}.csv`, headers, rows);
  } catch (e) {
    console.error('Export sales-xlsx error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


module.exports = router;
module.exports.writeNotification   = writeNotification;
module.exports.checkAndNotifyStock = checkAndNotifyStock;

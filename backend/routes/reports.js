// routes/reports.js
const router = require('express').Router();
const { getDb }  = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');

// ── Notification writer — call after any event that should alert the owner ────
// Safe: never throws, never blocks the main request flow.
async function writeNotification(db, { userId, roleTarget, type, category, message, title }) {
  try {
    // Explicitly write created_at as a UTC ISO string (ends in 'Z') so browsers
    // parse it unambiguously. SQLite's CURRENT_TIMESTAMP default stores without the
    // 'Z' suffix, which causes some browsers to treat it as local time instead of UTC,
    // making relative-time display ("3h ago") wrong.
    const now = new Date().toISOString(); // e.g. "2025-05-02T10:30:00.000Z"
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
  } catch(_) { /* never block the caller */ }
}

// ── Check and write stock notifications after any production or sales write ───
async function checkAndNotifyStock(db, enteredBy) {
  try {
    const threshold = parseFloat((await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100);

    // Helper: only write if same title wasn't written in the last 60 minutes
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

    // Raw material check — per gauge (aggregate check misses gauge-specific stock-outs)
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

    // Fall back to aggregate check if the per-gauge query fails (e.g. no data)
    if (gaugeStocks && gaugeStocks.length > 0) {
      for (const gs of gaugeStocks) {
        const remaining = parseFloat(gs.bought) - parseFloat(gs.used);
        const label = gs.gauge ? `Wire (${gs.gauge})` : 'Wire';
        if (remaining <= 0) {
          await writeIfNew('alert', `${label} Stock — OUT`,
            `${label} stock is depleted (${remaining.toFixed(1)} kg). Production for this gauge is now blocked. Restock immediately.`);
        } else if (remaining <= threshold) {
          await writeIfNew('warn', `${label} Stock Low`,
            `Only ${remaining.toFixed(1)} kg of ${label.toLowerCase()} remaining (threshold: ${threshold} kg). Plan a restock soon.`);
        }
      }
    } else {
      // Aggregate fallback
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

    // Finished goods check — per piece-type AND gauge (aggregating across gauges can mask real stock-outs)
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
      const avail = parseInt(item.available) || 0;
      const gaugeLabel = item.gauge ? ` (${item.gauge})` : '';
      const itemLabel = `${item.name}${gaugeLabel}`;
      if (avail === 0) {
        await writeIfNew('alert', `Stock-Out: ${itemLabel}`,
          `${itemLabel} is completely out of stock.`);
      } else {
        await writeIfNew('warn', `Low Stock: ${itemLabel}`,
          `${itemLabel} has only ${avail} piece${avail === 1 ? '' : 's'} remaining.`);
      }
    }
  } catch(_) {}
}


async function getLandingCost(db, pt) {
  const getCfg = async key => parseFloat((await db.prepare('SELECT value FROM config WHERE key=?').get(key))?.value || 0);
  // Use weighted landed wire cost (includes transport) for accuracy
  const wireCostPerKg = await getWeightedWireCostPerKg(db);
  const operator  = await getCfg('operator_cost');
  const knuckler  = await getCfg('knuckler_cost');
  const sack      = await getCfg('sack_cost');
  return (wireCostPerKg * pt.weight_kg) + operator + knuckler + (sack * 2);
}

async function getCfgNumber(db, key) {
  return parseFloat((await db.prepare('SELECT value FROM config WHERE key=?').get(key))?.value || 0);
}

async function getWeightedWireCostPerKg(db, toDate) {
  // Use landed cost: (kgs_bought * cost_per_kg + transport_cost) / kgs_bought
  // This matches the daily.js formula so wire cost is consistent across all modules.
  const sql = `
    SELECT
      COALESCE(SUM(kgs_bought * cost_per_kg + transport_cost), 0) AS total_landed_cost,
      COALESCE(SUM(kgs_bought), 0) AS total_kgs
    FROM purchases
    ${toDate ? 'WHERE entry_date <= ?' : ''}
  `;
  const totals = toDate ? await db.prepare(sql).get(toDate) : await db.prepare(sql).get();
  if (totals.total_kgs > 0) return totals.total_landed_cost / totals.total_kgs;
  return getCfgNumber(db, 'cost_per_kg');
}

async function getSalesCostSummary(db, fromDate, toDate) {
  const wireCostPerKg          = await getWeightedWireCostPerKg(db, toDate);
  const operatorRate           = await getCfgNumber(db, 'operator_cost');
  const knucklerRate           = await getCfgNumber(db, 'knuckler_cost');
  const sackRate               = await getCfgNumber(db, 'sack_cost');
  const conversionCostPerPiece = operatorRate + knucklerRate + (sackRate * 2);

  // CASH-BASIS: revenue = money actually received from customers in this period
  const cashReceived = await db.prepare(`
    SELECT COALESCE(SUM(ip.amount),0) AS total
    FROM invoice_payments ip
    JOIN invoices i ON ip.invoice_id = i.id
    WHERE ip.payment_date BETWEEN ? AND ?
      AND i.status != 'cancelled'
  `).get(fromDate, toDate);
  const revenue = parseFloat(cashReceived.total) || 0;

  // COST OF PRODUCTION — ACCRUAL BASIS (fixed at time of sale, NEVER changes with payments)
  // Rule: production cost is what it cost to make the goods we SOLD (invoiced) in this period.
  // It does not scale with how much the customer has paid — production already happened.
  // Example: Sold item for 1000, cost 500 → cost is ALWAYS 500 whether paid 400 or 1000.
  //
  // We look at sales (not invoice_payments) in this date range for cost calculation.
  const costRows = await db.prepare(`
    SELECT
      s.quantity,
      pt.weight_kg,
      COALESCE(s.transport_to_market, 0) AS transport_to_market
    FROM sales s
    JOIN piece_types pt ON pt.id = s.piece_type_id
    WHERE s.entry_date BETWEEN ? AND ?
  `).all(fromDate, toDate);

  let piecesSold = 0, kgsSold = 0, transportCost = 0;
  for (const row of costRows) {
    const qty       = parseInt(row.quantity, 10) || 0;
    const wkg       = parseFloat(row.weight_kg) || 0;
    const transport = parseFloat(row.transport_to_market) || 0;
    piecesSold    += qty;
    kgsSold       += qty * wkg;
    transportCost += transport;
  }

  const wireCost       = kgsSold * wireCostPerKg;
  const conversionCost = piecesSold * conversionCostPerPiece;
  const directCosts    = wireCost + conversionCost + transportCost;

  // Net profit = cash received (revenue) minus full production cost of sold goods.
  // When invoice is partial: revenue is low, cost is fixed → net profit is lower. Correct.
  // When invoice is fully paid: revenue rises to full, cost stays same → profit normalises.
  const grossProfit = revenue - directCosts;

  return {
    revenue, pieces_sold: piecesSold, kgs_sold: kgsSold,
    weighted_wire_cost_per_kg: wireCostPerKg,
    operator_rate: operatorRate, knuckler_rate: knucklerRate, sack_rate: sackRate,
    conversion_cost_per_piece: conversionCostPerPiece,
    wire_cost: wireCost, conversion_cost: conversionCost,
    transport_to_market_cost: transportCost, direct_costs: directCosts, gross_profit: grossProfit,
  };
}

function toUtcDateParts(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

// Safe UTC date string — avoids timezone-shift bugs that toISOString() causes
// in non-UTC environments (e.g. Nairobi UTC+3).  Always returns 'YYYY-MM-DD'.
function utcDateStr(d) {
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

async function getAccruedRentForRange(db, fromDate, toDate) {
  const from   = toUtcDateParts(fromDate);
  const to     = toUtcDateParts(toDate);
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
    const overlapDays  = Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
    const dailyRent    = (parseFloat(row.amount_due) || 0) / daysInMonth(year, month - 1);
    rent += dailyRent * overlapDays;
  }
  return rent;
}

// ── Inventory ─────────────────────────────────────────────────────────────────
router.get('/inventory', authenticate, requireRole('owner','admin'), async (_req, res) => {
  try {
    const db          = getDb();
    const totalBought = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const totalUsed   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;

    const expectedUsed = (await db.prepare(`
      SELECT SUM(pi.pieces_produced * pt.weight_kg) AS v
      FROM production_items pi JOIN piece_types pt ON pi.piece_type_id = pt.id
    `).get())?.v || 0;

    const usageEfficiency = totalUsed > 0
      ? parseFloat(((expectedUsed / totalUsed) * 100).toFixed(1)) : 0;
    const rawStock  = totalBought - totalUsed;
    const threshold = parseFloat((await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100);

    // GROUP BY pt.id is fine — pt.id is PK so it functionally determines all pt.* columns
    const pieceTypes = await db.prepare(`
      SELECT pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price,
             COALESCE(SUM(pi.pieces_produced),0) AS total_produced
      FROM piece_types pt
      LEFT JOIN production_items pi ON pi.piece_type_id=pt.id
      WHERE pt.active=1
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
        available_meters:   parseFloat((avail * (r.length_m || 0)).toFixed(2)),
        stock_value:      parseFloat((Math.max(0, avail) * r.default_price).toFixed(2)),
        landing_cost:     parseFloat(landingCost.toFixed(2)),
        suggested_price:  parseFloat((landingCost * 1.3).toFixed(2)),
      });
    }

    // Calculate proper stock turnover metrics (period-based)
    const totalSoldPieces = finished.reduce((sum, item) => sum + item.total_sold, 0);
    const totalAvailablePieces = finished.reduce((sum, item) => sum + item.available_pieces, 0);
    const totalStockValue = finished.reduce((sum, item) => sum + item.stock_value, 0);
    
    // Get recent sales for proper turnover calculation (last 90 days)
    const recentNow  = new Date();
    const recentDate = utcDateStr(new Date(Date.UTC(recentNow.getUTCFullYear(), recentNow.getUTCMonth(), recentNow.getUTCDate() - 90)));
    const recentSales = await db.prepare(`
      SELECT s.piece_type_id, SUM(s.quantity) as recent_sold, pt.default_price
      FROM sales s
      JOIN piece_types pt ON s.piece_type_id = pt.id
      WHERE s.entry_date >= ?
      GROUP BY s.piece_type_id, pt.default_price
    `).all(recentDate);
    
    // Calculate recent sold value
    let recentSoldValue = 0;
    let recentSoldPieces = 0;
    for (const sale of recentSales) {
      const item = finished.find(f => f.id === sale.piece_type_id);
      if (item) {
        recentSoldValue += sale.recent_sold * item.default_price;
        recentSoldPieces += sale.recent_sold;
      }
    }
    
    // Stock turnover ratio (times per year based on recent 90-day performance)
    let stockTurnoverRatio = 0;
    let stockTurnoverDays = 0;
    let turnoverTrend = 'stable';
    
    if (totalStockValue > 0 && recentSoldValue > 0) {
      // Annualize recent 90-day sales
      const annualizedSoldValue = (recentSoldValue / 90) * 365;
      stockTurnoverRatio = parseFloat((annualizedSoldValue / totalStockValue).toFixed(2));
      
      // Estimate days of inventory on hand (365 / turnover ratio)
      if (stockTurnoverRatio > 0) {
        stockTurnoverDays = Math.round(365 / stockTurnoverRatio);
      }
      
      // Determine trend
      if (stockTurnoverRatio >= 4) turnoverTrend = 'fast';
      else if (stockTurnoverRatio >= 2) turnoverTrend = 'good';
      else if (stockTurnoverRatio >= 1) turnoverTrend = 'slow';
      else turnoverTrend = 'very_slow';
    }
    
    // Calculate average days to sell (based on recent sales)
    let avgDaysToSell = 0;
    if (recentSoldPieces > 0 && totalAvailablePieces > 0) {
      // If current sales rate continues, how long to sell current stock?
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
      // New stock turnover metrics
      stock_turnover: {
        ratio: stockTurnoverRatio,
        days_on_hand: stockTurnoverDays,
        total_sold_pieces: totalSoldPieces,
        total_available_pieces: totalAvailablePieces,
        recent_sold_pieces_90days: recentSoldPieces,
        recent_sold_value_90days: parseFloat(recentSoldValue.toFixed(2)),
        avg_days_to_sell_current_stock: avgDaysToSell,
        turnover_trend: turnoverTrend,
        calculation_period: '90_days_annualized'
      }
    });
  } catch(e) {
    console.error('GET inventory error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Production Staff Inventory ────────────────────────────────────────────────────────
router.get('/inventory/worker', authenticate, async (req, res) => {
  try {
    const db          = getDb();
    const totalBought = (await db.prepare('SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases').get()).v;
    const totalUsed   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0)   AS v FROM production').get()).v;

    const expectedUsed = (await db.prepare(`
      SELECT SUM(pi.pieces_produced * pt.weight_kg) AS v
      FROM production_items pi JOIN piece_types pt ON pi.piece_type_id = pt.id
    `).get())?.v || 0;
    const usageEfficiency = totalUsed > 0
      ? parseFloat(((expectedUsed / totalUsed) * 100).toFixed(1)) : 0;
    const rawStock  = totalBought - totalUsed;
    const threshold = parseFloat((await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100);

    const pieceTypes = await db.prepare(`
      SELECT pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price,
             COALESCE(SUM(pi.pieces_produced),0) AS total_produced
      FROM piece_types pt
      LEFT JOIN production_items pi ON pi.piece_type_id=pt.id
      WHERE pt.active=1
      GROUP BY pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price
    `).all();

    const finished = [];
    for (const r of pieceTypes) {
      const sold  = (await db.prepare('SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id=?').get(r.id)).v;
      const avail = r.total_produced - sold;
      finished.push({
        id: r.id, name: r.name,
        available_pieces: avail,
        available_kgs:    parseFloat((avail * (r.weight_kg || 0)).toFixed(2)),
        available_meters:   parseFloat((avail * (r.length_m || 0)).toFixed(2)),
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
  } catch(e) {
    console.error('GET inventory/production-staff error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, requireRole('owner','admin'), async (req, res) => {
  // ACID: Start database transaction for consistency
  const db = getDb();
  
  try {
    const days = Math.min(Math.max(parseInt(req.query.period || 30), 1), 365);
    const granularity = req.query.granularity || 'auto'; // auto, day, week, month, quarter

    let fromDate, toDate;
    if (req.query.from && req.query.to) {
      fromDate = req.query.from;
      toDate   = req.query.to;
    } else {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));
    }

    // ACID: All reads within single transaction for consistency
    const salesSummary = await getSalesCostSummary(db, fromDate, toDate);
    const rentCost     = await getAccruedRentForRange(db, fromDate, toDate);
    const grossProfit  = salesSummary.gross_profit;              // revenue - direct costs (wire+labour+transport)
    const netProfit    = grossProfit - rentCost;                 // gross minus period rent (the true bottom line)
    const grossMargin  = salesSummary.revenue > 0 ? (grossProfit / salesSummary.revenue * 100) : 0;
    const netMargin    = salesSummary.revenue > 0 ? (netProfit   / salesSummary.revenue * 100) : 0;

    // FIX: cash-basis — only revenue actually received in this period
    const best = await db.prepare(`
      SELECT pt.name, ROUND(COALESCE(SUM(ip_agg.amount),0)::numeric,2) AS revenue
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

    // Best customers analytics — cash-basis: only money actually received.
    // FIX: revenue is summed at invoice level (ip.amount is already per-invoice aggregate).
    // pieces are summed via a separate LEFT JOIN subquery so the revenue column is never
    // multiplied by the number of invoice line items.
    const bestCustomers = await db.prepare(`
      SELECT
        COALESCE(NULLIF(i.customer_name,''), 'Anonymous') AS customer_name,
        COUNT(DISTINCT i.id)                               AS transaction_count,
        COALESCE(SUM(ii_qty.qty), 0)                       AS total_pieces,
        ROUND(COALESCE(SUM(ip.amount),0)::numeric, 2)      AS total_revenue
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
        FROM invoice_items
        GROUP BY invoice_id
      ) ii_qty ON ii_qty.invoice_id = i.id
      WHERE i.customer_name IS NOT NULL AND i.customer_name != ''
      GROUP BY i.customer_name
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(fromDate, toDate);

    // Gauge breakdown analytics — cash-basis, item-level split
    // When one invoice has multiple gauge items (e.g. G12 + G16), the payment received
    // is split proportionally by each line item's share of the invoice subtotal.
    // This prevents all revenue from a multi-gauge invoice being attributed to one gauge.
    const gaugeBreakdown = await db.prepare(`
      SELECT
        COALESCE(NULLIF(ii.gauge,''), 'Unknown') AS gauge_source,
        COUNT(DISTINCT ii.invoice_id)             AS transaction_count,
        CAST(SUM(ii.quantity) AS INTEGER)         AS total_pieces,
        ROUND(SUM(
          ip.amount * (ii.line_total / NULLIF(i.subtotal, 0))
        )::numeric, 2)                            AS total_revenue
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
    const threshold = parseFloat((await db.prepare("SELECT value FROM config WHERE key='stock_threshold'").get())?.value || 100);
    const prodVol   = (await db.prepare('SELECT COALESCE(SUM(kgs_used),0) AS v FROM production WHERE entry_date BETWEEN ? AND ?').get(fromDate, toDate)).v;

    const diffDays = Math.round((new Date(Date.UTC(...toDate.split('-').map(Number).map((v,i)=>i===1?v-1:v))) - new Date(Date.UTC(...fromDate.split('-').map(Number).map((v,i)=>i===1?v-1:v)))) / 86400000) + 1;

    // Intelligent trend calculation based on granularity
    const trends = [];
    
    // Determine optimal granularity
    let step, labelFormat, dateGrouping;
    if (diffDays <= 7) {
      step = 1; // Daily
      labelFormat = 'MM/dd';
      dateGrouping = 'DATE(entry_date)';
    } else if (diffDays <= 31) {
      step = Math.max(1, Math.floor(diffDays / 15)); // Grouped daily
      labelFormat = 'MM/dd';
      dateGrouping = 'DATE(entry_date)';
    } else if (diffDays <= 90) {
      step = 7; // Weekly
      labelFormat = 'MM/dd';
      dateGrouping = "DATE_TRUNC('week', entry_date)";
    } else if (diffDays <= 365) {
      step = 30; // Monthly
      labelFormat = 'MMM';
      dateGrouping = "DATE_TRUNC('month', entry_date)";
    } else {
      step = 90; // Quarterly
      labelFormat = 'MMM yy';
      dateGrouping = "DATE_TRUNC('quarter', entry_date)";
    }

    // Build date-bucket boundaries once, then fetch all raw rows in 3 parallel queries.
    // IMPORTANT: use Date.UTC throughout so Nairobi (UTC+3) and other non-UTC servers
    // don't shift dates by one day when converting back to strings.
    // Buckets are CALENDAR-ALIGNED: monthly snaps to month-start, weekly snaps to Monday.
    const buckets = [];
    const [sy, sm, sd] = fromDate.split('-').map(Number);
    const [ey, em, ed] = toDate.split('-').map(Number);
    const utcStart = new Date(Date.UTC(sy, sm - 1, sd));
    const utcEnd   = new Date(Date.UTC(ey, em - 1, ed));

    if (step >= 28) {
      // Monthly: snap to calendar month boundaries
      let cur = new Date(Date.UTC(sy, sm - 1, 1)); // first day of start month
      // If fromDate is not the 1st, start from that month still
      while (cur <= utcEnd) {
        const ds = utcDateStr(cur);
        // End = last day of this calendar month, clamped to utcEnd
        const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
        const de = utcDateStr(new Date(Math.min(monthEnd.getTime(), utcEnd.getTime())));
        // Only include bucket if it overlaps with [fromDate, toDate]
        if (de >= fromDate) {
          const effectiveDs = ds < fromDate ? fromDate : ds;
          buckets.push({ ds: effectiveDs, de });
        }
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
      }
    } else if (step === 7) {
      // Weekly: snap to Monday
      let cur = new Date(utcStart);
      // Snap back to the Monday of the start week
      const dayOfWeek = cur.getUTCDay(); // 0=Sun,1=Mon,...
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      cur.setUTCDate(cur.getUTCDate() + daysToMonday);
      while (cur <= utcEnd) {
        const ds = utcDateStr(cur);
        const weekEnd = new Date(cur.getTime() + 6 * 86400000);
        const de = utcDateStr(new Date(Math.min(weekEnd.getTime(), utcEnd.getTime())));
        if (de >= fromDate) {
          const effectiveDs = ds < fromDate ? fromDate : ds;
          buckets.push({ ds: effectiveDs, de });
        }
        cur.setUTCDate(cur.getUTCDate() + 7);
      }
    } else if (step > 1) {
      // Grouped daily (e.g., step=2 or 3 for 31-day range)
      for (let d = new Date(utcStart); d <= utcEnd; d.setUTCDate(d.getUTCDate() + step)) {
        const ds = utcDateStr(d);
        const de = utcDateStr(new Date(Math.min(d.getTime() + (step - 1) * 86400000, utcEnd.getTime())));
        buckets.push({ ds, de });
      }
    } else {
      // Daily: one bucket per day
      for (let d = new Date(utcStart); d <= utcEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = utcDateStr(d);
        buckets.push({ ds, de: ds });
      }
    }

    // 3 bulk queries in parallel — one per data series
    const [revRows, kgPRows, kgBRows] = await Promise.all([
      db.prepare(`
        SELECT LEFT(ip.payment_date, 10) AS d, COALESCE(SUM(ip.amount),0) AS v
        FROM invoice_payments ip
        JOIN invoices i ON ip.invoice_id = i.id
        WHERE LEFT(ip.payment_date,10) BETWEEN ? AND ?
          AND i.status != 'cancelled'
        GROUP BY LEFT(ip.payment_date, 10)
      `).all(fromDate, toDate),
      db.prepare(`
        SELECT LEFT(entry_date, 10) AS d, COALESCE(SUM(kgs_used),0) AS v
        FROM production WHERE LEFT(entry_date,10) BETWEEN ? AND ?
        GROUP BY LEFT(entry_date, 10)
      `).all(fromDate, toDate),
      db.prepare(`
        SELECT LEFT(entry_date, 10) AS d, COALESCE(SUM(kgs_bought),0) AS v
        FROM purchases WHERE LEFT(entry_date,10) BETWEEN ? AND ?
        GROUP BY LEFT(entry_date, 10)
      `).all(fromDate, toDate),
    ]);

    const revMap  = Object.fromEntries(revRows.map(r  => [String(r.d), parseFloat(r.v) || 0]));
    const kgPMap  = Object.fromEntries(kgPRows.map(r  => [String(r.d), parseFloat(r.v) || 0]));
    const kgBMap  = Object.fromEntries(kgBRows.map(r  => [String(r.d), parseFloat(r.v) || 0]));

    // Aggregate into buckets
    for (const { ds, de } of buckets) {
      let rev = 0, kgP = 0, kgB = 0;
      const [bs, bm, bd2] = ds.split('-').map(Number);
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
          const d0 = new Date(Date.UTC(...ds.split('-').map(Number).map((v,i)=>i===1?v-1:v)));
          if (step >= 28) {
            // Monthly: show "Apr 2026" or just "Apr" if within same year
            return d0.toLocaleDateString('en-US', { month: 'short', year: diffDays > 365 ? '2-digit' : undefined, timeZone: 'UTC' });
          } else if (step === 7) {
            // Weekly: show "Apr 7" (week start)
            return d0.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
          } else {
            return d0.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
          }
        })(),
        revenue:       parseFloat(rev.toFixed(2)),
        kgs_produced:  parseFloat(kgP.toFixed(2)),
        kgs_purchased: parseFloat(kgB.toFixed(2)),
      });
    }

    res.json({
      period_days: days, from: fromDate, to: toDate,
      granularity: {
        unit: diffDays <= 7 ? 'day' : diffDays <= 31 ? 'day' : diffDays <= 90 ? 'week' : diffDays <= 365 ? 'month' : 'quarter',
        step: step,
        label: diffDays <= 7 ? 'Daily' : diffDays <= 31 ? 'Daily' : diffDays <= 90 ? 'Weekly' : diffDays <= 365 ? 'Monthly' : 'Quarterly',
        total_points: trends.length
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
        sold_wire_cost:            parseFloat(salesSummary.wire_cost.toFixed(2)),
        sold_conversion_cost:      parseFloat(salesSummary.conversion_cost.toFixed(2)),
        sales_transport_cost:      parseFloat(salesSummary.transport_to_market_cost.toFixed(2)),
        weighted_wire_cost_per_kg: parseFloat(salesSummary.weighted_wire_cost_per_kg.toFixed(2)),
        conversion_cost_per_piece: parseFloat(salesSummary.conversion_cost_per_piece.toFixed(2)),
        total_pieces_sold:         salesSummary.pieces_sold,
        total_kgs_sold:            parseFloat(salesSummary.kgs_sold.toFixed(2)),
        total_kgs_produced:        parseFloat(prodVol.toFixed(2)),
        raw_stock_kg:              parseFloat(rawStock.toFixed(2)),
        low_stock:                 rawStock < threshold,
        best_piece:                best?.name || '—',
        best_piece_revenue:        parseFloat(best?.revenue || 0),
        best_customer:             bestCustomers[0]?.customer_name || '—',
        best_customer_revenue:     parseFloat(bestCustomers[0]?.total_revenue || 0),
      },
      trends,
      analytics: {
        best_customers: bestCustomers,
        gauge_breakdown: gaugeBreakdown,
      },
      // ── Owner Dashboard KPI additions ─────────────────────────────────────
      // All figures are PERIOD-FILTERED to fromDate/toDate for slicer accuracy
      summary: await (async () => {
        // Receivables: invoices created in this period that still have an outstanding balance
        const invRow = await db.prepare(`
          SELECT
            COUNT(*)                                               AS count,
            COALESCE(SUM(total_amount), 0)                        AS total_amount,
            COALESCE(SUM(amount_paid), 0)                         AS paid_amount,
            COALESCE(SUM(total_amount - amount_paid), 0)          AS outstanding_amount,
            COUNT(*) FILTER(WHERE status = 'partial_payment')     AS partial_count
          FROM invoices
          WHERE invoice_date BETWEEN ? AND ?
            AND status NOT IN ('paid', 'cancelled')
            AND total_amount > amount_paid
        `).get(fromDate, toDate);

        // Payables: costs INCURRED in this period minus payments made in this period
        // 1. Supplier wire: purchases entered in period vs supplier payments made in period
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

        // 2. Wages: labour costs from production entries in period vs wage payments in period
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

        // 3. Rent: accrued rent for period vs rent payments made in period
        const rentDue = await db.prepare(`
          SELECT COALESCE(SUM(amount_due), 0) AS total
          FROM rent_months WHERE month BETWEEN ? AND ?
        `).get(fromDate.slice(0,7), toDate.slice(0,7));
        const rentPaid = await db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM payments WHERE category = 'rent' AND payment_date BETWEEN ? AND ?
        `).get(fromDate, toDate);
        const rentOutstanding = Math.max(0,
          parseFloat(rentDue.total) - parseFloat(rentPaid.total)
        );

        // 4. Sack costs: from production in period vs sack payments in period
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
          (supplierOutstanding + wagesOutstanding + rentOutstanding + sackOutstanding).toFixed(2)
        );

        return {
          invoices: {
            count:              parseInt(invRow.count)               || 0,
            total_amount:       parseFloat(invRow.total_amount)      || 0,
            paid_amount:        parseFloat(invRow.paid_amount)       || 0,
            outstanding_amount: parseFloat(invRow.outstanding_amount) || 0,
            partial_count:      parseInt(invRow.partial_count)       || 0,
          },
          purchases: {
            supplier_outstanding: supplierOutstanding,
            wages_outstanding:    wagesOutstanding,
            rent_outstanding:     rentOutstanding,
            sack_outstanding:     sackOutstanding,
            outstanding_payable:  totalOutstanding,
          },
        };
      })(),
    });
  } catch(e) {
    console.error('GET dashboard error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Production Staff Summary ──────────────────────────────────────────────────────────
router.get('/worker-summary', authenticate, async (req, res) => {
  try {
    const db   = getDb();
    const days = Math.min(parseInt(req.query.period || 30), 365);
    const now  = new Date();
    const from = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));

    const myPurchases  = await db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(kgs_bought),0) as kgs FROM purchases  WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);
    const myProduction = await db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(kgs_used),0)   as kgs FROM production WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);
    const mySales      = await db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(quantity*selling_price),0) as rev FROM sales WHERE entered_by=? AND entry_date>=?').get(req.user.id, from);

    res.json({
      period_days:   days,
      my_purchases:  { count: myPurchases.c,  total_kgs:     parseFloat((myPurchases.kgs||0).toFixed(2)) },
      my_production: { count: myProduction.c, total_kgs:     parseFloat((myProduction.kgs||0).toFixed(2)) },
      my_sales:      { count: mySales.c,      total_revenue: parseFloat((mySales.rev||0).toFixed(2)) },
    });
  } catch(e) {
    console.error('GET production-staff-summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Config ────────────────────────────────────────────────────────────────────
const ALLOWED_KEYS = [
  'cost_per_kg','transport_cost','transport_to_market','operator_cost','knuckler_cost',
  'sack_cost','rent_allocation','stock_threshold','wire_gauges',
  'business_name','business_slogan','currency',
  'invoice_prefix','invoice_tax_pct',   // used by invoices.js for number generation & tax
];

router.get('/config', authenticate, async (_req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare('SELECT key,value FROM config').all();
    const cfg  = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json(cfg);
  } catch(e) {
    console.error('GET config error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/config', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db = getDb();
    for (const [key, value] of Object.entries(req.body)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      await db.prepare(
        "INSERT INTO config(key,value,updated_by,updated_at) VALUES(?,?,?,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()"
      ).run(key, String(value), req.user.id);
      await writeAudit(db, { userId: req.user.id, action: 'CONFIG_UPDATE', table: 'config', newVals: { key, value }, ip: req.ip });
    }
    const rows = await db.prepare('SELECT key,value FROM config').all();
    const cfg  = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json({ message: 'Config updated', config: cfg });
  } catch(e) {
    console.error('PUT config error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Piece types ───────────────────────────────────────────────────────────────
router.get('/piece-types', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare('SELECT * FROM piece_types WHERE active=1 ORDER BY name').all());
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/piece-types', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const { name, length_m, weight_kg, default_price } = req.body;
    if (!name || !length_m || !weight_kg)
      return res.status(400).json({ error: 'name, length_m, weight_kg required' });
    if (parseFloat(length_m) <= 0) return res.status(400).json({ error: 'length_m must be > 0' });
    if (parseFloat(weight_kg) <= 0) return res.status(400).json({ error: 'weight_kg must be > 0' });

    const db    = getDb();
    const price = parseFloat(default_price) || 0;
    // FIX: RETURNING id
    const r = await db.prepare(
      'INSERT INTO piece_types(name,length_m,weight_kg,default_price) VALUES(?,?,?,?) RETURNING id'
    ).run(name, length_m, weight_kg, price);
    res.status(201).json({ id: r.lastInsertRowid, name, length_m, weight_kg, default_price: price, active: 1 });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Piece type name already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/piece-types/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const { name, length_m, weight_kg, default_price } = req.body;
    if (!name || !length_m || !weight_kg)
      return res.status(400).json({ error: 'name, length_m, weight_kg required' });
    const db       = getDb();
    const existing = await db.prepare('SELECT id FROM piece_types WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Piece type not found' });

    const price = parseFloat(default_price) || 0;
    await db.prepare('UPDATE piece_types SET name=?,length_m=?,weight_kg=?,default_price=? WHERE id=?')
      .run(name, length_m, weight_kg, price, req.params.id);
    res.json({ message: 'Updated', id: req.params.id, name, length_m, weight_kg, default_price: price });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/piece-types/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db      = getDb();
    const pieceId = parseInt(req.params.id, 10);
    const existing = await db.prepare('SELECT * FROM piece_types WHERE id=?').get(pieceId);
    if (!existing) return res.status(404).json({ error: 'Piece type not found' });

    const usedInProduction = (await db.prepare('SELECT COUNT(*) as c FROM production_items WHERE piece_type_id=?').get(pieceId)).c;
    const usedInSales      = (await db.prepare('SELECT COUNT(*) as c FROM sales WHERE piece_type_id=?').get(pieceId)).c;
    if (usedInProduction > 0 || usedInSales > 0)
      return res.status(400).json({ error: 'Piece type cannot be deleted because it is already used in system records' });

    await db.prepare('DELETE FROM piece_types WHERE id=?').run(pieceId);
    await writeAudit(db, { userId: req.user.id, action: 'DELETE_PIECE_TYPE', table: 'piece_types', recordId: pieceId, oldVals: existing, ip: req.ip });
    res.json({ message: 'Piece type deleted' });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Suppliers ─────────────────────────────────────────────────────────────────
router.get('/suppliers', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all());
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/suppliers', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const db        = getDb();
    const cleanName = name.trim();
    const existing  = await db.prepare('SELECT * FROM suppliers WHERE name=?').get(cleanName);

    if (existing && existing.active)  return res.status(409).json({ error: 'Supplier already exists' });
    if (existing && !existing.active) {
      await db.prepare('UPDATE suppliers SET active=1 WHERE id=?').run(existing.id);
      return res.status(200).json({ id: existing.id, name: cleanName, active: 1, restored: true });
    }

    // FIX: RETURNING id
    const r = await db.prepare('INSERT INTO suppliers(name) VALUES(?) RETURNING id').run(cleanName);
    res.status(201).json({ id: r.lastInsertRowid, name: cleanName, active: 1 });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/suppliers/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    await getDb().prepare('UPDATE suppliers SET active=0 WHERE id=?').run(req.params.id);
    res.json({ message: 'Supplier deactivated' });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Production Staff List ────────────────────────────────────────────────────────────
router.get('/workers', authenticate, async (_req, res) => {
  try {
    res.json(await getDb().prepare(
      "SELECT id,full_name,role FROM users WHERE active=1 AND role IN ('knuckler','operator','admin','owner') ORDER BY full_name"
    ).all());
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
router.get('/audit', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const { from, to, limit = 500 } = req.query;
    let sql = `SELECT al.*, u.username, u.full_name as user_name FROM audit_log al LEFT JOIN users u ON al.user_id=u.id`;
    const params = [], conds = [];
    if (from) { conds.push('al.logged_at >= ?'); params.push(from); }
    if (to)   { conds.push('al.logged_at <= ?'); params.push(to + 'T23:59:59'); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ` ORDER BY al.logged_at DESC LIMIT ${Math.min(parseInt(limit)||500, 5000)}`;
    res.json(await getDb().prepare(sql).all(...params));
  } catch(e) {
    console.error('GET audit error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────
// POST /notifications — only stock-critical alerts are accepted from the frontend.
// Activity notifications (production saved, sale saved, etc.) are intentionally
// suppressed here — they are too noisy. Only alert/warn from automated stock checks matter.
router.post('/notifications', authenticate, async (req, res) => {
  try {
    const { type, category, title, message, roleTarget } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });

    // Silently drop routine activity notifications — only stock alerts should appear in the bell.
    // Categories that are suppressed: production, sales, purchase, payment, activity, info.
    const SUPPRESSED_CATEGORIES = ['production', 'sales', 'purchase', 'payment', 'activity'];
    const SUPPRESSED_TYPES      = ['info'];
    if (SUPPRESSED_CATEGORIES.includes(category) || SUPPRESSED_TYPES.includes(type)) {
      return res.json({ ok: true }); // accepted but not stored
    }

    const db = getDb();
    // Deduplicate: don't write if same title was written in last 5 minutes
    const recent = await db.prepare(`
      SELECT id FROM notifications
      WHERE (user_id=? OR role_target=?)
        AND title=?
        AND (strftime('%s', created_at) + 0) >= (strftime('%s', 'now') - 300)
      LIMIT 1
    `).get(req.user.id, roleTarget || 'owner', title);
    if (!recent) {
      await writeNotification(db, {
        userId: req.user.id,
        roleTarget: roleTarget || null,
        type: type || 'warn',
        category: category || type || 'alert',
        title,
        message,
      });
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/notifications', authenticate, async (req, res) => {
  try {
    // Return stock alerts and warnings only — activity/info notifications are suppressed.
    // This keeps the bell focused on things that require action (stockouts, low stock).
    res.json(await getDb().prepare(`
      SELECT * FROM notifications
      WHERE (user_id=? OR role_target=?)
        AND type IN ('alert','warn')
      ORDER BY created_at DESC LIMIT 100
    `).all(req.user.id, req.user.role));
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark ALL notifications read — must be declared BEFORE /:id/read so Express doesn't treat 'mark-all-read' as an id
router.patch('/notifications/mark-all-read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'UPDATE notifications SET read=1 WHERE (user_id=? OR role_target=?) AND read=0'
    ).run(req.user.id, req.user.role);
    res.json({ message: 'All marked read' });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark a single notification read — scoped to current user only
router.patch('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'UPDATE notifications SET read=1 WHERE id=? AND (user_id=? OR role_target=?)'
    ).run(req.params.id, req.user.id, req.user.role);
    res.json({ message: 'Marked read' });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /notifications/read — clear all read notifications for current user
router.delete('/notifications/read', authenticate, async (req, res) => {
  try {
    await getDb().prepare(
      'DELETE FROM notifications WHERE (user_id=? OR role_target=?) AND read=1'
    ).run(req.user.id, req.user.role);
    res.json({ message: 'Read notifications cleared' });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});



// ── Production Staff Analytics ─────────────────────────────────────────────────────
router.get('/worker-production', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    // Get production by operators — pieces produced, plus cash revenue received for those production sessions
    const operatorData = await db.prepare(`
      SELECT
        COALESCE(u.full_name, 'Unknown Operator')  AS worker_name,
        'operator'                                  AS role,
        COUNT(DISTINCT p.id)                        AS production_days,
        SUM(pi.pieces_produced)                     AS total_pieces,
        SUM(pi.pieces_produced * pt.weight_kg)      AS total_kgs
      FROM production p
      JOIN production_items pi ON p.id = pi.production_id
      JOIN piece_types pt ON pi.piece_type_id = pt.id
      LEFT JOIN users u ON p.operator_id = u.id
      WHERE p.entry_date BETWEEN ? AND ?
        AND p.operator_id IS NOT NULL
      GROUP BY p.operator_id, u.full_name
      ORDER BY total_pieces DESC
    `).all(fromDate, toDate);

    // Get production by knucklers
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
      period: { from: fromDate, to: toDate },
      operators: operatorData,
      knucklers: knucklerData,
      summary: {
        total_operators: operatorData.length,
        total_knucklers: knucklerData.length,
        total_pieces: operatorData.reduce((sum, o) => sum + (o.total_pieces || 0), 0),
        total_kgs: operatorData.reduce((sum, o) => sum + (o.total_kgs || 0), 0)
      }
    });
  } catch(e) {
    console.error('GET production-staff-production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sales by Piece Type Analytics ───────────────────────────────────────────────────
router.get('/sales-by-piece', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    // Sales by piece type — cash-basis, item-level split via invoice_items
    // Each invoice_item's share of the payment = (line_total / invoice_subtotal) * cash_received
    // This correctly handles multi-gauge/multi-piece invoices.
    const salesData = await db.prepare(`
      SELECT
        pt.name                                                            AS piece_name,
        pt.length_m,
        COUNT(DISTINCT ii.invoice_id)                                      AS transaction_count,
        CAST(SUM(ii.quantity) AS INTEGER)                                  AS total_pieces,
        ROUND(SUM(
          ip_agg.paid_in_period * (ii.line_total / NULLIF(i.subtotal, 0))
        )::numeric, 2)                                                     AS total_revenue,
        ROUND(AVG(ii.unit_price)::numeric, 2)                              AS avg_price
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
      period: { from: fromDate, to: toDate },
      sales_data: salesData,
      summary: {
        total_transactions: salesData.reduce((sum, s) => sum + (s.transaction_count || 0), 0),
        total_pieces: salesData.reduce((sum, s) => sum + (s.total_pieces || 0), 0),
        total_revenue: salesData.reduce((sum, s) => sum + parseFloat(s.total_revenue || 0), 0)
      }
    });
  } catch(e) {
    console.error('GET sales-by-piece error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Revenue Breakdown ───────────────────────────────────────────────────────────────
router.get('/revenue-breakdown', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;
    
    let fromDate = from, toDate = to;
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate   = utcDateStr(now);
      fromDate = utcDateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
    }

    // Get sales cost summary
    const salesSummary = await getSalesCostSummary(db, fromDate, toDate);
    const rentCost = await getAccruedRentForRange(db, fromDate, toDate);
    
    // Cash-basis detail rows — item-level split via invoice_items
    // Each line item's share of the payment = (line_total / invoice_subtotal) * cash_received
    const detailRows = await db.prepare(`
      SELECT
        i.invoice_date                                                       AS entry_date,
        pt.name                                                              AS piece_name,
        ii.quantity,
        pt.weight_kg,
        0                                                                    AS transport_to_market,
        ii.unit_price                                                        AS selling_price,
        i.total_amount,
        ip_agg.paid_in_period,
        LEAST(
          ip_agg.paid_in_period * (ii.line_total / NULLIF(i.subtotal, 0)) / NULLIF(ii.line_total, 0),
          1.0
        )                                                                    AS ratio
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
      ORDER BY i.invoice_date DESC
    `).all(fromDate, toDate);

    const wireCostPerKg   = salesSummary.weighted_wire_cost_per_kg;
    const convPerPiece    = salesSummary.conversion_cost_per_piece;

    const wireCostDetails = detailRows.map(r => ({
      entry_date:  r.entry_date,
      piece_name:  r.piece_name,
      quantity:    Math.round(r.quantity * r.ratio),
      weight_kg:   r.weight_kg,
      kgs_sold:    parseFloat((r.quantity * r.weight_kg * r.ratio).toFixed(3)),
      wire_cost:   parseFloat((r.quantity * r.weight_kg * r.ratio * wireCostPerKg).toFixed(2)),
      selling_price: r.selling_price,
      revenue:     parseFloat(r.paid_in_period.toFixed(2)),
    }));

    const conversionCostDetails = detailRows.map(r => ({
      entry_date:      r.entry_date,
      piece_name:      r.piece_name,
      quantity:        Math.round(r.quantity * r.ratio),
      conversion_cost: parseFloat((r.quantity * r.ratio * convPerPiece).toFixed(2)),
      selling_price:   r.selling_price,
      revenue:         parseFloat(r.paid_in_period.toFixed(2)),
    }));

    const transportCostDetails = detailRows
      .filter(r => parseFloat(r.transport_to_market) > 0)
      .map(r => ({
        entry_date:         r.entry_date,
        piece_name:         r.piece_name,
        quantity:           Math.round(r.quantity * r.ratio),
        transport_to_market: parseFloat((r.transport_to_market * r.ratio).toFixed(2)),
        selling_price:      r.selling_price,
        revenue:            parseFloat(r.paid_in_period.toFixed(2)),
      }));

    const rentDetails = await db.prepare(`
      SELECT month, amount_due
      FROM rent_months
      WHERE month BETWEEN ? AND ?
      ORDER BY month
    `).all(fromDate.slice(0, 7), toDate.slice(0, 7));

    // Calculate profit metrics (excluding rent)
    const grossProfit = salesSummary.gross_profit;               // revenue - direct costs
    const netProfit = grossProfit - rentCost;                    // gross minus period rent
    const grossMargin = salesSummary.revenue > 0 ? (grossProfit / salesSummary.revenue * 100) : 0;
    const netMargin = salesSummary.revenue > 0 ? (netProfit / salesSummary.revenue * 100) : 0;

    // Revenue breakdown percentages (excluding rent)
    const wireCostPct = salesSummary.revenue > 0 ? (salesSummary.wire_cost / salesSummary.revenue * 100) : 0;
    const conversionCostPct = salesSummary.revenue > 0 ? (salesSummary.conversion_cost / salesSummary.revenue * 100) : 0;
    const transportCostPct = salesSummary.revenue > 0 ? (salesSummary.transport_to_market_cost / salesSummary.revenue * 100) : 0;
    const netProfitPct = salesSummary.revenue > 0 ? (netProfit / salesSummary.revenue * 100) : 0;

    res.json({
      period: { from: fromDate, to: toDate },
      summary: {
        total_revenue: parseFloat(salesSummary.revenue.toFixed(2)),
        total_costs: parseFloat((salesSummary.direct_costs + rentCost).toFixed(2)),
        rent_cost: parseFloat(rentCost.toFixed(2)),
        net_profit: parseFloat(netProfit.toFixed(2)),
        gross_margin: parseFloat(grossMargin.toFixed(1)),
        net_margin: parseFloat(netMargin.toFixed(1))
      },
      cost_breakdown: {
        wire_cost: {
          amount: parseFloat(salesSummary.wire_cost.toFixed(2)),
          percentage: parseFloat(wireCostPct.toFixed(1)),
          description: 'Cost of raw wire materials',
          details: wireCostDetails
        },
        conversion_cost: {
          amount: parseFloat(salesSummary.conversion_cost.toFixed(2)),
          percentage: parseFloat(conversionCostPct.toFixed(1)),
          description: 'Labor costs (operator + knuckler + sack costs)',
          details: conversionCostDetails
        },
        transport_cost: {
          amount: parseFloat(salesSummary.transport_to_market_cost.toFixed(2)),
          percentage: parseFloat(transportCostPct.toFixed(1)),
          description: 'Transport costs to market',
          details: transportCostDetails
        },
        rent_cost: {
          amount: parseFloat(rentCost.toFixed(2)),
          percentage: salesSummary.revenue > 0 ? parseFloat((rentCost / salesSummary.revenue * 100).toFixed(1)) : 0,
          description: 'Accrued rent for this period',
          details: rentDetails
        },
        net_profit: {
          amount: parseFloat(netProfit.toFixed(2)),
          percentage: parseFloat(netProfitPct.toFixed(1)),
          description: 'Final profit after all costs including rent'
        }
      },
      insights: {
        total_pieces_sold: salesSummary.pieces_sold,
        total_kgs_sold: parseFloat(salesSummary.kgs_sold.toFixed(2)),
        avg_wire_cost_per_kg: parseFloat(salesSummary.weighted_wire_cost_per_kg.toFixed(2)),
        avg_conversion_cost_per_piece: parseFloat(salesSummary.conversion_cost_per_piece.toFixed(2)),
        cost_per_piece: parseFloat(((salesSummary.direct_costs) / salesSummary.pieces_sold).toFixed(2))
      }
    });
  } catch(e) {
    console.error('GET revenue-breakdown error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ══════════════════════════════════════════════════════════════════
// EXCEL / CSV EXPORTS  (no xlsx lib needed — produces clean CSV
//   that Excel opens natively as UTF-8 with BOM)
// ══════════════════════════════════════════════════════════════════

function csvRow(arr) {
  return arr.map(v => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',');
}

function buildCsv(headers, rows) {
  const BOM = '\uFEFF'; // UTF-8 BOM so Excel opens correctly
  return BOM + [headers, ...rows].map(r => csvRow(r)).join('\r\n');
}

function sendCsv(res, filename, headers, rows) {
  const csv = buildCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

/* GET /api/export/purchases
 * Reconciliation approach: payments are recorded at supplier level (no purchase_id FK).
 * We allocate payments chronologically (FIFO) across that supplier's purchases so that
 * the per-row amount_paid / balance / status are internally consistent and the column
 * totals always match the true supplier balance.
 */
router.get('/export/purchases', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    // Fetch all purchases in the date range (oldest first for FIFO allocation)
    const purchases = await db.prepare(`
      SELECT p.id, p.entry_date, p.supplier_id, s.name AS supplier, p.gauge,
             p.kgs_bought, p.cost_per_kg,
             ROUND((p.kgs_bought * p.cost_per_kg)::numeric, 2)                   AS wire_cost,
             p.transport_cost,
             ROUND((p.kgs_bought * p.cost_per_kg + p.transport_cost)::numeric, 2) AS total_cost,
             ROUND(((p.kgs_bought * p.cost_per_kg + p.transport_cost)
                    / NULLIF(p.kgs_bought, 0))::numeric, 2)                        AS landed_per_kg,
             u.full_name AS entered_by, p.created_at
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      JOIN users u ON p.entered_by = u.id
      WHERE p.entry_date BETWEEN ? AND ?
      ORDER BY p.entry_date ASC, p.id ASC
    `).all(from, to);

    // Fetch all-time supplier payments (needed to compute true running balance)
    const allPayments = await db.prepare(`
      SELECT payee_supplier_id, ROUND(SUM(amount)::numeric, 2) AS total_paid
      FROM payments
      WHERE category = 'supplier'
      GROUP BY payee_supplier_id
    `).all();
    const supplierPaidMap = {};
    for (const p of allPayments) supplierPaidMap[p.payee_supplier_id] = parseFloat(p.total_paid) || 0;

    // Also fetch all-time purchases per supplier to compute correct FIFO allocation
    const allPurchases = await db.prepare(`
      SELECT id, supplier_id, entry_date,
             ROUND((kgs_bought * cost_per_kg + transport_cost)::numeric, 2) AS total_cost
      FROM purchases
      ORDER BY entry_date ASC, id ASC
    `).all();

    // FIFO allocation: for each supplier, walk purchases oldest→newest, drain payment pool
    const purchaseAlloc = {}; // purchase id -> { amount_paid, balance, status }
    const supplierIds = [...new Set(allPurchases.map(p => p.supplier_id))];
    for (const sid of supplierIds) {
      let pool = supplierPaidMap[sid] || 0;
      const sRows = allPurchases.filter(p => p.supplier_id === sid);
      for (const p of sRows) {
        const cost      = parseFloat(p.total_cost) || 0;
        const applied   = Math.min(pool, cost);
        const balance   = parseFloat((cost - applied).toFixed(2));
        pool            = parseFloat((pool - applied).toFixed(2));
        let status;
        if (applied <= 0)            status = 'Unpaid';
        else if (balance <= 0.01)    status = 'Fully Paid';
        else                         status = 'Partially Paid';
        purchaseAlloc[p.id] = { amount_paid: parseFloat(applied.toFixed(2)), balance, status };
      }
    }

    // Build export rows (restore original DESC order)
    const sorted = [...purchases].sort((a, b) =>
      b.entry_date < a.entry_date ? -1 : b.entry_date > a.entry_date ? 1 : b.id - a.id
    );
    const headers = [
      'Date','Supplier','Gauge','Kgs Bought','Cost/kg','Wire Cost','Transport',
      'Total Cost','Landed/kg','Amount Paid (FIFO)','Balance','Payment Status',
      'Entered By','Created At'
    ];
    sendCsv(res, `imara_purchases_${from}_to_${to}.csv`, headers,
      sorted.map(r => {
        const alloc = purchaseAlloc[r.id] || { amount_paid: 0, balance: parseFloat(r.total_cost) || 0, status: 'Unpaid' };
        return [
          r.entry_date, r.supplier, r.gauge, r.kgs_bought, r.cost_per_kg,
          r.wire_cost, r.transport_cost, r.total_cost, r.landed_per_kg,
          alloc.amount_paid, alloc.balance, alloc.status,
          r.entered_by, r.created_at
        ];
      }));
  } catch(e) {
    console.error('Export purchases error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /api/export/sales */
router.get('/export/sales', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    // Join sales → invoices → invoice_payments to derive payment status and balance
    const rows = await db.prepare(`
      SELECT
        s.entry_date,
        pt.name                                                      AS piece_type,
        s.gauge_source                                               AS gauge,
        s.quantity,
        s.selling_price,
        ROUND((s.quantity * s.selling_price)::numeric, 2)           AS line_total,
        s.transport_to_market,
        s.buyer_name,
        CASE WHEN s.price_overridden=1 THEN 'Yes' ELSE 'No' END     AS price_overridden,
        COALESCE(i.total_amount, ROUND((s.quantity * s.selling_price)::numeric,2)) AS invoice_total,
        COALESCE(i.amount_paid, 0)                                   AS amount_paid,
        ROUND(COALESCE(i.total_amount - i.amount_paid,
              s.quantity * s.selling_price)::numeric, 2)             AS balance,
        CASE
          WHEN i.id IS NULL                        THEN 'No Invoice'
          WHEN i.status = 'cancelled'              THEN 'Cancelled'
          WHEN i.amount_paid >= i.total_amount     THEN 'Fully Paid'
          WHEN i.amount_paid > 0                   THEN 'Partially Paid'
          ELSE                                          'Unpaid'
        END                                                          AS payment_status,
        u.full_name AS entered_by,
        s.created_at
      FROM sales s
      JOIN piece_types pt ON s.piece_type_id = pt.id
      JOIN users u ON s.entered_by = u.id
      LEFT JOIN invoices i ON i.sale_id = s.id
      WHERE s.entry_date BETWEEN ? AND ?
      ORDER BY s.entry_date DESC, s.id DESC
    `).all(from, to);

    const headers = [
      'Date','Piece Type','Gauge','Qty','Price/pc','Line Total',
      'Transport','Customer','Price Overridden',
      'Invoice Total','Amount Paid','Balance','Payment Status',
      'Entered By','Created At'
    ];
    sendCsv(res, `imara_sales_${from}_to_${to}.csv`, headers,
      rows.map(r => [
        r.entry_date, r.piece_type, r.gauge, r.quantity, r.selling_price,
        r.line_total, r.transport_to_market, r.buyer_name, r.price_overridden,
        r.invoice_total, r.amount_paid, r.balance, r.payment_status,
        r.entered_by, r.created_at
      ]));
  } catch(e) {
    console.error('Export sales error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /api/export/production */
router.get('/export/production', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const rows = await db.prepare(`
      SELECT pr.entry_date, pr.gauge, pr.kgs_used,
             STRING_AGG(pt.name || ' x' || pi.pieces_produced, ', ') AS items,
             u_op.full_name AS operator, u_kn.full_name AS knuckler,
             pr.operator_cost, pr.knuckler_cost, pr.sack_cost,
             pr.total_cost, u_en.full_name AS entered_by, pr.created_at
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
    const headers = ['Date','Gauge','Kgs Used','Items Produced','Operator','Knuckler','Operator Cost','Knuckler Cost','Sack Cost','Total Cost','Entered By','Created At'];
    sendCsv(res, `imara_production_${from}_to_${to}.csv`, headers,
      rows.map(r => [r.entry_date, r.gauge, r.kgs_used, r.items, r.operator, r.knuckler,
        r.operator_cost, r.knuckler_cost, r.sack_cost, r.total_cost, r.entered_by, r.created_at]));
  } catch(e) {
    console.error('Export production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /api/export/gauge-analysis */
router.get('/export/gauge-analysis', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const gauges = (await db.prepare(`
      SELECT DISTINCT gauge FROM purchases WHERE gauge != '' AND entry_date BETWEEN ? AND ?
      UNION SELECT DISTINCT gauge FROM production WHERE gauge != '' AND entry_date BETWEEN ? AND ?
      UNION SELECT DISTINCT gauge_source FROM sales WHERE gauge_source != '' AND entry_date BETWEEN ? AND ?
    `).all(from, to, from, to, from, to)).map(r => r.gauge || r.gauge_source).filter(Boolean);

    const rows = [];
    for (const gauge of gauges) {
      const b = await db.prepare(`SELECT COALESCE(SUM(kgs_bought),0) AS v, COALESCE(SUM(kgs_bought*cost_per_kg),0) AS cost FROM purchases WHERE gauge=? AND entry_date BETWEEN ? AND ?`).get(gauge, from, to);
      const p = await db.prepare(`SELECT COALESCE(SUM(kgs_used),0) AS kgs, COALESCE(SUM(pi.pieces_produced),0) AS pcs FROM production pr LEFT JOIN production_items pi ON pi.production_id=pr.id WHERE pr.gauge=? AND pr.entry_date BETWEEN ? AND ?`).get(gauge, from, to);
      const s = await db.prepare(`SELECT COALESCE(SUM(quantity),0) AS pcs, COALESCE(SUM(quantity*selling_price),0) AS rev FROM sales WHERE gauge_source=? AND entry_date BETWEEN ? AND ?`).get(gauge, from, to);
      rows.push([
        gauge,
        parseFloat(b.v)||0,
        parseFloat(b.cost)||0,
        parseFloat(p.kgs)||0,
        parseInt(p.pcs)||0,
        parseInt(s.pcs)||0,
        parseFloat(s.rev)||0,
        parseFloat(((parseFloat(b.v)||0) - (parseFloat(p.kgs)||0)).toFixed(2)),
        Math.max(0,(parseInt(p.pcs)||0)-(parseInt(s.pcs)||0)),
      ]);
    }
    const headers = ['Gauge','Kgs Purchased','Wire Cost (KES)','Kgs Used in Production','Pieces Produced','Pieces Sold','Revenue (KES)','Kgs in Stock','Pieces in Stock'];
    sendCsv(res, `imara_gauge_analysis_${from}_to_${to}.csv`, headers, rows);
  } catch(e) {
    console.error('Export gauge-analysis error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /api/export/invoices */
router.get('/export/invoices', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const rows = await db.prepare(`
      SELECT i.invoice_number, i.invoice_date, i.due_date, i.customer_name,
             i.customer_phone,
             CASE
               WHEN i.status = 'paid'            THEN 'Fully Paid'
               WHEN i.status = 'partial_payment'
                AND i.amount_paid > 0            THEN 'Partially Paid'
               WHEN i.status = 'partial_payment' THEN 'Unpaid'
               WHEN i.status = 'cancelled'       THEN 'Cancelled'
               ELSE i.status
             END                                                        AS payment_status,
             i.subtotal, i.discount_amount, i.tax_amount, i.total_amount,
             ROUND(i.amount_paid::numeric, 2)                          AS amount_paid,
             ROUND((i.total_amount - i.amount_paid)::numeric, 2)       AS balance,
             u.full_name AS created_by, i.notes
      FROM invoices i JOIN users u ON i.created_by = u.id
      WHERE i.invoice_date BETWEEN ? AND ?
      ORDER BY i.invoice_date DESC, i.id DESC
    `).all(from, to);
    const headers = ['Invoice #','Date','Due Date','Customer','Phone','Payment Status','Subtotal','Discount','Tax','Total','Amount Paid','Balance','Created By','Notes'];
    sendCsv(res, `imara_invoices_${from}_to_${to}.csv`, headers,
      rows.map(r => [r.invoice_number, r.invoice_date, r.due_date, r.customer_name,
        r.customer_phone, r.payment_status, r.subtotal, r.discount_amount, r.tax_amount,
        r.total_amount, r.amount_paid, r.balance, r.created_by, r.notes]));
  } catch(e) {
    console.error('Export invoices error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.writeNotification   = writeNotification;
module.exports.checkAndNotifyStock = checkAndNotifyStock;
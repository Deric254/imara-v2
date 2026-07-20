// backend/lib/paymentGatedCost.js
//
// Computes "Sold Net" cost the way the owner asked for: a cost only counts
// once it has actually been PAID — the same rule revenue already follows
// (a sale's revenue only counts once cash is received, not at invoice time).
// Previously, Sold Net's cost side was recognized immediately at the moment
// of sale (accrual-matched to what was sold, but payment-agnostic). This
// module replaces that with a payment-gated version, WITHOUT touching the
// accrual-based figures anywhere else in the system.
//
// CRITICAL DESIGN BOUNDARY — read before changing anything here:
// This module is entirely SEPARATE from saleCore.js's resolveWireCostPerKgForSale
// and resolveConversionCostPerPieceForSale. Those two functions write an
// IMMUTABLE snapshot onto each sale at the moment of insert, and that
// snapshot is what systemcheck.js's convergence checks are built on — proven
// correct by 25 independent randomized fuzz scenarios. This module does NOT
// touch those functions, does NOT touch the sales table, and does NOT change
// what gets written anywhere. It only computes a DIFFERENT number, fresh,
// at read time, for the Dashboard/P&L "Sold Net" display specifically.
// If you need to change how the immutable snapshot is computed, that work
// belongs in saleCore.js, not here — keep these two concerns separate or
// the two figures (systemcheck's accrual convergence vs Dashboard's
// payment-gated Sold Net) will silently drift from each other's assumptions.
//
// HOW PAYMENT-GATING WORKS:
//
// 1. PURCHASE BATCH PAID FRACTION (per supplier, FIFO):
//    For each supplier, order their purchases oldest-first. Apply that
//    supplier's total cumulative payments FIFO — the oldest batch gets paid
//    first, in full, before the next batch sees any payment. A batch that's
//    only partially covered gets a fractional "paid_fraction" (0 to 1).
//
// 2. PRODUCTION RUN'S PAID WIRE COST (via production_batch_usage):
//    A production run can draw wire from more than one purchase batch (FIFO
//    at the purchase level, already tracked in production_batch_usage). This
//    run's paid wire cost = sum over its batch draws of
//    (kgs_drawn * landed_cost_per_kg * that batch's paid_fraction).
//
// 3. PRODUCTION RUN'S PAID CONVERSION COST (via wage/sack FIFO):
//    Operator wages, knuckler wages, and sack costs are paid as separate
//    category-wide pools (not tied to a specific purchase batch), so each
//    is FIFO-gated independently: production runs ordered chronologically,
//    that category's cumulative payments applied oldest-run-first.
//
// 4. SALE-LEVEL ATTRIBUTION (reusing the same piece-count FIFO principle
//    already proven for the accrual snapshots, just fed PAID cost instead
//    of TOTAL cost per run):
//    Sales for a given piece_type + gauge combination are walked in
//    chronological order, each consuming pieces from the front of a batch
//    queue exactly like the immutable snapshot logic does — except each
//    queue entry's cost-per-piece reflects only the PAID portion of that
//    run's cost. A batch that's only 60% paid contributes only 60% of its
//    true cost per piece; the remaining 40% is recognized later, once more
//    payment comes in.
//
// This guarantees, by construction: once every purchase, every wage, and
// every sack cost is fully paid AND every produced piece is sold, payment-
// gated Sold Net cost converges exactly to Net Profit's cash-basis cost —
// because at that point "paid" and "total" are the same number for every
// batch and every run, which is the identical convergence guarantee the
// accrual-based FIFO snapshots already provide, verified by the same
// underlying arithmetic.

async function getPurchaseBatchPaidFractions(db) {
  const purchases = await db.prepare(
    `SELECT id, supplier_id, kgs_bought, cost_per_kg, COALESCE(transport_cost,0) AS transport_cost, entry_date, created_at
     FROM purchases ORDER BY supplier_id, created_at, id`
  ).all();

  const paymentsBySupplier = await db.prepare(
    `SELECT payee_supplier_id AS supplier_id, COALESCE(SUM(amount),0) AS total_paid
     FROM payments WHERE category='supplier' AND payee_supplier_id IS NOT NULL
     GROUP BY payee_supplier_id`
  ).all();
  const paidPool = new Map(paymentsBySupplier.map(p => [p.supplier_id, p.total_paid]));

  const fractions = new Map(); // purchase_id -> paid_fraction (0..1)
  const remainingPool = new Map(); // supplier_id -> remaining payment pool to allocate
  for (const p of purchases) {
    if (!remainingPool.has(p.supplier_id)) {
      remainingPool.set(p.supplier_id, paidPool.get(p.supplier_id) || 0);
    }
    const batchCost = p.kgs_bought * p.cost_per_kg + p.transport_cost;
    const available = remainingPool.get(p.supplier_id);
    const paidAmount = Math.max(0, Math.min(batchCost, available));
    const fraction = batchCost > 0 ? paidAmount / batchCost : 0;
    fractions.set(p.id, fraction);
    remainingPool.set(p.supplier_id, available - paidAmount);
  }
  return fractions;
}

async function getProductionRunPaidWireCost(db, purchaseFractions) {
  const draws = await db.prepare(
    `SELECT production_id, purchase_id, kgs_drawn, landed_cost_per_kg FROM production_batch_usage`
  ).all();
  const paidWireCostByRun = new Map(); // production_id -> paid wire cost
  for (const d of draws) {
    const fraction = purchaseFractions.get(d.purchase_id) || 0;
    const drawCost = d.kgs_drawn * d.landed_cost_per_kg;
    const paidPortion = drawCost * fraction;
    paidWireCostByRun.set(d.production_id, (paidWireCostByRun.get(d.production_id) || 0) + paidPortion);
  }
  return paidWireCostByRun;
}

async function getFifoGatedCostByRun(db, productionRows, costField, paymentCategory) {
  // Orders production runs chronologically, applies that category's total
  // cumulative payments FIFO across them — oldest run gets paid first.
  const totalPaid = (await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE category=?`
  ).get(paymentCategory)).v;

  const sorted = [...productionRows].sort((a, b) => (a.created_at || a.entry_date).localeCompare(b.created_at || b.entry_date) || a.id - b.id);
  const result = new Map(); // production_id -> paid portion of this cost field
  let remaining = totalPaid;
  for (const run of sorted) {
    const cost = costField(run);
    const paidPortion = Math.max(0, Math.min(cost, remaining));
    result.set(run.id, paidPortion);
    remaining -= paidPortion;
  }
  return result;
}

// Main entry point: computes payment-gated wire cost and conversion cost
// attributable to sales in [fromDate, toDate], using true FIFO piece
// consumption exactly like the accrual snapshots — just fed paid cost
// instead of total cost per production run.
async function getPaymentGatedSoldCost(db, fromDate, toDate) {
  const purchaseFractions = await getPurchaseBatchPaidFractions(db);
  const paidWireCostByRun = await getProductionRunPaidWireCost(db, purchaseFractions);

  const allProduction = await db.prepare(
    `SELECT id, gauge, kgs_used, entry_date, created_at,
            operator_cost, knuckler_cost, sack_cost
     FROM production`
  ).all();

  const paidOperatorByRun = await getFifoGatedCostByRun(db, allProduction, r => r.operator_cost, 'wages_operator');
  const paidKnucklerByRun = await getFifoGatedCostByRun(db, allProduction, r => r.knuckler_cost, 'wages_knuckler');
  const paidSackByRun     = await getFifoGatedCostByRun(db, allProduction, r => r.sack_cost, 'sack');

  // Build per-run paid wire cost + paid conversion cost, keyed by run id
  const runMeta = new Map();
  for (const run of allProduction) {
    runMeta.set(run.id, {
      gauge: run.gauge || '',
      createdAt: run.created_at || run.entry_date,
      paidWireCost: paidWireCostByRun.get(run.id) || 0,
      paidConvCost: (paidOperatorByRun.get(run.id) || 0) + (paidKnucklerByRun.get(run.id) || 0) + (paidSackByRun.get(run.id) || 0),
    });
  }

  // Wire cost: FIFO per (piece_type_id, gauge), same principle as the
  // accrual snapshot, but using PAID wire cost per run instead of total.
  const wireCombos = await db.prepare(`
    SELECT DISTINCT pi.piece_type_id, COALESCE(pr.gauge,'') AS gauge
    FROM production_items pi JOIN production pr ON pr.id = pi.production_id
  `).all();

  const wireCostBySale = new Map(); // sale_id -> paid wire cost attributed
  for (const combo of wireCombos) {
    const runs = allProduction
      .filter(r => (r.gauge || '') === combo.gauge)
      .sort((a, b) => (a.created_at || a.entry_date).localeCompare(b.created_at || b.entry_date) || a.id - b.id);

    const batchQueue = [];
    for (const run of runs) {
      const items = await db.prepare(
        'SELECT piece_type_id, pieces_produced FROM production_items WHERE production_id = ?'
      ).all(run.id);
      const totalPiecesInRun = items.reduce((s, i) => s + i.pieces_produced, 0);
      if (totalPiecesInRun === 0) continue;
      const thisTypePieces = items
        .filter(i => i.piece_type_id === combo.piece_type_id)
        .reduce((s, i) => s + i.pieces_produced, 0);
      if (thisTypePieces === 0) continue;
      const share = thisTypePieces / totalPiecesInRun;
      const meta = runMeta.get(run.id);
      batchQueue.push({ piecesLeft: thisTypePieces, costPerPiece: (meta.paidWireCost * share) / thisTypePieces });
    }

    const sales = await db.prepare(
      `SELECT id, quantity, entry_date, created_at FROM sales
       WHERE piece_type_id = ? AND COALESCE(gauge_source,'') = ?
       ORDER BY created_at, id`
    ).all(combo.piece_type_id, combo.gauge);

    for (const sale of sales) {
      let remaining = sale.quantity, cost = 0, idx = 0;
      while (remaining > 0 && idx < batchQueue.length) {
        const batch = batchQueue[idx];
        if (batch.piecesLeft <= 0) { idx++; continue; }
        const draw = Math.min(remaining, batch.piecesLeft);
        cost += draw * batch.costPerPiece;
        batch.piecesLeft -= draw;
        remaining -= draw;
        if (batch.piecesLeft <= 0) idx++;
      }
      wireCostBySale.set(sale.id, cost);
    }
  }

  // Conversion cost: FIFO per piece_type_id (not gauge-dependent), using
  // PAID conversion cost per run instead of total — same principle.
  const convTypes = await db.prepare('SELECT DISTINCT piece_type_id FROM production_items').all();
  const convCostBySale = new Map();
  for (const t of convTypes) {
    const runs = [...allProduction].sort((a, b) => (a.created_at || a.entry_date).localeCompare(b.created_at || b.entry_date) || a.id - b.id);
    const batchQueue = [];
    for (const run of runs) {
      const items = await db.prepare(
        'SELECT piece_type_id, pieces_produced FROM production_items WHERE production_id = ?'
      ).all(run.id);
      const totalPiecesInRun = items.reduce((s, i) => s + i.pieces_produced, 0);
      if (totalPiecesInRun === 0) continue;
      const thisTypePieces = items
        .filter(i => i.piece_type_id === t.piece_type_id)
        .reduce((s, i) => s + i.pieces_produced, 0);
      if (thisTypePieces === 0) continue;
      const share = thisTypePieces / totalPiecesInRun;
      const meta = runMeta.get(run.id);
      batchQueue.push({ piecesLeft: thisTypePieces, costPerPiece: (meta.paidConvCost * share) / thisTypePieces });
    }

    const sales = await db.prepare(
      'SELECT id, quantity FROM sales WHERE piece_type_id = ? ORDER BY created_at, id'
    ).all(t.piece_type_id);

    for (const sale of sales) {
      let remaining = sale.quantity, cost = 0, idx = 0;
      while (remaining > 0 && idx < batchQueue.length) {
        const batch = batchQueue[idx];
        if (batch.piecesLeft <= 0) { idx++; continue; }
        const draw = Math.min(remaining, batch.piecesLeft);
        cost += draw * batch.costPerPiece;
        batch.piecesLeft -= draw;
        remaining -= draw;
        if (batch.piecesLeft <= 0) idx++;
      }
      convCostBySale.set(sale.id, cost);
    }
  }

  // Transport cost: stored per-sale (not per production run), so gate it
  // with a sale-level FIFO instead — sales ordered chronologically, actual
  // transport_to_market payments applied oldest-sale-first across each
  // sale's transport_to_market snapshot amount.
  const allSalesForTransport = await db.prepare(
    'SELECT id, transport_to_market, created_at FROM sales ORDER BY created_at, id'
  ).all();
  const totalTransportPaid = (await db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE category='transport_to_market'"
  ).get()).v;
  const transportCostBySale = new Map();
  let remainingTransportPool = totalTransportPaid;
  for (const s of allSalesForTransport) {
    const cost = s.transport_to_market || 0;
    const paidPortion = Math.max(0, Math.min(cost, remainingTransportPool));
    transportCostBySale.set(s.id, paidPortion);
    remainingTransportPool -= paidPortion;
  }

  // Sum for the requested period's sales only.
  const periodSales = await db.prepare(
    'SELECT id FROM sales WHERE entry_date BETWEEN ? AND ?'
  ).all(fromDate, toDate);

  let totalWireCost = 0, totalConvCost = 0, totalTransportCost = 0;
  for (const s of periodSales) {
    totalWireCost += wireCostBySale.get(s.id) || 0;
    totalConvCost += convCostBySale.get(s.id) || 0;
    totalTransportCost += transportCostBySale.get(s.id) || 0;
  }

  return {
    paid_wire_cost: parseFloat(totalWireCost.toFixed(2)),
    paid_conversion_cost: parseFloat(totalConvCost.toFixed(2)),
    paid_transport_cost: parseFloat(totalTransportCost.toFixed(2)),
    // Per-sale breakdowns — exposed so any drill-down view uses the exact
    // same numbers as the summed total above, by construction. Two separate
    // calculations that are each "correct" but computed independently is
    // exactly the class of bug this whole system has already been burned by
    // once; reading from one shared source closes that risk permanently.
    wire_cost_by_sale_id: Object.fromEntries(wireCostBySale),
    conversion_cost_by_sale_id: Object.fromEntries(convCostBySale),
    transport_cost_by_sale_id: Object.fromEntries(transportCostBySale),
  };
}

module.exports = { getPaymentGatedSoldCost };

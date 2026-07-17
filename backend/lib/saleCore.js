// backend/lib/saleCore.js
//
// Shared sale-creation logic, extracted verbatim from the original
// POST /daily/sales/batch handler (no behavior change — pure extraction).
// Used by:
//   - routes/daily.js  (POST /sales/batch — direct sale entry)
//   - routes/orders.js (order conversion — must produce identical sale records)
//
// Keeping this in one place guarantees a converted order and a directly
// entered sale are computed exactly the same way, forever — no risk of the
// two paths silently drifting apart over time.

async function getCfgNumber(db, key) {
  return parseFloat((await db.prepare('SELECT value FROM config WHERE key=?').get(key))?.value || 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIFO COST ATTRIBUTION — shared by wire cost and conversion cost resolution
//
// WHY plain "blended average up to now" is wrong:
// The earlier approach computed a fresh blended average of ALL qualifying
// production up to a sale's moment, independently for EVERY sale. This looks
// reasonable in isolation, but when multiple sales draw from the SAME pool of
// production runs over time, each sale's "average as of now" silently
// re-includes production that an EARLIER sale already fully claimed —
// double-attributing that cost. Confirmed on real data: a single piece type
// + gauge combination showed a KES 3,975.82 gap between what sales summed to
// and what production actually cost, purely from this effect — even though
// every purchase, every production run, and every payment individually
// balanced to the shilling.
//
// THE FIX: true FIFO. Build a chronological queue of "batches" — each
// production run's fair share of cost for this piece type, split by piece
// count if the run made more than one type. Walk through every EXISTING sale
// for this piece type (and gauge, for wire) in chronological order first,
// consuming from the front of the queue exactly like real inventory would be
// drawn down. Whatever is left after replaying prior sales is what a NEW
// sale actually draws from. No production kg or cost can ever be claimed by
// more than one sale, by construction.
//
// costField: a function (run) => cost for that run (wire cost or conv cost).
// gaugeFilter: if set, only production runs matching this gauge are considered
// (used for wire; conversion cost is not gauge-dependent, so pass null).
async function fifoAttributeCost(db, { pieceTypeId, gauge, entryDate, quantity, costField }) {
  const gaugeClause = gauge !== null ? `AND COALESCE(pr.gauge, '') = ?` : '';
  const params = gauge !== null ? [gauge] : [];

  const runs = await db.prepare(`
    SELECT pr.id, pr.kgs_used, pr.total_cost, pr.operator_cost, pr.knuckler_cost, pr.sack_cost, pr.rent_allocation
    FROM production pr
    WHERE pr.entry_date <= ? ${gaugeClause}
    ORDER BY pr.created_at
  `).all(entryDate, ...params);

  // Build the chronological batch queue: each entry is this piece type's
  // fair share (by piece count) of one production run's cost and kg.
  const batchQueue = [];
  for (const run of runs) {
    const items = await db.prepare(
      'SELECT piece_type_id, pieces_produced FROM production_items WHERE production_id = ?'
    ).all(run.id);
    const totalPiecesInRun = items.reduce((s, i) => s + i.pieces_produced, 0);
    if (totalPiecesInRun === 0) continue;
    const thisTypePieces = items
      .filter(i => i.piece_type_id === pieceTypeId)
      .reduce((s, i) => s + i.pieces_produced, 0);
    if (thisTypePieces === 0) continue;
    const share = thisTypePieces / totalPiecesInRun;
    const runCost = costField(run) * share;
    const runKg   = (run.kgs_used || 0) * share;
    batchQueue.push({
      piecesLeft:  thisTypePieces,
      costPerPiece: runCost / thisTypePieces,
      kgPerPiece:   runKg / thisTypePieces,
    });
  }

  // Replay every sale that ALREADY EXISTS in the table for this piece type
  // (+ gauge, for wire), consuming from the front of the queue in the order
  // they actually happened. The new sale isn't inserted yet at this point,
  // so everything currently in the table is inherently "prior" — no extra
  // timestamp cutoff needed on this side.
  const priorSalesGaugeClause = gauge !== null ? `AND COALESCE(gauge_source, '') = ?` : '';
  const priorSalesParams = gauge !== null ? [gauge] : [];
  const priorSales = await db.prepare(`
    SELECT quantity FROM sales
    WHERE piece_type_id = ? AND entry_date <= ? ${priorSalesGaugeClause}
    ORDER BY created_at
  `).all(pieceTypeId, entryDate, ...priorSalesParams);

  function consume(qty) {
    let remaining = qty;
    let totalCost = 0, totalKg = 0;
    let idx = 0;
    while (remaining > 0 && idx < batchQueue.length) {
      const batch = batchQueue[idx];
      if (batch.piecesLeft <= 0) { idx++; continue; }
      const draw = Math.min(remaining, batch.piecesLeft);
      totalCost += draw * batch.costPerPiece;
      totalKg   += draw * batch.kgPerPiece;
      batch.piecesLeft -= draw;
      remaining -= draw;
      if (batch.piecesLeft <= 0) idx++;
    }
    return { totalCost, totalKg, unfulfilled: remaining };
  }

  for (const prior of priorSales) consume(prior.quantity);

  // Now attribute the NEW sale's quantity from whatever remains.
  const result = consume(quantity);
  return {
    totalCost: result.totalCost,
    totalKg:   result.totalKg,
    perPiece:  quantity > 0 ? result.totalCost / quantity : 0,
    perKg:     result.totalKg > 0 ? result.totalCost / result.totalKg : 0,
  };
}

// Wire cost per kg for a piece type AND GAUGE at a point in time.
//
// WHY gauge filtering AND fair-sharing are both required:
// (1) GAUGE: different wire gauges are purchased at different prices, so the
//     landed cost per kg genuinely differs between gauges. Blending gauges
//     together produces a rate that reflects neither accurately.
// (2) FAIR-SHARE WITHIN EACH RUN: when a single production run makes more
//     than one piece type (e.g. one run produces both 10mini and 20mega from
//     the same batch of wire), that run's total cost cannot simply be summed
//     once per piece type — doing so credits the FULL run cost to EVERY
//     piece type it produced, inflating all of their rates by the cost that
//     rightfully belongs to their run-mates. Each run's cost must be split
//     across its own items by piece count FIRST, and only that piece type's
//     fair share added to the running total, before dividing by kg to get
//     a rate. Confirmed on real data: this exact double-counting was the
//     cause of a persistent gap between the Dashboard's cash-basis Net
//     Profit and the Sold-matched Net Profit KPI that never closed even
//     once every invoice was paid and every supplier settled — because the
//     error lived in how the snapshot was computed, not in payment timing.
//
// Written to sales.wire_cost_per_kg at insert time and never changed —
// permanent record of cost at point of sale for that specific gauge.
async function resolveWireCostPerKgForSale(db, pieceTypeId, gaugeSource, entryDate, quantity) {
  const gauge = (gaugeSource || '').trim();
  const result = await fifoAttributeCost(db, {
    pieceTypeId, gauge, entryDate, quantity,
    costField: (run) => run.total_cost - run.operator_cost - run.knuckler_cost - run.sack_cost - run.rent_allocation,
  });
  return { wireCostPerKg: result.perKg, wireCostPerPiece: result.perPiece, kgPerPiece: result.totalKg > 0 && quantity > 0 ? result.totalKg / quantity : 0 };
}

// Conversion cost (operator + knuckler + sack) per piece for a piece type,
// via the same true-FIFO attribution as wire cost above. Conversion cost is
// NOT gauge-dependent (labour effort is the same regardless of which gauge
// wire is being worked), so gauge is passed as null here.
//
// Written to sales.conversion_cost_per_piece at insert time and never
// changed — permanent record of cost at point of sale. Lets the "Sold" P&L
// column match conversion cost to units actually sold, exactly the way it
// already matches wire cost, instead of falling back to whatever labour/sack
// cash was paid out in the period (which is what the cash-basis column is for).
async function resolveConversionCostPerPieceForSale(db, pieceTypeId, entryDate, quantity) {
  const result = await fifoAttributeCost(db, {
    pieceTypeId, gauge: null, entryDate, quantity,
    costField: (run) => run.operator_cost + run.knuckler_cost + run.sack_cost,
  });
  return result.perPiece;
}

// Creates one or more sales + one invoice, atomically, with the exact same
// stock-check, transport, pricing, and invoice-numbering rules as direct
// sale entry. Throws an Error with `.stockError` attached on insufficient
// stock (same shape the /sales/batch route already handles).
//
// items: [{ piece_type_id, quantity, selling_price, gauge_source, transport_to_market? }]
// Returns { saleIds, invoiceId, enrichedCount }
// onAfterInsert (optional): an async callback invoked INSIDE the same
// transaction, immediately after the sale rows + invoice are written, before
// COMMIT. Receives { saleIds, invoiceId }. Use this for any write that must
// land atomically with the sale — e.g. order conversion marking the source
// order 'converted' — rather than running it in a second, separate
// transaction after this one has already committed. If onAfterInsert throws,
// the whole transaction (sale + invoice + the hook's writes) rolls back together.
async function createBatchSaleCore(db, { entry_date, buyer_name, items, userId, userName = null, onAfterInsert = null }) {
  const customerName = (buyer_name && buyer_name.trim()) ? buyer_name.trim() : 'Walk-in Customer';

  // Validate all piece types exist and active
  const pieceTypes = {};
  for (const item of items) {
    if (!pieceTypes[item.piece_type_id]) {
      const pt = await db.prepare('SELECT * FROM piece_types WHERE id=? AND active=1').get(item.piece_type_id);
      if (!pt) {
        const e = new Error(`Piece type ${item.piece_type_id} not found or inactive`);
        e.notFoundError = true;
        throw e;
      }
      pieceTypes[item.piece_type_id] = pt;
    }
  }

  const transport_rate_per_piece = await getCfgNumber(db, 'transport_to_market');

  // Defensive guard: this function is the shared core for every sale-creating
  // entry point (direct sales, order conversion). A NaN quantity would silently
  // bypass the stock-availability check below (`row.quantity > available` is
  // always false when row.quantity is NaN), so garbage is rejected here rather
  // than trusted to have already been validated by the caller.
  for (const item of items) {
    const q = Number(item.quantity);
    if (!Number.isFinite(q) || q <= 0) {
      const e = new Error(`Invalid quantity for piece type ${item.piece_type_id}: must be a positive number`);
      e.validationError = true;
      throw e;
    }
    const p = Number(item.selling_price);
    if (!Number.isFinite(p) || p < 0) {
      const e = new Error(`Invalid selling_price for piece type ${item.piece_type_id}: must be a valid, non-negative number`);
      e.validationError = true;
      throw e;
    }
    // transport_to_market is an optional per-item override; when provided it must
    // be a valid, non-negative number — no route validates this field today, so
    // without this check garbage here would silently become 0 via `|| 0` below.
    if (item.transport_to_market !== undefined && item.transport_to_market !== null && item.transport_to_market !== '') {
      const t = Number(item.transport_to_market);
      if (!Number.isFinite(t) || t < 0) {
        const e = new Error(`Invalid transport_to_market for piece type ${item.piece_type_id}: must be a valid, non-negative number`);
        e.validationError = true;
        throw e;
      }
    }
  }

  const enriched = items.map(item => {
    const pt = pieceTypes[item.piece_type_id];
    const transport_to_market = (item.transport_to_market !== undefined && item.transport_to_market !== null)
      ? parseFloat(item.transport_to_market) || 0
      : transport_rate_per_piece * parseInt(item.quantity);
    return {
      ...item,
      pt,
      quantity: parseInt(item.quantity),
      selling_price: parseFloat(item.selling_price),
      transport_to_market,
      gauge_source: (item.gauge_source || '').trim(),
      price_overridden: parseFloat(item.selling_price) !== parseFloat(pt.default_price) ? 1 : 0,
    };
  });

  const saleIds = [];
  let invoiceId = null;

  await db.transaction(async () => {
    // 1. Stock check for every item (inside transaction for ACID guarantee)
    //
    // IMPORTANT: two or more line items in the SAME batch can share the same
    // piece_type_id + gauge_source (e.g. two rows of the same product sold to
    // different prices/customers in one go). The sales table isn't touched
    // until step 2 below, so a naive per-row DB check would validate every
    // such row against the same stale "sold so far" snapshot and let the
    // batch collectively oversell — each row looks fine alone, but together
    // they exceed what was ever produced. batchReserved tracks quantity
    // already claimed by earlier rows in THIS batch so it's counted too.
    //
    // Both queries below are bounded by entry_date <= this sale's own date —
    // matching exactly what resolveWireCostPerKgForSale uses to attribute
    // cost. Without this bound, a backdated sale (entry_date earlier than
    // the production that would supply it) could pass this stock check by
    // seeing production dated AFTER itself, while cost attribution correctly
    // refuses to see that same future-dated production — silently producing
    // a sale that's allowed but has zero cost basis. Bounding both queries
    // the same way means a sale can only ever draw stock (and cost) from
    // what genuinely existed as of its own date, and the two checks can
    // never disagree with each other again.
    const batchReserved = {}; // key: `${piece_type_id}::${gauge_source}` -> running qty
    for (const row of enriched) {
      const key = `${row.piece_type_id}::${row.gauge_source}`;

      const producedInGauge = await db.prepare(
        `SELECT COALESCE(SUM(pi.pieces_produced),0) AS produced
         FROM production_items pi
         JOIN production pr ON pi.production_id=pr.id
         WHERE pi.piece_type_id=? AND COALESCE(pr.gauge,'')=? AND pr.entry_date <= ?`
      ).get(row.piece_type_id, row.gauge_source, entry_date);

      const soldInGauge = await db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS sold
         FROM sales WHERE piece_type_id=? AND COALESCE(gauge_source, '')=? AND entry_date <= ?`
      ).get(row.piece_type_id, row.gauge_source, entry_date);

      const produced       = parseInt(producedInGauge.produced) || 0;
      const soldAlready     = parseInt(soldInGauge.sold) || 0;
      const claimedInBatch  = batchReserved[key] || 0;
      const available       = produced - soldAlready - claimedInBatch;

      if (row.quantity > available) {
        const gaugeLabel = row.gauge_source || 'unspecified gauge';
        const e = new Error(`Cannot sell ${row.quantity} pieces of ${row.pt.name} (${gaugeLabel}) as of ${entry_date}. Available: ${available}.`);
        e.stockError = { error: 'INSUFFICIENT_STOCK_FOR_GAUGE', message: e.message,
          inventory: { produced, sold: soldAlready + claimedInBatch, available, requested: row.quantity } };
        throw e;
      }

      // Reserve this row's quantity so the NEXT row checking the same
      // piece_type + gauge sees it as already spoken for.
      batchReserved[key] = claimedInBatch + row.quantity;
    }

    // 2. Insert each sale row
    for (const row of enriched) {
      const wireResult = await resolveWireCostPerKgForSale(db, row.piece_type_id, row.gauge_source, entry_date, row.quantity);
      const conversionCostPerPiece = await resolveConversionCostPerPieceForSale(db, row.piece_type_id, entry_date, row.quantity);
      const saleRes = await db.prepare(
        `INSERT INTO sales(entry_date,piece_type_id,quantity,selling_price,default_price,price_overridden,transport_to_market,buyer_name,gauge_source,entered_by,wire_cost_per_kg,wire_cost_per_piece,entered_by_name,conversion_cost_per_piece)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
      ).run(entry_date, row.piece_type_id, row.quantity, row.selling_price,
            row.pt.default_price, row.price_overridden, row.transport_to_market,
            customerName, row.gauge_source, userId, wireResult.wireCostPerKg, wireResult.wireCostPerPiece, userName, conversionCostPerPiece);
      saleIds.push(saleRes.lastInsertRowid);
    }

    // 3. Create ONE invoice for all items
    const prefix = (await db.prepare("SELECT value FROM config WHERE key='invoice_prefix'").get())?.value || 'INV';
    const last   = await db.prepare('SELECT invoice_number FROM invoices WHERE id = (SELECT MAX(id) FROM invoices)').get();
    let seq = 1001;
    if (last?.invoice_number) {
      const parts = last.invoice_number.split('-');
      const n = parseInt(parts[parts.length - 1]);
      if (!isNaN(n)) seq = n + 1;
    }
    const yr     = new Date().getFullYear().toString().slice(-2);
    const invNum = `${prefix}-${yr}-${String(seq).padStart(4,'0')}`;

    const subtotal = enriched.reduce((s, row) =>
      s + parseFloat((row.quantity * row.selling_price).toFixed(2)), 0);
    const subtotalRounded = parseFloat(subtotal.toFixed(2));

    const invRes = await db.prepare(`
      INSERT INTO invoices(
        invoice_number, invoice_date, due_date, customer_name,
        status, subtotal, discount_pct, discount_amount,
        tax_pct, tax_amount, total_amount, amount_paid,
        notes, created_by, sale_id, created_by_name
      ) VALUES(?,?,?,?,'partial_payment',?,0,0,0,0,?,0,?,?,?,?) RETURNING id
    `).run(
      invNum, entry_date, entry_date, customerName,
      subtotalRounded, subtotalRounded,
      `Auto-generated from ${enriched.length} item sale on ${entry_date}`,
      userId, saleIds[0], userName
    );

    if (invRes && invRes.lastInsertRowid) {
      invoiceId = invRes.lastInsertRowid;
      for (const row of enriched) {
        const lineTotal = parseFloat((row.quantity * row.selling_price).toFixed(2));
        await db.prepare(`
          INSERT INTO invoice_items(invoice_id, piece_type_id, description, gauge, quantity, unit_price, line_total)
          VALUES(?,?,?,?,?,?,?)
        `).run(invoiceId, row.piece_type_id, row.pt.name, row.gauge_source,
               row.quantity, row.selling_price, lineTotal);
      }
    }

    if (onAfterInsert) {
      await onAfterInsert({ saleIds, invoiceId });
    }
  });

  return { saleIds, invoiceId, enrichedCount: enriched.length, customerName };
}

module.exports = { getCfgNumber, resolveWireCostPerKgForSale, resolveConversionCostPerPieceForSale, createBatchSaleCore };

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

// Wire cost per kg for a piece type at a point in time — resolved from all
// production runs for that piece type up to and including entryDate.
// Uses production.total_cost minus overheads: the exact stored cost from
// actual FIFO batch draws. Written to sales.wire_cost_per_kg at insert time
// and never changed — permanent record of cost at point of sale.
async function resolveWireCostPerKgForSale(db, pieceTypeId, entryDate) {
  const result = await db.prepare(`
    SELECT
      COALESCE(SUM(pr.total_cost - pr.operator_cost - pr.knuckler_cost - pr.sack_cost - pr.rent_allocation), 0) AS total_wire_cost,
      COALESCE(SUM(pr.kgs_used), 0) AS total_kgs
    FROM production pr
    JOIN production_items pi ON pi.production_id = pr.id
    WHERE pi.piece_type_id = ?
      AND pr.entry_date <= ?
  `).get(pieceTypeId, entryDate);
  return result.total_kgs > 0 ? result.total_wire_cost / result.total_kgs : 0;
}

// Creates one or more sales + one invoice, atomically, with the exact same
// stock-check, transport, pricing, and invoice-numbering rules as direct
// sale entry. Throws an Error with `.stockError` attached on insufficient
// stock (same shape the /sales/batch route already handles).
//
// items: [{ piece_type_id, quantity, selling_price, gauge_source, transport_to_market? }]
// Returns { saleIds, invoiceId, enrichedCount }
async function createBatchSaleCore(db, { entry_date, buyer_name, items, userId }) {
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
    for (const row of enriched) {
      const producedInGauge = await db.prepare(
        `SELECT COALESCE(SUM(pi.pieces_produced),0) AS produced
         FROM production_items pi
         JOIN production pr ON pi.production_id=pr.id
         WHERE pi.piece_type_id=? AND COALESCE(pr.gauge,'')=?`
      ).get(row.piece_type_id, row.gauge_source);

      const soldInGauge = await db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS sold
         FROM sales WHERE piece_type_id=? AND COALESCE(gauge_source, '')=?`
      ).get(row.piece_type_id, row.gauge_source);

      const produced  = parseInt(producedInGauge.produced) || 0;
      const sold      = parseInt(soldInGauge.sold) || 0;
      const available = produced - sold;

      if (row.quantity > available) {
        const gaugeLabel = row.gauge_source || 'unspecified gauge';
        const e = new Error(`Cannot sell ${row.quantity} pieces of ${row.pt.name} (${gaugeLabel}). Available: ${available}.`);
        e.stockError = { error: 'INSUFFICIENT_STOCK_FOR_GAUGE', message: e.message,
          inventory: { produced, sold, available, requested: row.quantity } };
        throw e;
      }
    }

    // 2. Insert each sale row
    for (const row of enriched) {
      const wireCostPerKg = await resolveWireCostPerKgForSale(db, row.piece_type_id, entry_date);
      const saleRes = await db.prepare(
        `INSERT INTO sales(entry_date,piece_type_id,quantity,selling_price,default_price,price_overridden,transport_to_market,buyer_name,gauge_source,entered_by,wire_cost_per_kg)
         VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
      ).run(entry_date, row.piece_type_id, row.quantity, row.selling_price,
            row.pt.default_price, row.price_overridden, row.transport_to_market,
            customerName, row.gauge_source, userId, wireCostPerKg);
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
        notes, created_by, sale_id
      ) VALUES(?,?,?,?,'partial_payment',?,0,0,0,0,?,0,?,?,?) RETURNING id
    `).run(
      invNum, entry_date, entry_date, customerName,
      subtotalRounded, subtotalRounded,
      `Auto-generated from ${enriched.length} item sale on ${entry_date}`,
      userId, saleIds[0]
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
  });

  return { saleIds, invoiceId, enrichedCount: enriched.length, customerName };
}

module.exports = { getCfgNumber, resolveWireCostPerKgForSale, createBatchSaleCore };

// routes/orders.js
//
// Customer orders — a request placed before it becomes a real sale.
// Deliberately kept in its own file, isolated from daily.js/reports.js, so
// nothing here can affect the already-verified sale/reconciliation/report logic.
//
// Design decisions (confirmed with the owner before building):
//   - An order can hold multiple items, like the batch sale entry.
//   - Pending orders do NOT reserve stock — availability is checked only at
//     the moment of conversion, exactly like a normal sale entry would.
//   - Converting an order calls the exact same sale-creation logic used by
//     POST /daily/sales/batch (backend/lib/saleCore.js), so a converted
//     order's resulting sale is indistinguishable from a directly entered
//     sale to reconciliation, reports, COGS, and invoicing.

const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { createBatchSaleCore } = require('../lib/saleCore');
const { isFutureDate } = require('../lib/dateGuard');

// ── GET /orders — list all orders with items + summary counts ────────────────
router.get('/orders', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const orders = await db.prepare(`
      SELECT o.*, COALESCE(o.created_by_name, u.full_name) AS created_by_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.created_by
      ORDER BY o.created_at DESC
    `).all();

    const items = await db.prepare(`
      SELECT oi.*, pt.name AS piece_name
      FROM order_items oi
      JOIN piece_types pt ON pt.id = oi.piece_type_id
    `).all();

    const itemsByOrder = {};
    for (const it of items) {
      (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it);
    }

    const enriched = orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));

    res.json({
      orders: enriched,
      summary: {
        total_orders:     orders.length,
        pending_orders:   orders.filter(o => o.status === 'pending').length,
        converted_orders: orders.filter(o => o.status === 'converted').length,
        cancelled_orders: orders.filter(o => o.status === 'cancelled').length,
      }
    });
  } catch (e) {
    console.error('GET /orders error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /orders — create a pending order (multi-item) ───────────────────────
router.post('/orders', authenticate, async (req, res) => {
  try {
    const { order_date, buyer_name, notes = '', items } = req.body;

    if (!order_date || !/^\d{4}-\d{2}-\d{2}$/.test(order_date) || isNaN(Date.parse(order_date)))
      return res.status(400).json({ error: 'order_date must be a valid date in YYYY-MM-DD format' });
    if (isFutureDate(order_date))
      return res.status(400).json({ error: 'order_date cannot be in the future' });
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'At least one item is required' });

    for (const it of items) {
      const qty = parseInt(it.quantity);
      if (!it.piece_type_id) return res.status(400).json({ error: 'piece_type_id required for every item' });
      if (!qty || qty < 1) return res.status(400).json({ error: 'quantity must be >= 1 for every item' });
    }

    const db = getDb();
    const buyerName = (buyer_name && buyer_name.trim()) ? buyer_name.trim() : 'Walk-in Customer';

    // Confirm every piece type exists (harmless read check — no stock check yet,
    // stock is only checked at conversion, per the confirmed design decision)
    for (const it of items) {
      const pt = await db.prepare('SELECT id FROM piece_types WHERE id=? AND active=1').get(it.piece_type_id);
      if (!pt) return res.status(404).json({ error: `Piece type ${it.piece_type_id} not found or inactive` });
    }

    let orderId;
    await db.transaction(async () => {
      const orderRes = await db.prepare(`
        INSERT INTO orders(order_date, buyer_name, status, notes, created_by, created_by_name)
        VALUES(?,?,'pending',?,?,?) RETURNING id
      `).run(order_date, buyerName, notes, req.user.id, req.user.full_name);
      orderId = orderRes.lastInsertRowid;

      for (const it of items) {
        await db.prepare(`
          INSERT INTO order_items(order_id, piece_type_id, quantity, selling_price, gauge_source, transport_to_market)
          VALUES(?,?,?,?,?,?)
        `).run(orderId, it.piece_type_id, parseInt(it.quantity),
               it.selling_price !== undefined && it.selling_price !== null ? parseFloat(it.selling_price) : null,
               (it.gauge_source || '').trim(),
               it.transport_to_market !== undefined && it.transport_to_market !== null ? parseFloat(it.transport_to_market) : null);
      }
    });

    await writeAudit(db, {
      userId: req.user.id, action: 'CREATE_ORDER', table: 'orders',
      recordId: orderId, newVals: { buyer_name: buyerName, items: items.length }, ip: req.ip
    });

    res.status(201).json({ id: orderId, message: 'Order created' });
  } catch (e) {
    console.error('POST /orders error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /orders/:id/convert — turn a pending order into a real sale ─────────
// Uses the exact same sale-creation logic as direct sale entry (saleCore.js).
// Stock is checked here, at conversion time, per the confirmed design.
router.post('/orders/:id/convert', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const orderId = parseInt(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending')
      return res.status(400).json({ error: `Order is already ${order.status}, cannot convert` });

    const orderItems = await db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    if (!orderItems.length) return res.status(400).json({ error: 'Order has no items' });

    // entry_date for the resulting sale defaults to today unless explicitly given;
    // gauge_source / selling_price can be finalized at conversion time if they
    // weren't set (or need updating) when the order was originally placed.
    const entry_date = req.body.entry_date || order.order_date;
    if (isFutureDate(entry_date))
      return res.status(400).json({ error: 'entry_date cannot be in the future' });
    const overrides = req.body.items || []; // optional: [{ order_item_id, gauge_source, selling_price }]
    const overrideById = {};
    for (const o of overrides) overrideById[o.order_item_id] = o;

    const saleItems = [];
    for (const oi of orderItems) {
      const ov = overrideById[oi.id] || {};
      const gauge_source = (ov.gauge_source !== undefined ? ov.gauge_source : oi.gauge_source) || '';
      let selling_price = ov.selling_price !== undefined ? ov.selling_price : oi.selling_price;
      if (selling_price === undefined || selling_price === null || selling_price === '') {
        const pt = await db.prepare('SELECT default_price FROM piece_types WHERE id=?').get(oi.piece_type_id);
        selling_price = pt ? pt.default_price : null;
      }
      const transport_to_market = ov.transport_to_market !== undefined ? ov.transport_to_market : oi.transport_to_market;
      if (!gauge_source.trim())
        return res.status(400).json({ error: `Wire gauge source is required for order item ${oi.id} before conversion` });
      if (selling_price === undefined || selling_price === null || isNaN(parseFloat(selling_price)) || parseFloat(selling_price) < 0)
        return res.status(400).json({ error: `A valid selling price is required for order item ${oi.id} before conversion` });
      saleItems.push({
        piece_type_id: oi.piece_type_id,
        quantity: oi.quantity,
        selling_price: parseFloat(selling_price),
        gauge_source: gauge_source.trim(),
        // undefined (not null) here means "use the normal config-based default" —
        // matches exactly how direct sale entry treats a blank transport field.
        transport_to_market: (transport_to_market === null || transport_to_market === undefined) ? undefined : parseFloat(transport_to_market),
        _order_item_id: oi.id,
      });
    }

    let result;
    try {
      // ACID: linking order_items to the new sale IDs and flipping the order to
      // 'converted' now happens INSIDE the same transaction as the sale+invoice
      // creation (via onAfterInsert), not in a second transaction afterward. A
      // process crash between two separate transactions used to be able to leave
      // the order stuck 'pending' with a sale already created — a retry of this
      // route would then create a DUPLICATE sale for the same order. Now it's
      // all-or-nothing: either the sale, invoice, and order-conversion all land
      // together, or none of them do.
      result = await createBatchSaleCore(db, {
        entry_date, buyer_name: order.buyer_name, items: saleItems, userId: req.user.id, userName: req.user.full_name,
        onAfterInsert: async ({ saleIds, invoiceId }) => {
          for (let i = 0; i < saleItems.length; i++) {
            await db.prepare('UPDATE order_items SET sale_id=? WHERE id=?')
              .run(saleIds[i], saleItems[i]._order_item_id);
          }
          await db.prepare(`
            UPDATE orders SET status='converted', converted_at=CURRENT_TIMESTAMP, invoice_id=? WHERE id=?
          `).run(invoiceId, orderId);
        }
      });
    } catch (e) {
      if (e.stockError) return res.status(400).json(e.stockError);
      if (e.notFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }

    await writeAudit(db, {
      userId: req.user.id, action: 'CONVERT_ORDER_TO_SALE', table: 'orders',
      recordId: orderId, newVals: { sale_ids: result.saleIds, invoice_id: result.invoiceId }, ip: req.ip
    });

    res.json({ message: 'Order converted to sale', sale_ids: result.saleIds, invoice_id: result.invoiceId });
  } catch (e) {
    console.error('POST /orders/:id/convert error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /orders/:id/cancel — mark a pending order cancelled (no data deleted) ─
router.post('/orders/:id/cancel', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const orderId = parseInt(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending')
      return res.status(400).json({ error: `Order is already ${order.status}, cannot cancel` });

    await db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(orderId);
    await writeAudit(db, { userId: req.user.id, action: 'CANCEL_ORDER', table: 'orders', recordId: orderId, ip: req.ip });
    res.json({ message: 'Order cancelled' });
  } catch (e) {
    console.error('POST /orders/:id/cancel error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

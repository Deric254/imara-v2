// routes/invoices.js — IMARA LINKS Customer Invoices (ACID)
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { writeNotification } = require('./reports');

const OWNER_ADMIN = [authenticate, requireRole('owner','admin')];
const num = v => parseFloat(v) || 0;

// ── Generate invoice number ───────────────────────────────────────────────────
// Uses MAX(id) rather than ORDER BY id DESC LIMIT 1 so that deleting the most
// recent invoice does not cause the sequence to regenerate an already-used number.
// The sequence therefore only ever increases.
async function nextInvoiceNumber(db) {
  const prefix = (await db.prepare("SELECT value FROM config WHERE key='invoice_prefix'").get())?.value || 'INV';
  const maxRow = await db.prepare(
    `SELECT invoice_number FROM invoices WHERE id = (SELECT MAX(id) FROM invoices)`
  ).get();
  let seq = 1001;
  if (maxRow?.invoice_number) {
    const parts = maxRow.invoice_number.split('-');
    const n = parseInt(parts[parts.length - 1]);
    if (!isNaN(n)) seq = n + 1;
  }
  const yr = new Date().getFullYear().toString().slice(-2);
  return `${prefix}-${yr}-${String(seq).padStart(4,'0')}`;
}

// ── Compute invoice totals ────────────────────────────────────────────────────
function computeTotals(items, discountPct, taxPct) {
  const subtotal       = items.reduce((s, i) => s + num(i.unit_price) * num(i.quantity), 0);
  const discountAmount = parseFloat((subtotal * num(discountPct) / 100).toFixed(2));
  const afterDiscount  = subtotal - discountAmount;
  const taxAmount      = parseFloat((afterDiscount * num(taxPct) / 100).toFixed(2));
  const total          = parseFloat((afterDiscount + taxAmount).toFixed(2));
  return {
    subtotal:        parseFloat(subtotal.toFixed(2)),
    discount_pct:    num(discountPct),
    discount_amount: discountAmount,
    tax_pct:         num(taxPct),
    tax_amount:      taxAmount,
    total_amount:    total,
  };
}

// ── Calculate invoice status based on payment ───────────────────────────────
function calculateInvoiceStatus(amountPaid, totalAmount, explicitStatus) {
  if (explicitStatus === 'cancelled') return 'cancelled';
  const paid  = num(amountPaid);
  const total = num(totalAmount);
  if (paid > 0 && paid >= total) return 'paid';
  return 'partial_payment'; // covers 0-paid (awaiting) and partial
}

// ── GET /api/invoices/search  — full-text search by name/number/amount ────────
router.get('/search', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db = getDb();
    const q  = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const numQ = parseFloat(q);
    const likeQ = `%${q}%`;

    const results = await db.prepare(`
      SELECT i.*, u.full_name AS created_by_name
      FROM invoices i
      JOIN users u ON i.created_by = u.id
      WHERE
        i.customer_name    ILIKE ?
        OR i.invoice_number ILIKE ?
        OR i.customer_phone ILIKE ?
        OR i.customer_email ILIKE ?
        OR i.notes          ILIKE ?
        OR CAST(i.total_amount AS TEXT) LIKE ?
        OR CAST(i.invoice_date AS TEXT) LIKE ?
      ORDER BY i.invoice_date DESC, i.id DESC
      LIMIT 50
    `).all(likeQ, likeQ, likeQ, likeQ, likeQ, likeQ, likeQ);

    res.json(results);
  } catch(e) {
    console.error('GET invoices/search error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/invoices  ────────────────────────────────────────────────────────
router.get('/', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db     = getDb();
    const from   = req.query.from   || '2000-01-01';
    const to     = req.query.to     || '2099-12-31';
    const status = req.query.status || null;

    let sql = `
      SELECT i.*, u.full_name AS created_by_name
      FROM invoices i
      JOIN users u ON i.created_by = u.id
      WHERE i.invoice_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (status) { sql += ' AND i.status = ?'; params.push(status); }
    sql += ' ORDER BY i.invoice_date DESC, i.id DESC';

    res.json(await db.prepare(sql).all(...params));
  } catch(e) {
    console.error('GET invoices error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/invoices/summary/stats  — Invoice KPIs ─────────────────────────
router.get('/summary/stats', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';
    const stats = await db.prepare(`
      SELECT
        COUNT(*)                                                                   AS total_invoices,
        COALESCE(SUM(total_amount) FILTER(WHERE status != 'cancelled'),0)          AS total_billed,
        COALESCE(SUM(amount_paid)  FILTER(WHERE status != 'cancelled'),0)          AS total_collected,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount - amount_paid ELSE 0 END),0) AS total_outstanding,
        COUNT(*) FILTER(WHERE status='paid')                                        AS paid_count,
        COUNT(*) FILTER(WHERE status='partial_payment')                             AS partial_payment_count,
        COUNT(*) FILTER(WHERE status='cancelled')                                   AS cancelled_count
      FROM invoices
      WHERE invoice_date BETWEEN ? AND ?
    `).get(from, to);

    const topCustomers = await db.prepare(`
      SELECT customer_name,
             COUNT(*) AS invoice_count,
             ROUND(SUM(total_amount),2) AS total_billed,
             ROUND(SUM(amount_paid),2)  AS total_paid
      FROM invoices
      WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'
      GROUP BY customer_name ORDER BY total_billed DESC LIMIT 10
    `).all(from, to);

    res.json({
      period: { from, to },
      totals: {
        total_invoices:        parseInt(stats.total_invoices)||0,
        total_billed:          parseFloat(stats.total_billed)||0,
        total_collected:       parseFloat(stats.total_collected)||0,
        total_outstanding:     parseFloat(stats.total_outstanding)||0,
        paid_count:            parseInt(stats.paid_count)||0,
        partial_payment_count: parseInt(stats.partial_payment_count)||0,
        cancelled_count:       parseInt(stats.cancelled_count)||0,
      },
      top_customers: topCustomers,
    });
  } catch(e) {
    console.error('GET invoice stats error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/invoices/:id  ────────────────────────────────────────────────────
router.get('/:id', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const inv = await db.prepare(`
      SELECT i.*, u.full_name AS created_by_name
      FROM invoices i JOIN users u ON i.created_by = u.id
      WHERE i.id = ?
    `).get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const items = await db.prepare(`
      SELECT ii.*, pt.name AS piece_type_name
      FROM invoice_items ii
      LEFT JOIN piece_types pt ON ii.piece_type_id = pt.id
      WHERE ii.invoice_id = ?
      ORDER BY ii.id
    `).all(id);
    const config = await db.prepare(`
      SELECT key, value FROM config
      WHERE key IN ('business_name','business_slogan','currency','invoice_prefix','invoice_tax_pct')
    `).all();
    const cfg = {};
    for (const c of config) cfg[c.key] = c.value;
    res.json({ ...inv, items, config: cfg });
  } catch(e) {
    console.error('GET invoice/:id error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/invoices  — ACID: invoice + items in one transaction ────────────
router.post('/', ...OWNER_ADMIN,
  body('customer_name').notEmpty().trim(),
  body('invoice_date').notEmpty(),
  body('items').isArray({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const db = getDb();
      const {
        customer_name, customer_phone = '', customer_email = '',
        customer_address = '', invoice_date, due_date = '',
        discount_pct = 0, notes = '', amount_paid = 0,
        items,
      } = req.body;

      if (!items?.length) return res.status(400).json({ error: 'At least one item required' });

      // Validate items
      for (const [i, item] of items.entries()) {
        if (!item.description?.trim()) return res.status(400).json({ error: `Item ${i+1}: description required` });
        if (!(num(item.quantity) > 0)) return res.status(400).json({ error: `Item ${i+1}: quantity must be > 0` });
        if (num(item.unit_price) < 0) return res.status(400).json({ error: `Item ${i+1}: price cannot be negative` });
      }

      const taxPct = parseFloat((await db.prepare("SELECT value FROM config WHERE key='invoice_tax_pct'").get())?.value || 0);
      const totals = computeTotals(items, discount_pct, taxPct);

      // SAFEGUARD: amount_paid can never exceed the invoice total
      if (num(amount_paid) > totals.total_amount + 0.005) {
        return res.status(400).json({ error: `Overpayment not allowed. Amount paid (${num(amount_paid).toFixed(2)}) cannot exceed invoice total (${totals.total_amount.toFixed(2)}).` });
      }

      // Status is auto-calculated: if amount_paid >= total_amount → "paid", else "partial_payment"
      const autoStatus = calculateInvoiceStatus(amount_paid, totals.total_amount, null);

      // ACID transaction — invoice + all items inserted atomically
      const result = await db.transaction(async () => {
        const invNum = await nextInvoiceNumber(db);
        const inv = await db.prepare(`
          INSERT INTO invoices(
            invoice_number, invoice_date, due_date, customer_name,
            customer_phone, customer_email, customer_address, status,
            subtotal, discount_pct, discount_amount, tax_pct, tax_amount,
            total_amount, amount_paid, notes, created_by
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
        `).run(
          invNum, invoice_date, due_date||'', customer_name.trim(),
          customer_phone, customer_email, customer_address,
          autoStatus,
          totals.subtotal, totals.discount_pct, totals.discount_amount,
          totals.tax_pct, totals.tax_amount, totals.total_amount,
          num(amount_paid), notes.trim(), req.user.id
        );
        const invId = inv.lastInsertRowid;

        for (const item of items) {
          const lineTotal = parseFloat((num(item.quantity) * num(item.unit_price)).toFixed(2));
          await db.prepare(`
            INSERT INTO invoice_items(invoice_id, piece_type_id, description, gauge, quantity, unit_price, line_total)
            VALUES(?,?,?,?,?,?,?)
          `).run(
            invId,
            item.piece_type_id ? parseInt(item.piece_type_id) : null,
            item.description.trim(),
            item.gauge || '',
            parseInt(item.quantity),
            num(item.unit_price),
            lineTotal
          );
        }

        // CRITICAL: if payment was collected at reception, record it in the cash ledger
        // so cash-basis revenue is immediately accurate
        const paid = num(amount_paid);
        if (paid > 0) {
          const payMethod = req.body.payment_method || 'cash';
          await db.prepare(`
            INSERT INTO invoice_payments(invoice_id, payment_date, amount, payment_method, notes, recorded_by)
            VALUES(?,?,?,?,?,?)
          `).run(invId, invoice_date, paid, payMethod, 'Collected at invoice creation', req.user.id);
        }

        return invId;
      });

      await writeAudit(db, {
        userId: req.user.id, action: 'CREATE_INVOICE',
        table: 'invoices', recordId: result,
        newVals: { customer_name, total_amount: totals.total_amount },
        ip: req.ip,
      });

      const created = await db.prepare(`
        SELECT i.*, u.full_name AS created_by_name FROM invoices i
        JOIN users u ON i.created_by = u.id WHERE i.id = ?
      `).get(result);
      const createdItems = await db.prepare(
        'SELECT ii.*, pt.name AS piece_type_name FROM invoice_items ii LEFT JOIN piece_types pt ON ii.piece_type_id = pt.id WHERE ii.invoice_id = ? ORDER BY ii.id'
      ).all(result);

      res.status(201).json({ ...created, items: createdItems });
    } catch(e) {
      console.error('POST invoice error:', e);
      res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }
);

// ── PUT /api/invoices/:id  — ACID update ─────────────────────────────────────
router.put('/:id', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const old = await db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!old) return res.status(404).json({ error: 'Invoice not found' });
    if (old.status === 'cancelled') return res.status(400).json({ error: 'Cannot edit a cancelled invoice' });
    // Block setting cancelled via PUT — use PATCH /:id/cancel for proper audit trail
    if (req.body.status === 'cancelled') return res.status(400).json({ error: 'Use the Cancel action to cancel an invoice. Direct status override is not allowed.' });

    const {
      customer_name, customer_phone, customer_email,
      customer_address, invoice_date, due_date,
      discount_pct = 0, notes, status, amount_paid,
      items,
    } = req.body;

    if (items && !items.length) return res.status(400).json({ error: 'At least one item required' });

    const taxPct = parseFloat((await db.prepare("SELECT value FROM config WHERE key='invoice_tax_pct'").get())?.value || 0);

    // SAFEGUARD: validate before entering transaction — amount_paid must not exceed new total
    if (items) {
      const preCheckTotals = computeTotals(items, discount_pct, taxPct);
      const preCheckPaid   = amount_paid != null ? num(amount_paid) : num(old.amount_paid);
      if (preCheckPaid > preCheckTotals.total_amount + 0.005) {
        return res.status(400).json({ error: `Overpayment not allowed. Amount paid (${preCheckPaid.toFixed(2)}) would exceed the new invoice total (${preCheckTotals.total_amount.toFixed(2)}). Reduce amount_paid first.` });
      }
    } else {
      // Status-only / payment-only path
      const preCheckPaid = amount_paid != null ? num(amount_paid) : num(old.amount_paid);
      if (preCheckPaid > num(old.total_amount) + 0.005) {
        return res.status(400).json({ error: `Overpayment not allowed. Amount paid (${preCheckPaid.toFixed(2)}) cannot exceed invoice total (${num(old.total_amount).toFixed(2)}).` });
      }
    }

    await db.transaction(async () => {
      if (items) {
        const totals = computeTotals(items, discount_pct, taxPct);
        const newAmountPaid = amount_paid != null ? num(amount_paid) : old.amount_paid;
        const autoStatus = calculateInvoiceStatus(newAmountPaid, totals.total_amount, status);
        await db.prepare(`
          UPDATE invoices SET
            invoice_date=?, due_date=?, customer_name=?, customer_phone=?,
            customer_email=?, customer_address=?, status=?,
            subtotal=?, discount_pct=?, discount_amount=?, tax_pct=?,
            tax_amount=?, total_amount=?, amount_paid=?, notes=?, updated_at=datetime('now')
          WHERE id=?
        `).run(
          invoice_date||old.invoice_date, due_date??old.due_date,
          customer_name||old.customer_name, customer_phone??old.customer_phone,
          customer_email??old.customer_email, customer_address??old.customer_address,
          autoStatus,
          totals.subtotal, totals.discount_pct, totals.discount_amount,
          totals.tax_pct, totals.tax_amount, totals.total_amount,
          newAmountPaid,
          notes??old.notes, id
        );
        // Replace items atomically
        await db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
        for (const item of items) {
          const lineTotal = parseFloat((num(item.quantity) * num(item.unit_price)).toFixed(2));
          await db.prepare(`
            INSERT INTO invoice_items(invoice_id, piece_type_id, description, gauge, quantity, unit_price, line_total)
            VALUES(?,?,?,?,?,?,?)
          `).run(
            id,
            item.piece_type_id ? parseInt(item.piece_type_id) : null,
            item.description.trim(), item.gauge||'',
            parseInt(item.quantity), num(item.unit_price), lineTotal
          );
        }
        // If amount_paid increased, record the delta in invoice_payments
        const delta = parseFloat((newAmountPaid - num(old.amount_paid)).toFixed(2));
        if (delta > 0) {
          const payMethod = req.body.payment_method || 'cash';
          const payDate   = invoice_date || old.invoice_date;
          await db.prepare(`
            INSERT INTO invoice_payments(invoice_id, payment_date, amount, payment_method, notes, recorded_by)
            VALUES(?,?,?,?,?,?)
          `).run(id, payDate, delta, payMethod, 'Recorded via invoice edit', req.user.id);
        }
      } else {
        // Status-only / payment-only update
        const newAmountPaid = amount_paid != null ? num(amount_paid) : old.amount_paid;
        const autoStatus = calculateInvoiceStatus(newAmountPaid, old.total_amount, status);
        await db.prepare(`
          UPDATE invoices SET status=?, amount_paid=?, updated_at=datetime('now') WHERE id=?
        `).run(autoStatus, newAmountPaid, id);
        // Record payment delta in cash ledger
        const delta = parseFloat((newAmountPaid - num(old.amount_paid)).toFixed(2));
        if (delta > 0) {
          const payMethod = req.body.payment_method || 'cash';
          const payDate   = req.body.payment_date || old.invoice_date;
          await db.prepare(`
            INSERT INTO invoice_payments(invoice_id, payment_date, amount, payment_method, notes, recorded_by)
            VALUES(?,?,?,?,?,?)
          `).run(id, payDate, delta, payMethod, 'Recorded via invoice update', req.user.id);
        }
      }
    });

    await writeAudit(db, { userId: req.user.id, action: 'UPDATE_INVOICE', table: 'invoices', recordId: id, oldVals: old, ip: req.ip });

    const updated = await db.prepare(`
      SELECT i.*, u.full_name AS created_by_name FROM invoices i
      JOIN users u ON i.created_by = u.id WHERE i.id = ?
    `).get(id);
    const updatedItems = await db.prepare(
      'SELECT ii.*, pt.name AS piece_type_name FROM invoice_items ii LEFT JOIN piece_types pt ON ii.piece_type_id = pt.id WHERE ii.invoice_id = ? ORDER BY ii.id'
    ).all(id);
    res.json({ ...updated, items: updatedItems });
  } catch(e) {
    console.error('PUT invoice error:', e);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});


// ── GET /api/invoices/:id/payments  — List all cash receipts for an invoice ───
router.get('/:id/payments', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const inv = await db.prepare('SELECT id, invoice_number, total_amount, amount_paid, status FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const payments = await db.prepare(`
      SELECT ip.*, u.full_name AS recorded_by_name
      FROM invoice_payments ip JOIN users u ON ip.recorded_by = u.id
      WHERE ip.invoice_id = ?
      ORDER BY ip.payment_date DESC, ip.created_at DESC
    `).all(id);
    res.json({ invoice: inv, payments });
  } catch(e) {
    console.error('GET invoice payments error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/invoices/:id/cash  — Record partial/full payment ────────────────
router.post('/:id/cash', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const inv = await db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'cancelled') return res.status(400).json({ error: 'Cannot pay a cancelled invoice' });

    const { amount_paid, payment_method = 'cash', payment_date, notes = '' } = req.body;
    if (!amount_paid || parseFloat(amount_paid) <= 0)
      return res.status(400).json({ error: 'amount_paid must be > 0' });
    if (!payment_date)
      return res.status(400).json({ error: 'payment_date required' });

    const paid = parseFloat(amount_paid);
    // Pre-flight overpayment check against the current aggregate
    if (paid + num(inv.amount_paid) > num(inv.total_amount) + 0.005)
      return res.status(400).json({ error: `Overpayment not allowed. Outstanding balance is ${(num(inv.total_amount) - num(inv.amount_paid)).toFixed(2)}` });

    // Declared outside the transaction (let, not const) so it's still in scope
    // afterward for writeAudit/notification below — this matches the original
    // working version's scope, just adapted for the ledger-sum recalculation
    // that now happens inside the transaction.
    let autoStatus;
    let newTotalPaid;

    await db.transaction(async () => {
      // Write the discrete payment into the cash ledger first
      await db.prepare(`
        INSERT INTO invoice_payments(invoice_id, payment_date, amount, payment_method, notes, recorded_by)
        VALUES(?,?,?,?,?,?)
      `).run(id, payment_date, paid, payment_method, notes || '', req.user.id);

      // Re-derive amount_paid from the ledger sum INSIDE the transaction so the
      // denormalised column is always exactly equal to Σ(invoice_payments.amount).
      // This is the single authoritative calculation — no arithmetic on old values.
      const sumRow = await db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS total FROM invoice_payments WHERE invoice_id=?`
      ).get(id);
      newTotalPaid = parseFloat(parseFloat(sumRow.total).toFixed(2));
      autoStatus   = calculateInvoiceStatus(newTotalPaid, inv.total_amount, null);

      await db.prepare(`
        UPDATE invoices
        SET status=?, amount_paid=?, updated_at=datetime('now')
        WHERE id=?
      `).run(autoStatus, newTotalPaid, id);
    });

    await writeAudit(db, {
      userId: req.user.id,
      action: 'RECORD_CASH_PAYMENT',
      table: 'invoices',
      recordId: id,
      oldVals: { status: inv.status, amount_paid: inv.amount_paid },
      newVals: { status: autoStatus, amount_paid: newTotalPaid, payment_method, payment_date, this_payment: paid },
      ip: req.ip,
    });

    // Notify owner of payment received
    const isNowPaid = autoStatus === 'paid';
    writeNotification(db, {
      roleTarget: 'owner',
      type: 'info',
      category: 'invoice',
      title: isNowPaid ? `Invoice Fully Paid` : `Payment Received`,
      message: isNowPaid
        ? `Invoice ${inv.invoice_number} for ${inv.customer_name} has been fully settled. Total: KES ${newTotalPaid.toLocaleString()}.`
        : `KES ${paid.toLocaleString()} received from ${inv.customer_name} on invoice ${inv.invoice_number}. Remaining balance: KES ${(parseFloat(inv.total_amount) - newTotalPaid).toFixed(2)}.`
    }).catch(() => {});

    const updated = await db.prepare(`
      SELECT i.*, u.full_name AS created_by_name
      FROM invoices i JOIN users u ON i.created_by = u.id
      WHERE i.id = ?
    `).get(id);

    const payments = await db.prepare(`
      SELECT ip.*, u.full_name AS recorded_by_name
      FROM invoice_payments ip JOIN users u ON ip.recorded_by = u.id
      WHERE ip.invoice_id = ?
      ORDER BY ip.payment_date DESC, ip.created_at DESC
    `).all(id);

    res.json({ message: 'Payment recorded successfully', invoice: updated, payments });
  } catch(e) {
    console.error('RECORD PAYMENT error:', e);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

// ── DELETE /api/invoices/:id  — ACID cascade ─────────────────────────────────
router.delete('/:id', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const row = await db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Invoice not found' });

    // Block if this is an auto-generated invoice tied to a live sale
    if (row.sale_id) {
      return res.status(400).json({
        error: 'INTEGRITY_VIOLATION',
        message: `Cannot delete invoice ${row.invoice_number} — it was auto-generated from a sale record. Delete the sale itself from the Daily page instead, which will remove this invoice automatically.`
      });
    }

    // Block hard-delete of any invoice with money collected — deletion silently erases revenue
    const paidAmount = parseFloat(row.amount_paid) || 0;
    if (row.status === 'paid' || paidAmount > 0) {
      return res.status(400).json({
        error: 'INTEGRITY_VIOLATION',
        message: `Cannot delete invoice ${row.invoice_number} — KES ${paidAmount.toLocaleString()} has already been collected. Use Cancel instead to close it while keeping the full audit trail and payment history intact.`
      });
    }

    await db.transaction(async () => {
      // Cascade: remove all payment records and line items first
      await db.prepare('DELETE FROM invoice_payments WHERE invoice_id=?').run(id);
      await db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
      await db.prepare('DELETE FROM invoices WHERE id=?').run(id);
    });

    await writeAudit(db, { userId: req.user.id, action: 'DELETE_INVOICE', table: 'invoices', recordId: id, oldVals: row, ip: req.ip });
    res.json({ message: `Invoice ${row.invoice_number} deleted successfully.` });
  } catch(e) {
    console.error('DELETE invoice error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/invoices/:id/cancel  — Safe cancellation (keeps audit trail) ──
router.patch('/:id/cancel', ...OWNER_ADMIN, async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const row = await db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    if (row.status === 'cancelled') return res.status(400).json({ error: 'Invoice is already cancelled.' });

    const reason = (req.body.reason || '').trim();
    const paidAmount = parseFloat(row.amount_paid) || 0;
    const isAutoInvoice = !!row.sale_id;

    // If money was already collected, cancellation is allowed but warn the user
    // The invoice record and its payments remain for audit — only status changes
    await db.prepare(`
      UPDATE invoices SET status='cancelled', notes=?, updated_at=datetime('now') WHERE id=?
    `).run(
      (row.notes ? row.notes + '\n' : '') + `CANCELLED on ${new Date().toISOString().split('T')[0]}` + (reason ? `: ${reason}` : '.'),
      id
    );

    await writeAudit(db, {
      userId: req.user.id, action: 'CANCEL_INVOICE', table: 'invoices', recordId: id,
      oldVals: { status: row.status, amount_paid: row.amount_paid },
      newVals: { status: 'cancelled', reason },
      ip: req.ip,
    });

    // Notify owner if cancellation involved money already paid
    if (paidAmount > 0) {
      writeNotification(db, {
        roleTarget: 'owner',
        type: 'warn',
        category: 'invoice',
        title: 'Invoice Cancelled — With Payments',
        message: `Invoice ${row.invoice_number} (${row.customer_name}) was cancelled, but KES ${paidAmount.toLocaleString()} was already collected. Please review and handle the refund or credit accordingly.`
      }).catch(() => {});
    }

    const updated = await db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    const warnings = [];
    if (paidAmount > 0) warnings.push(`KES ${paidAmount.toLocaleString()} was already collected — issue a refund or credit note.`);
    if (isAutoInvoice) warnings.push(`This invoice was auto-generated from a sale. The underlying sale record still exists and still shows in your daily records and stock. If you want to fully reverse the sale, delete it from the Daily page.`);
    const warningMsg = warnings.length ? ' Note: ' + warnings.join(' ') : '';
    res.json({ message: `Invoice ${row.invoice_number} has been cancelled.${warningMsg}`, invoice: updated, warnings });
  } catch(e) {
    console.error('CANCEL invoice error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

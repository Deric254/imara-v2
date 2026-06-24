// routes/daily.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { getDb }  = require('../db');
const { authenticate, requireRole, writeAudit } = require('../middleware/auth');
const { checkAndNotifyStock } = require('./reports');

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysAgo(days) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
}

// ── Yesterday-missing check ───────────────────────────────────────────────────
async function yesterdayMissing(db) {
  const yDate = localDateString(daysAgo(1));
  const oldest = await db.prepare('SELECT MIN(entry_date) as d FROM purchases').get();
  if (!oldest || !oldest.d || oldest.d >= yDate) return false;
  const p  = (await db.prepare('SELECT COUNT(*) as c FROM purchases  WHERE entry_date=?').get(yDate)).c;
  const pr = (await db.prepare('SELECT COUNT(*) as c FROM production WHERE entry_date=?').get(yDate)).c;
  const s  = (await db.prepare('SELECT COUNT(*) as c FROM sales      WHERE entry_date=?').get(yDate)).c;
  return p === 0 && pr === 0 && s === 0;
}

async function blockProductionStaff(req, res, next) {
  if (req.user.role !== 'knuckler' && req.user.role !== 'operator') return next();
  const db = getDb();
  if (await yesterdayMissing(db))
    return res.status(403).json({
      error: 'BLOCKED', blocked: true,
      message: "Yesterday's data has not been entered. Please enter yesterday's data first."
    });
  next();
}

async function getCfgNumber(db, key) {
  return parseFloat((await db.prepare('SELECT value FROM config WHERE key=?').get(key))?.value || 0);
}

// ── Default batch naming: SupplierName-mmmDDyyyy-N (N increments per supplier) ──
function slugifySupplierName(name) {
  return (name || 'Supplier').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24) || 'Supplier';
}
function batchDateCode(entryDateStr) {
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const [y, m, d] = (entryDateStr || '').split('-');
  const mi = Math.max(0, Math.min(11, (parseInt(m, 10) || 1) - 1));
  return `${MONTHS[mi]}${String(d || '').padStart(2, '0')}${y || ''}`;
}
async function nextDefaultBatchName(db, supplierId, supplierName, entryDateStr) {
  const seqRow = await db.prepare('SELECT COUNT(*) AS c FROM purchases WHERE supplier_id=?').get(supplierId);
  const seq = (parseInt(seqRow?.c) || 0) + 1;
  return `${slugifySupplierName(supplierName)}-${batchDateCode(entryDateStr)}-${seq}`;
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

async function getProductionCostBreakdown(db, totalPieces, kgsUsed, wireCostPerKg) {
  const operatorRate  = await getCfgNumber(db, 'operator_cost');
  const knucklerRate  = await getCfgNumber(db, 'knuckler_cost');
  const sackRate      = await getCfgNumber(db, 'sack_cost');

  const wire_cost      = wireCostPerKg * kgsUsed;
  const operator_cost  = operatorRate * totalPieces;
  const knuckler_cost  = knucklerRate * totalPieces;
  const sack_cost      = sackRate * totalPieces * 2;
  const rent_allocation = 0;
  const total_cost     = wire_cost + operator_cost + knuckler_cost + sack_cost + rent_allocation;

  return { wire_cost_per_kg: wireCostPerKg, wire_cost, operator_cost, knuckler_cost, sack_cost, rent_allocation, total_cost };
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const db        = getDb();
    const today     = localDateString();
    const yesterday = localDateString(daysAgo(1));
    const check = async date => ({
      purchases:  (await db.prepare('SELECT COUNT(*) as c FROM purchases  WHERE entry_date=?').get(date)).c > 0,
      production: (await db.prepare('SELECT COUNT(*) as c FROM production WHERE entry_date=?').get(date)).c > 0,
      sales:      (await db.prepare('SELECT COUNT(*) as c FROM sales      WHERE entry_date=?').get(date)).c > 0,
    });
    res.json({
      today:     { date: today,     ...await check(today)     },
      yesterday: { date: yesterday, ...await check(yesterday) },
      blocked:   (req.user.role === 'knuckler' || req.user.role === 'operator') && await yesterdayMissing(db),
    });
  } catch(e) {
    console.error('Status error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* POST /api/daily/dismiss-warning — logs audit when operator/knuckler dismisses the missing-data reminder */
router.post('/dismiss-warning', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await writeAudit(db, {
      userId: req.user.id,
      action: 'DISMISSED_MISSING_DATA_REMINDER',
      ip: req.ip
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/production-cost-inputs', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const result = await db.prepare(`
      SELECT
        COALESCE(SUM(total_cost - operator_cost - knuckler_cost - sack_cost - rent_allocation), 0) AS total_wire_cost,
        COALESCE(SUM(kgs_used), 0) AS total_kgs
      FROM production
      WHERE entry_date <= ?
    `).get(today);
    const wireCostPerKg = result.total_kgs > 0
      ? parseFloat((result.total_wire_cost / result.total_kgs).toFixed(2))
      : 0;
    res.json({
      wire_cost_per_kg: wireCostPerKg,
      operator_rate:    await getCfgNumber(db, 'operator_cost'),
      knuckler_rate:    await getCfgNumber(db, 'knuckler_cost'),
      sack_rate:        await getCfgNumber(db, 'sack_cost'),
    });
  } catch (e) {
    console.error('Production cost inputs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════════
// PURCHASES
// ══════════════════════════════════════════════════════════════════

/* GET /api/daily/purchases */
router.get('/purchases', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { date, from, to } = req.query;
    // FIX: ROUND(float, 2) requires  cast in PostgreSQL
    let sql = `SELECT p.*, s.name AS supplier_name, u.full_name AS entered_by_name,
                 ROUND((p.kgs_bought * p.cost_per_kg + p.transport_cost), 2) AS total_cost,
                 CASE WHEN p.kgs_bought>0
                   THEN ROUND(((p.kgs_bought*p.cost_per_kg+p.transport_cost)/p.kgs_bought),2)
                   ELSE 0 END AS landed_cost_per_kg
               FROM purchases p
               JOIN suppliers s ON p.supplier_id=s.id
               JOIN users u ON p.entered_by=u.id`;
    const params = [], conds = [];
    if (date)       { conds.push('p.entry_date=?');               params.push(date); }
    else if (from)  { conds.push('p.entry_date BETWEEN ? AND ?'); params.push(from, to || from); }
    if (req.user.role === 'knuckler' || req.user.role === 'operator') { conds.push('p.entered_by=?'); params.push(req.user.id); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY p.entry_date DESC, p.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  } catch(e) {
    console.error('GET purchases error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* POST /api/daily/purchases */
router.post('/purchases', authenticate, blockProductionStaff,
  body('entry_date').isISO8601().withMessage('Valid date required'),
  body('supplier_id').isInt({ min: 1 }).withMessage('Supplier required'),
  body('kgs_bought').isFloat({ min: 0.001 }).withMessage('Kgs must be > 0'),
  body('cost_per_kg').isFloat({ min: 0 }).withMessage('Cost/kg must be >= 0'),
  body('transport_cost').optional().isFloat({ min: 0 }),
  body('gauge').optional().trim(),
  body('batch_name').optional().trim().isLength({ max: 80 }).withMessage('Batch name must be 80 characters or fewer'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const { entry_date, supplier_id, kgs_bought, cost_per_kg, transport_cost = 0, gauge = '', batch_name = '' } = req.body;
      const db = getDb();
      const supplier = await db.prepare('SELECT id, name FROM suppliers WHERE id=? AND active=1').get(supplier_id);
      if (!supplier)
        return res.status(404).json({ error: 'Supplier not found' });

      let newId;
      await db.transaction(async () => {
        // Default name when the user leaves Batch Name blank — they can rename
        // it any time afterwards via PUT /purchases/:id/batch-name.
        const finalBatchName = (batch_name || '').trim()
          ? batch_name.trim()
          : await nextDefaultBatchName(db, supplier_id, supplier.name, entry_date);

        // FIX: RETURNING id so PostgreSQL returns the new row's id
        // kgs_remaining starts equal to kgs_bought — this batch's stock pool,
        // drawn down only by production runs that explicitly select it (rule 4).
        const result = await db.prepare(
          'INSERT INTO purchases(entry_date,supplier_id,kgs_bought,cost_per_kg,transport_cost,gauge,batch_name,kgs_remaining,entered_by) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id'
        ).run(entry_date, supplier_id, kgs_bought, cost_per_kg, transport_cost, gauge, finalBatchName, kgs_bought, req.user.id);
        newId = result.lastInsertRowid;
      });

      await writeAudit(db, { userId: req.user.id, action: 'CREATE_PURCHASE', table: 'purchases',
        recordId: newId, ip: req.ip });

      const row = await db.prepare(`
        SELECT p.*, s.name AS supplier_name, u.full_name AS entered_by_name,
          ROUND((p.kgs_bought*p.cost_per_kg+p.transport_cost),2) AS total_cost,
          CASE WHEN p.kgs_bought>0
            THEN ROUND(((p.kgs_bought*p.cost_per_kg+p.transport_cost)/p.kgs_bought),2)
            ELSE 0 END AS landed_cost_per_kg
        FROM purchases p
        JOIN suppliers s ON p.supplier_id=s.id
        JOIN users u ON p.entered_by=u.id
        WHERE p.id=?`).get(newId);
      res.status(201).json(row);
    } catch(e) {
      console.error('POST purchases error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* PUT /api/daily/purchases/:id/batch-name — rename a batch any time (default name is just a starting point) */
router.put('/purchases/:id/batch-name', authenticate, blockProductionStaff,
  body('batch_name').optional().trim().isLength({ max: 80 }).withMessage('Batch name must be 80 characters or fewer'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const db = getDb();
      const id = parseInt(req.params.id);
      const batch_name = (req.body.batch_name || '').trim();
      const existing = await db.prepare('SELECT id FROM purchases WHERE id=?').get(id);
      if (!existing) return res.status(404).json({ error: 'Batch not found' });

      await db.prepare('UPDATE purchases SET batch_name=? WHERE id=?').run(batch_name, id);
      await writeAudit(db, { userId: req.user.id, action: 'RENAME_BATCH', table: 'purchases',
        recordId: id, newVals: { batch_name }, ip: req.ip });

      const row = await db.prepare(`
        SELECT p.*, s.name AS supplier_name,
          ROUND((p.kgs_bought*p.cost_per_kg+p.transport_cost),2) AS total_cost,
          CASE WHEN p.kgs_bought>0
            THEN ROUND(((p.kgs_bought*p.cost_per_kg+p.transport_cost)/p.kgs_bought),2)
            ELSE 0 END AS landed_cost_per_kg
        FROM purchases p JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?`).get(id);
      res.json(row);
    } catch(e) {
      console.error('PUT batch-name error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* GET /api/daily/batches?gauge=12 — available wire batches for a gauge, FIFO order (oldest first).
   Used to populate the production batch-selection dropdown (a PREFERENCE, not a hard
   requirement — POST /production will FIFO-cascade through these same batches if the
   preferred one alone doesn't cover kgs_used). Each batch carries its own real landed cost. */
router.get('/batches', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gauge = (req.query.gauge || '').trim();
    const rows = await db.prepare(`
      SELECT p.id, p.entry_date, p.gauge, p.batch_name, p.kgs_bought, p.kgs_remaining,
             p.cost_per_kg, p.transport_cost, s.name AS supplier_name,
             ROUND(((p.kgs_bought*p.cost_per_kg+p.transport_cost)/p.kgs_bought),4) AS landed_cost_per_kg
      FROM purchases p JOIN suppliers s ON p.supplier_id=s.id
      WHERE COALESCE(p.gauge,'')=? AND p.kgs_remaining > 0.001
      ORDER BY p.entry_date ASC, p.id ASC
    `).all(gauge);
    res.json(rows.map(r => ({
      id: r.id,
      label: r.batch_name && r.batch_name.trim()
        ? r.batch_name
        : `${r.entry_date} · ${r.supplier_name} · Gauge ${r.gauge || '—'}`,
      entry_date: r.entry_date,
      supplier_name: r.supplier_name,
      gauge: r.gauge,
      kgs_remaining: parseFloat(r.kgs_remaining),
      kgs_bought: parseFloat(r.kgs_bought),
      landed_cost_per_kg: parseFloat(r.landed_cost_per_kg),
    })));
  } catch(e) {
    console.error('GET batches error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* DELETE /api/daily/purchases/:id */
router.delete('/purchases/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  const db = getDb();
  try {
    const id = parseInt(req.params.id);
    const row = await db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Purchase not found' });

    const gaugeKey = (row.gauge || '').trim();

    // Batch-specific check: this exact batch must be untouched (rule 4 — real per-batch tracking)
    if (row.kgs_remaining != null && parseFloat(row.kgs_remaining) < parseFloat(row.kgs_bought) - 0.001) {
      return res.status(400).json({
        error: 'INTEGRITY_VIOLATION',
        message: `Cannot delete this batch — ${(parseFloat(row.kgs_bought) - parseFloat(row.kgs_remaining)).toFixed(3)} kg from it has already been used in production.`
      });
    }

    // Pre-flight gauge-aware check (fast path before transaction)
    const totalBoughtGauge = (await db.prepare(
      `SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases WHERE COALESCE(gauge,'')=?`
    ).get(gaugeKey)).v;
    const totalUsedGauge = (await db.prepare(
      `SELECT COALESCE(SUM(kgs_used),0) AS v FROM production WHERE COALESCE(gauge,'')=?`
    ).get(gaugeKey)).v;
    const futureRawStock = parseFloat(totalBoughtGauge) - parseFloat(row.kgs_bought) - parseFloat(totalUsedGauge);

    if (futureRawStock < -0.001) {
      const gLabel = gaugeKey ? `gauge ${gaugeKey}` : 'this gauge';
      return res.status(400).json({
        error: 'INTEGRITY_VIOLATION',
        message: `Cannot delete this purchase. Wire from this batch (${gLabel}) has already been used in production. Stock would go to ${futureRawStock.toFixed(3)} kg.`
      });
    }

    // ACID: re-validate stock and delete atomically to prevent concurrent-request races
    await db.transaction(async () => {
      const tb = (await db.prepare(
        `SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases WHERE COALESCE(gauge,'')=?`
      ).get(gaugeKey)).v;
      const tu = (await db.prepare(
        `SELECT COALESCE(SUM(kgs_used),0) AS v FROM production WHERE COALESCE(gauge,'')=?`
      ).get(gaugeKey)).v;
      if (parseFloat(tb) - parseFloat(row.kgs_bought) - parseFloat(tu) < -0.001) {
        const e = new Error('BLOCKED');
        e.purchaseBlocked = true;
        throw e;
      }
      await db.prepare('DELETE FROM purchases WHERE id=?').run(id);
    });

    await writeAudit(db, { userId: req.user.id, action: 'DELETE_PURCHASE', table: 'purchases',
      recordId: id, oldVals: row, ip: req.ip });
    const gLabel = gaugeKey ? ` (gauge ${row.gauge})` : '';
    res.json({ message: `Purchase deleted. ${parseFloat(row.kgs_bought).toFixed(1)} kg${gLabel} removed from raw material stock.` });
  } catch(e) {
    if (e.purchaseBlocked) {
      const gLabel = gaugeKey ? `gauge ${gaugeKey}` : 'this gauge';
      return res.status(400).json({ error: 'INTEGRITY_VIOLATION', message: `Cannot delete this purchase — wire (${gLabel}) was used in production concurrently. Please refresh and try again.` });
    }
    console.error('DELETE purchase error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════════
// PRODUCTION
// ══════════════════════════════════════════════════════════════════

router.get('/production', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { date, from, to } = req.query;
    // FIX:  cast on all ROUND calls
    let sql = `SELECT pr.*,
                 u.full_name AS entered_by_name,
                 op.full_name AS operator_name,
                 kn.full_name AS knuckler_name,
                 p.batch_name AS batch_name,
                 CASE WHEN p.kgs_bought>0
                   THEN ROUND(((p.kgs_bought*p.cost_per_kg+p.transport_cost)/p.kgs_bought),4)
                   ELSE NULL END AS batch_landed_cost_per_kg,
                 -- True blended landed cost actually charged to this record, derived
                 -- from the stored totals — accurate whether one batch or several
                 -- (FIFO cascade) fed it, never just the "primary" batch's own rate.
                 CASE WHEN pr.kgs_used>0
                   THEN ROUND(((pr.total_cost-pr.operator_cost-pr.knuckler_cost-pr.sack_cost-pr.rent_allocation)/pr.kgs_used),4)
                   ELSE NULL END AS wire_cost_per_kg,
                 ROUND((pr.operator_cost+pr.knuckler_cost),2) AS total_labour,
                 ROUND((pr.operator_cost+pr.knuckler_cost+pr.sack_cost+pr.rent_allocation),2) AS total_overhead
               FROM production pr
               JOIN users u ON pr.entered_by=u.id
               LEFT JOIN users op ON pr.operator_id=op.id
               LEFT JOIN users kn ON pr.knuckler_id=kn.id
               LEFT JOIN purchases p ON pr.purchase_id=p.id`;
    const params = [], conds = [];
    if (date)       { conds.push('pr.entry_date=?');               params.push(date); }
    else if (from)  { conds.push('pr.entry_date BETWEEN ? AND ?'); params.push(from, to || from); }
    if (req.user.role === 'knuckler' || req.user.role === 'operator') { conds.push('pr.entered_by=?'); params.push(req.user.id); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY pr.entry_date DESC, pr.created_at DESC';

    const rows      = await db.prepare(sql).all(...params);
    const itemsStmt = db.prepare(`
      SELECT pi.*, pt.name AS piece_name, pt.length_m, pt.weight_kg,
             pi.pieces_produced * pt.weight_kg AS output_kgs,
             pi.pieces_produced * pt.length_m AS output_meters
      FROM production_items pi JOIN piece_types pt ON pi.piece_type_id=pt.id
      WHERE pi.production_id=?
    `);
    // Per-batch draw breakdown — lets the UI show "drew from 2 batches" honestly
    // instead of implying a single batch supplied the whole run.
    const usageStmt = db.prepare(`
      SELECT pbu.purchase_id, pbu.kgs_drawn, pbu.landed_cost_per_kg,
             COALESCE(NULLIF(p.batch_name,''), 'Batch #' || p.id) AS batch_label
      FROM production_batch_usage pbu
      JOIN purchases p ON pbu.purchase_id = p.id
      WHERE pbu.production_id=?
      ORDER BY pbu.id ASC
    `);
    const result = [];
    for (const r of rows) {
      const batches = await usageStmt.all(r.id);
      result.push({ ...r, items: await itemsStmt.all(r.id), batches, batch_count: batches.length });
    }
    res.json(result);
  } catch(e) {
    console.error('GET production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/production', authenticate, blockProductionStaff,
  body('entry_date').isISO8601().withMessage('Valid date required'),
  body('kgs_used').isFloat({ min: 0.001 }).withMessage('Kgs used must be > 0'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('items.*.piece_type_id').isInt({ min: 1 }),
  body('items.*.pieces_produced').isInt({ min: 0 }),
  body('gauge').optional().trim(),
  body('purchase_id').optional().isInt({ min: 1 }).withMessage('Invalid wire batch'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const { entry_date, kgs_used, operator_id, knuckler_id, items, gauge = '', purchase_id = null } = req.body;
      const db = getDb();

      // ENFORCE: at least one item must have pieces_produced > 0
      const anyPiecesProduced = items.some(i => (parseInt(i.pieces_produced) || 0) > 0);
      if (!anyPiecesProduced) {
        return res.status(400).json({
          error: 'ZERO_PRODUCTION',
          message: 'All pieces_produced are zero. A production record must produce at least one piece.'
        });
      }

      // ENFORCE: both operator and knuckler are required for every production record
      if (!operator_id || !knuckler_id) {
        return res.status(400).json({
          error: 'MISSING_STAFF',
          message: 'Both an operator and a knuckler must be assigned to every production record. Production cannot be saved without both.'
        });
      }

      // ENFORCE: no mixing roles. Operator and knuckler are distinct.
      // Admin/owner cannot be assigned to these fields.
      if (operator_id) {
        const op = await db.prepare('SELECT role FROM users WHERE id=?').get(operator_id);
        if (!op || op.role !== 'operator') {
          return res.status(400).json({ error: 'Operator field must be an operator role user only' });
        }
      }
      if (knuckler_id) {
        const kn = await db.prepare('SELECT role FROM users WHERE id=?').get(knuckler_id);
        if (!kn || kn.role !== 'knuckler') {
          return res.status(400).json({ error: 'Knuckler field must be a knuckler role user only' });
        }
      }

      // Pre-flight checks (piece types, weights) — outside transaction for speed
      const gaugeKey = (gauge || '').trim();
      for (const item of items) {
        if (!await db.prepare('SELECT id FROM piece_types WHERE id=? AND active=1').get(item.piece_type_id))
          return res.status(400).json({ error: `Piece type ${item.piece_type_id} not found` });
      }

      let totalExpectedKgs = 0;
      let totalPieces = 0;
      for (const item of items) {
        const pt = await db.prepare('SELECT weight_kg FROM piece_types WHERE id=?').get(item.piece_type_id);
        if (pt) {
          const qty = parseInt(item.pieces_produced) || 0;
          totalExpectedKgs += qty * pt.weight_kg;
          totalPieces += qty;
        }
      }

      // Allow up to 10% scrap — some wire is always lost as offcuts and waste during production.
      // Industry tolerance is typically 5-10%. We use 10% to avoid rejecting real production data.
      const scrapAllowance = totalExpectedKgs * 0.10;
      if (parseFloat(kgs_used) < (totalExpectedKgs - scrapAllowance - 0.001)) {
        return res.status(400).json({
          error: 'INVALID_PRODUCTION_DATA',
          message: `UNJUSTIFIABLE PRODUCTION: You entered ${parseFloat(kgs_used).toFixed(2)} kg of wire used, but the pieces produced weigh ${totalExpectedKgs.toFixed(2)} kg (10% scrap allowance = ${scrapAllowance.toFixed(2)} kg). Wire cannot be created from thin air. Please check piece weights or wire usage.`
        });
      }

      // ATOMIC: batch selection/validation + stock check + insert in ONE transaction.
      // This eliminates the TOCTOU race where two rapid requests both pass the
      // check before either writes — the second will now fail at the DB level.
      let pid;
      // IMPORTANT: we use throw inside the transaction callback for ALL error paths.
      // Returning early (return;) commits whatever has already been written — throwing
      // triggers the ROLLBACK branch in transaction() so no partial writes survive.
      // We catch the known stock-error shape below and convert it to a 400 response;
      // anything else re-throws and becomes a 500.
      await db.transaction(async () => {
        // Re-read stock INSIDE the transaction — this is the authoritative check
        const rawBoughtGauge = (await db.prepare(
          `SELECT COALESCE(SUM(kgs_bought),0) AS v FROM purchases WHERE COALESCE(gauge,'')=?`
        ).get(gaugeKey)).v;
        const rawUsedGauge = (await db.prepare(
          `SELECT COALESCE(SUM(kgs_used),0) AS v FROM production WHERE COALESCE(gauge,'')=?`
        ).get(gaugeKey)).v;
        const currentRawStock = parseFloat(rawBoughtGauge) - parseFloat(rawUsedGauge);

        if (parseFloat(kgs_used) > currentRawStock + 0.001) {
          const gLabel = gaugeKey ? `gauge ${gaugeKey}` : 'unspecified gauge';
          const e = new Error(`Insufficient wire for ${gLabel}. Available: ${currentRawStock.toFixed(3)} kg, Requested: ${parseFloat(kgs_used).toFixed(3)} kg. You can only use wire you have purchased of this gauge.`);
          e.stockError = { error: 'INSUFFICIENT_RAW_STOCK', message: e.message };
          throw e;
        }

        // Resolve wire batches via FIFO CASCADE (rule 4, extended): a preferred
        // batch is tried first — explicit purchase_id if given, else the oldest
        // (FIFO) batch of this gauge. If that one batch doesn't fully cover
        // kgs_used, the shortfall silently cascades through the REMAINING
        // batches of this gauge in strict FIFO order (entry_date ASC, id ASC)
        // until kgs_used is fully covered. The aggregate check above already
        // guarantees the gauge has enough wire in total, so this only fails
        // defensively (e.g. a concurrent write slipped in between).
        const allBatches = await db.prepare(
          `SELECT id, gauge, kgs_remaining, kgs_bought, cost_per_kg, transport_cost FROM purchases
           WHERE COALESCE(gauge,'')=? AND kgs_remaining > 0.001
           ORDER BY entry_date ASC, id ASC`
        ).all(gaugeKey);

        if (!allBatches.length) {
          const e = new Error(`No wire batch found for ${gaugeKey ? 'gauge ' + gaugeKey : 'this gauge'}.`);
          e.stockError = { error: 'INVALID_BATCH', message: e.message };
          throw e;
        }

        const landedCostOf = b => b.kgs_bought > 0
          ? (b.kgs_bought * b.cost_per_kg + b.transport_cost) / b.kgs_bought
          : 0;

        // Build the draw order.
        // No batch selected → FIFO cascade across all batches (unchanged behaviour).
        // Batch explicitly selected → that batch must cover kgs_used on its own.
        //   If it doesn't, block. We do not silently draw from other batches
        //   because the user made a deliberate choice.
        let drawOrder = allBatches;
        if (purchase_id) {
          const preferredIdx = allBatches.findIndex(b => b.id === purchase_id);
          if (preferredIdx === -1) {
            const preferred = await db.prepare(`SELECT gauge, kgs_remaining FROM purchases WHERE id=?`).get(purchase_id);
            if (!preferred || (preferred.gauge || '').trim() !== gaugeKey) {
              const e = new Error('Selected wire batch does not match this gauge.');
              e.stockError = { error: 'INVALID_BATCH', message: e.message };
              throw e;
            }
            // Same gauge but depleted.
            const e2 = new Error(`Selected batch is empty. Choose a different batch or deselect to use available stock.`);
            e2.stockError = { error: 'INSUFFICIENT_BATCH_STOCK', message: e2.message };
            throw e2;
          }
          const preferredBatch = allBatches[preferredIdx];
          if (parseFloat(kgs_used) > parseFloat(preferredBatch.kgs_remaining) + 0.001) {
            const bLabel = (preferredBatch.batch_name && preferredBatch.batch_name.trim())
              ? preferredBatch.batch_name : `Batch #${preferredBatch.id}`;
            const e = new Error(`"${bLabel}" has ${parseFloat(preferredBatch.kgs_remaining).toFixed(3)} kg — ${parseFloat(kgs_used).toFixed(3)} kg needed. Choose a batch with enough wire or deselect to use available stock.`);
            e.stockError = { error: 'INSUFFICIENT_BATCH_STOCK', message: e.message };
            throw e;
          }
          // Sufficient — draw from this batch only.
          drawOrder = [preferredBatch];
        }

        let need = parseFloat(kgs_used);
        const draws = []; // [{ batch, kgs_drawn }]
        for (const b of drawOrder) {
          if (need <= 0.001) break;
          const take = Math.min(parseFloat(b.kgs_remaining), need);
          if (take <= 0.001) continue;
          draws.push({ batch: b, kgs_drawn: take });
          need -= take;
        }

        if (need > 0.001) {
          // Defensive only — the aggregate currentRawStock check above should
          // already have caught this. Surfaces clearly if it ever doesn't.
          const gLabel = gaugeKey ? `gauge ${gaugeKey}` : 'unspecified gauge';
          const e = new Error(`Insufficient wire for ${gLabel} across all batches. Short by ${need.toFixed(3)} kg.`);
          e.stockError = { error: 'INSUFFICIENT_RAW_STOCK', message: e.message };
          throw e;
        }

        // True weighted-average landed cost across every batch actually drawn
        // from — not a flat average of batch rates, a kg-weighted blend, so a
        // production run that's 90% old cheap wire and 10% new pricier wire
        // is costed accordingly, not split 50/50.
        const totalWireCost = draws.reduce((s, d) => s + d.kgs_drawn * landedCostOf(d.batch), 0);
        const wireCostPerKg = parseFloat(kgs_used) > 0 ? totalWireCost / parseFloat(kgs_used) : 0;
        const primaryBatchId = draws[0].batch.id; // kept on production.purchase_id for simple joins/back-compat

        const breakdown = await getProductionCostBreakdown(db, totalPieces, parseFloat(kgs_used), wireCostPerKg);

        for (const d of draws) {
          await db.prepare('UPDATE purchases SET kgs_remaining = kgs_remaining - ? WHERE id=?')
            .run(d.kgs_drawn, d.batch.id);
        }

        pid = (await db.prepare(
          `INSERT INTO production(entry_date,kgs_used,gauge,purchase_id,operator_id,knuckler_id,
            operator_cost,knuckler_cost,sack_cost,rent_allocation,total_cost,entered_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
        ).run(
          entry_date, kgs_used, gauge || '', primaryBatchId,
          operator_id || null, knuckler_id || null,
          breakdown.operator_cost, breakdown.knuckler_cost,
          breakdown.sack_cost, breakdown.rent_allocation, breakdown.total_cost,
          req.user.id
        )).lastInsertRowid;

        // Per-batch usage trail — the source of truth for delete-time stock
        // reversal and for showing an honest "drew from N batches" breakdown.
        const insUsage = db.prepare(
          `INSERT INTO production_batch_usage(production_id,purchase_id,kgs_drawn,landed_cost_per_kg) VALUES(?,?,?,?)`
        );
        for (const d of draws) await insUsage.run(pid, d.batch.id, d.kgs_drawn, landedCostOf(d.batch));

        const insItem = db.prepare('INSERT INTO production_items(production_id,piece_type_id,pieces_produced) VALUES(?,?,?)');
        for (const item of items) await insItem.run(pid, item.piece_type_id, item.pieces_produced);
      });

      const record = await db.prepare(`
        SELECT pr.*, u.full_name AS entered_by_name,
          ROUND((pr.operator_cost+pr.knuckler_cost+pr.sack_cost+pr.rent_allocation),2) AS total_overhead
        FROM production pr JOIN users u ON pr.entered_by=u.id WHERE pr.id=?`).get(pid);
      const outItems = await db.prepare(
        `SELECT pi.*, pt.name AS piece_name FROM production_items pi
         JOIN piece_types pt ON pi.piece_type_id=pt.id WHERE pi.production_id=?`
      ).all(pid);
      await writeAudit(db, { userId: req.user.id, action: 'CREATE_PRODUCTION', table: 'production', recordId: pid, ip: req.ip });
      // Fire-and-forget: check stock levels and write notifications for owner
      checkAndNotifyStock(db, req.user.id).catch(() => {});
      res.status(201).json({ ...record, items: outItems });
    } catch(e) {
      // Stock / batch validation errors are thrown inside the transaction so ROLLBACK fires.
      if (e.stockError) return res.status(400).json(e.stockError);
      console.error('POST production error:', e);
      if (e.message && e.message.includes('Piece type')) return res.status(400).json({ error: e.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* DELETE /api/daily/production/:id */
router.delete('/production/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  const db = getDb();
  try {
    const id = parseInt(req.params.id);
    const row = await db.prepare('SELECT * FROM production WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Production record not found' });

    const items = await db.prepare('SELECT * FROM production_items WHERE production_id=?').all(id);
    const rowGauge = (row.gauge || '').trim();
    for (const item of items) {
      // Gauge-aware: only count production & sales for the SAME gauge as this record
      const producedInGauge = (await db.prepare(
        `SELECT COALESCE(SUM(pi.pieces_produced),0) AS v
         FROM production_items pi
         JOIN production pr ON pi.production_id=pr.id
         WHERE pi.piece_type_id=? AND COALESCE(pr.gauge,'')=?`
      ).get(item.piece_type_id, rowGauge)).v;
      const soldInGauge = (await db.prepare(
        `SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id=? AND COALESCE(gauge_source,'')=?`
      ).get(item.piece_type_id, rowGauge)).v;
      const futureStock = parseInt(producedInGauge) - item.pieces_produced - parseInt(soldInGauge);
      if (futureStock < 0) {
        const pt = await db.prepare('SELECT name FROM piece_types WHERE id=?').get(item.piece_type_id);
        const gLabel = rowGauge ? `gauge ${rowGauge}` : 'unspecified gauge';
        return res.status(400).json({
          error: 'INTEGRITY_VIOLATION',
          message: `Cannot delete this production record. ${pt.name} (${gLabel}) from this batch have already been sold. Remaining stock would be ${futureStock} pieces.`
        });
      }
    }

    // Check if any wages/costs for this batch were already paid out
    const totalPieces = items.reduce((s, i) => s + (parseInt(i.pieces_produced) || 0), 0);
    const costWarnings = [];
    if (parseFloat(row.operator_cost) > 0) costWarnings.push(`Operator wages: KES ${parseFloat(row.operator_cost).toLocaleString()}`);
    if (parseFloat(row.knuckler_cost) > 0) costWarnings.push(`Knuckler wages: KES ${parseFloat(row.knuckler_cost).toLocaleString()}`);
    if (parseFloat(row.sack_cost)     > 0) costWarnings.push(`Sack costs: KES ${parseFloat(row.sack_cost).toLocaleString()}`);

    // Per-batch usage trail for this record — this, not row.purchase_id alone,
    // is the authoritative list of which batches were actually drawn from and
    // how much, so deleting a multi-batch entry restores stock correctly on
    // EVERY batch involved (integrity over convenience).
    const usageRows = await db.prepare(
      'SELECT purchase_id, kgs_drawn FROM production_batch_usage WHERE production_id=?'
    ).all(id);
    // Defensive fallback for the (should-be-impossible post-migration) case of
    // a production row with no usage trail — restore against its single FK.
    const restoreList = usageRows.length
      ? usageRows
      : (row.purchase_id ? [{ purchase_id: row.purchase_id, kgs_drawn: parseFloat(row.kgs_used) }] : []);

    // ACID: delete production_items + production atomically so inventory never shows
    // a partial state where the parent row is gone but items remain or vice-versa
    await db.transaction(async () => {
      // Re-validate inside the transaction to guard against concurrent sales
      for (const item of items) {
        const pg = (await db.prepare(
          `SELECT COALESCE(SUM(pi.pieces_produced),0) AS v
           FROM production_items pi
           JOIN production pr ON pi.production_id=pr.id
           WHERE pi.piece_type_id=? AND COALESCE(pr.gauge,'')=?`
        ).get(item.piece_type_id, rowGauge)).v;
        const sg = (await db.prepare(
          `SELECT COALESCE(SUM(quantity),0) AS v FROM sales WHERE piece_type_id=? AND COALESCE(gauge_source,'')=?`
        ).get(item.piece_type_id, rowGauge)).v;
        if (parseInt(pg) - item.pieces_produced - parseInt(sg) < 0) {
          const e = new Error('PROD_BLOCKED');
          e.prodBlocked = true;
          throw e;
        }
      }
      await db.prepare('DELETE FROM production_items WHERE production_id=?').run(id);
      await db.prepare('DELETE FROM production_batch_usage WHERE production_id=?').run(id);
      await db.prepare('DELETE FROM production WHERE id=?').run(id);
      for (const u of restoreList) {
        await db.prepare('UPDATE purchases SET kgs_remaining = MIN(kgs_bought, kgs_remaining + ?) WHERE id=?')
          .run(parseFloat(u.kgs_drawn), u.purchase_id);
      }
    });

    await writeAudit(db, { userId: req.user.id, action: 'DELETE_PRODUCTION', table: 'production',
      recordId: id, oldVals: row, ip: req.ip });

    let msg = `Production record deleted. ${parseFloat(row.kgs_used).toFixed(1)} kg of wire and ${totalPieces} pieces removed from records.`;
    if (costWarnings.length) {
      msg += ` NOTE: The following costs were already accrued and are NOT automatically reversed — review your payments if needed: ${costWarnings.join(', ')}.`;
    }
    res.json({ message: msg, cost_warnings: costWarnings });
  } catch(e) {
    if (e.prodBlocked) return res.status(400).json({ error: 'INTEGRITY_VIOLATION', message: 'Cannot delete this production record — pieces were sold concurrently. Please refresh and try again.' });
    console.error('DELETE production error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════════
// SALES
// ══════════════════════════════════════════════════════════════════

router.get('/sales', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { date, from, to } = req.query;
    // FIX:  cast on all ROUND calls
    let sql = `SELECT s.*,
                 pt.name AS piece_name, pt.length_m, pt.weight_kg,
                 u.full_name AS entered_by_name,
                 ROUND((s.quantity * s.selling_price), 2) AS revenue,
                 ROUND((s.quantity * pt.weight_kg), 2) AS kgs_sold,
                 ROUND((s.quantity * pt.length_m), 2) AS meters_sold
               FROM sales s
               JOIN piece_types pt ON s.piece_type_id=pt.id
               JOIN users u ON s.entered_by=u.id`;
    const params = [], conds = [];
    if (date)       { conds.push('s.entry_date=?');               params.push(date); }
    else if (from)  { conds.push('s.entry_date BETWEEN ? AND ?'); params.push(from, to || from); }
    if (req.user.role === 'knuckler' || req.user.role === 'operator') { conds.push('s.entered_by=?'); params.push(req.user.id); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY s.entry_date DESC, s.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  } catch(e) {
    console.error('GET sales error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── POST /api/daily/sales/batch — one buyer, multiple items, ONE invoice ──────
// All items validated atomically; one invoice with N line items is created.
// Falls back gracefully: if any item fails stock check, the whole batch is rejected.
router.post('/sales/batch', authenticate, blockProductionStaff,
  body('entry_date').isISO8601().withMessage('Valid date required'),
  body('buyer_name').notEmpty().trim().withMessage('Buyer name is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('items.*.piece_type_id').isInt({ min: 1 }).withMessage('Piece type required'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be >= 1'),
  body('items.*.selling_price').isFloat({ min: 0 }).withMessage('Price must be >= 0'),
  body('items.*.gauge_source').notEmpty().trim().withMessage('Wire gauge source is required'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const { entry_date, buyer_name, items } = req.body;
      const db = getDb();
      const customerName = (buyer_name && buyer_name.trim()) ? buyer_name.trim() : 'Walk-in Customer';

      // Validate all piece types exist and active
      const pieceTypes = {};
      for (const item of items) {
        if (!pieceTypes[item.piece_type_id]) {
          const pt = await db.prepare('SELECT * FROM piece_types WHERE id=? AND active=1').get(item.piece_type_id);
          if (!pt) return res.status(404).json({ error: `Piece type ${item.piece_type_id} not found or inactive` });
          pieceTypes[item.piece_type_id] = pt;
        }
      }

      const transport_rate_per_piece = await getCfgNumber(db, 'transport_to_market');

      // Build enriched rows with transport and price_overridden
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
      let autoInvoiceId = null;

      // ATOMIC: validate stock + insert all sales + create one invoice with all items
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
                customerName, row.gauge_source, req.user.id, wireCostPerKg);
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

        // Use the first sale's id as the canonical sale_id (links invoice to daily page)
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
          req.user.id, saleIds[0]
        );

        if (invRes && invRes.lastInsertRowid) {
          autoInvoiceId = invRes.lastInsertRowid;
          // Insert one line item per sale row
          for (const row of enriched) {
            const lineTotal = parseFloat((row.quantity * row.selling_price).toFixed(2));
            await db.prepare(`
              INSERT INTO invoice_items(invoice_id, piece_type_id, description, gauge, quantity, unit_price, line_total)
              VALUES(?,?,?,?,?,?,?)
            `).run(autoInvoiceId, row.piece_type_id, row.pt.name, row.gauge_source,
                   row.quantity, row.selling_price, lineTotal);
          }
        }
      });

      checkAndNotifyStock(db, req.user.id).catch(() => {});

      await writeAudit(db, {
        userId: req.user.id, action: 'CREATE_BATCH_SALE', table: 'sales',
        newVals: { sale_ids: saleIds, invoice_id: autoInvoiceId, customer: customerName, items: enriched.length },
        ip: req.ip
      });

      // Return count and invoice info so frontend can refresh
      res.status(201).json({ saved: saleIds.length, invoice_id: autoInvoiceId });
    } catch(e) {
      if (e.stockError) return res.status(400).json(e.stockError);
      console.error('POST sales/batch error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/sales', authenticate, blockProductionStaff,
  body('entry_date').isISO8601().withMessage('Valid date required'),
  body('piece_type_id').isInt({ min: 1 }).withMessage('Piece type required'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be >= 1'),
  body('selling_price').isFloat({ min: 0 }).withMessage('Price must be >= 0'),
  body('transport_to_market').optional().isFloat({ min: 0 }),
  body('buyer_name').notEmpty().trim().withMessage('Buyer name is required'),
  body('gauge_source').notEmpty().trim().withMessage('Wire gauge source is required'),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    try {
      const { entry_date, piece_type_id, quantity, selling_price, buyer_name, gauge_source } = req.body;
      const db = getDb();
      
      // GAUGE-AWARE INVENTORY CHECK — ATOMIC: check + insert in one transaction
      // This is the only way to guarantee two simultaneous rapid requests cannot
      // both pass the availability check before either writes to the DB.
      const gaugeKey = (gauge_source || '').trim();

      const pt = await db.prepare('SELECT * FROM piece_types WHERE id=? AND active=1').get(piece_type_id);
      if (!pt) return res.status(404).json({ error: 'Piece type not found' });

      const transport_rate_per_piece = await getCfgNumber(db, 'transport_to_market');
      const transport_to_market = (req.body.transport_to_market !== undefined && req.body.transport_to_market !== null)
        ? parseFloat(req.body.transport_to_market) || 0
        : transport_rate_per_piece * parseInt(quantity);

      const price_overridden = parseFloat(selling_price) !== parseFloat(pt.default_price) ? 1 : 0;

      let result;
      let autoInvoiceId = null;

      // ATOMIC: stock check + sale insert + auto-invoice ALL in one transaction.
      // If any step fails the entire operation rolls back — no orphaned sale or invoice.
      await db.transaction(async () => {
        // Re-read inventory INSIDE the transaction — authoritative, race-proof
        const producedInGauge = await db.prepare(`
          SELECT COALESCE(SUM(pi.pieces_produced), 0) AS produced
          FROM production_items pi
          JOIN production pr ON pi.production_id = pr.id
          WHERE pi.piece_type_id = ?
            AND COALESCE(pr.gauge, '') = ?
        `).get(piece_type_id, gaugeKey);

        const soldInGauge = await db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS sold
          FROM sales
          WHERE piece_type_id = ?
            AND COALESCE(gauge_source, '') = ?
        `).get(piece_type_id, gaugeKey);

        const produced  = parseInt(producedInGauge.produced) || 0;
        const sold      = parseInt(soldInGauge.sold) || 0;
        const available = produced - sold;

        if (parseInt(quantity) > available) {
          const gaugeLabel = gaugeKey || 'unspecified gauge';
          const _e = new Error(`Cannot sell ${quantity} pieces. Inventory for ${pt.name} (${gaugeLabel}): Produced=${produced}, Sold=${sold}, Available=${available} pieces.`);
          _e.stockError = { error: 'INSUFFICIENT_STOCK_FOR_GAUGE', message: _e.message,
            inventory: { produced, sold, available, requested: parseInt(quantity) } };
          throw _e;
        }

        const wireCostPerKg = await resolveWireCostPerKgForSale(db, piece_type_id, entry_date);
        result = await db.prepare(
          `INSERT INTO sales(entry_date,piece_type_id,quantity,selling_price,default_price,price_overridden,transport_to_market,buyer_name,gauge_source,entered_by,wire_cost_per_kg)
           VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
        ).run(entry_date, piece_type_id, quantity, selling_price, pt.default_price, price_overridden, transport_to_market, buyer_name || '', gauge_source || '', req.user.id, wireCostPerKg);

        // ── Auto-generate invoice INSIDE the transaction (atomic with the sale) ──
        const prefix = (await db.prepare("SELECT value FROM config WHERE key='invoice_prefix'").get())?.value || 'INV';
        const last   = await db.prepare(`SELECT invoice_number FROM invoices WHERE id = (SELECT MAX(id) FROM invoices)`).get();
        let seq = 1001;
        if (last?.invoice_number) {
          const parts = last.invoice_number.split('-');
          const n = parseInt(parts[parts.length - 1]);
          if (!isNaN(n)) seq = n + 1;
        }
        const yr           = new Date().getFullYear().toString().slice(-2);
        const invNum       = `${prefix}-${yr}-${String(seq).padStart(4,'0')}`;
        const lineTotal    = parseFloat((parseFloat(quantity) * parseFloat(selling_price)).toFixed(2));
        const customerName = (buyer_name && buyer_name.trim()) ? buyer_name.trim() : 'Walk-in Customer';

        const invRes = await db.prepare(`
          INSERT INTO invoices(
            invoice_number, invoice_date, due_date, customer_name,
            status, subtotal, discount_pct, discount_amount,
            tax_pct, tax_amount, total_amount, amount_paid,
            notes, created_by, sale_id
          ) VALUES(?,?,?,?,'partial_payment',?,0,0,0,0,?,0,?,?,?) RETURNING id
        `).run(
          invNum, entry_date, entry_date, customerName,
          lineTotal, lineTotal,
          `Auto-generated from sale on ${entry_date}`,
          req.user.id, result.lastInsertRowid
        );

        if (invRes && invRes.lastInsertRowid) {
          autoInvoiceId = invRes.lastInsertRowid;
          await db.prepare(`
            INSERT INTO invoice_items(invoice_id, piece_type_id, description, gauge, quantity, unit_price, line_total)
            VALUES(?,?,?,?,?,?,?)
          `).run(
            autoInvoiceId,
            piece_type_id,
            pt.name,
            gauge_source || '',
            parseInt(quantity),
            parseFloat(selling_price),
            lineTotal
          );
        }
      });

      await writeAudit(db, {
        userId: req.user.id,
        action: price_overridden ? 'PRICE_OVERRIDE' : 'CREATE_SALE',
        table: 'sales', recordId: result.lastInsertRowid,
        oldVals: price_overridden ? { default: pt.default_price } : null,
        newVals: { selling: selling_price, transport: transport_to_market, auto_invoice_id: autoInvoiceId },
        ip: req.ip
      });

      const row = await db.prepare(`
        SELECT s.*, pt.name AS piece_name, pt.length_m, pt.weight_kg,
          u.full_name AS entered_by_name,
          ROUND((s.quantity*s.selling_price),2) AS revenue,
          ROUND((s.quantity*pt.weight_kg),2) AS kgs_sold,
          ROUND((s.quantity*pt.length_m),2) AS meters_sold
        FROM sales s
        JOIN piece_types pt ON s.piece_type_id=pt.id
        JOIN users u ON s.entered_by=u.id
        WHERE s.id=?`).get(result.lastInsertRowid);

      // Fire-and-forget: check stock after sale, notify owner if low
      checkAndNotifyStock(db, req.user.id).catch(() => {});
      res.status(201).json(row);
    } catch(e) {
      if (e.stockError) return res.status(400).json(e.stockError);
      console.error('POST sales error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/* DELETE /api/daily/sales/:id */
router.delete('/sales/:id', authenticate, requireRole('owner','admin'), async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const db  = getDb();
    const row = await db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'Sale not found' });

    // Find auto-generated invoice linked to this sale (if any)
    const linkedInvoice = await db.prepare('SELECT * FROM invoices WHERE sale_id=?').get(id);

    // Pre-flight: block deletion if payment already collected
    if (linkedInvoice) {
      const paidAmount = parseFloat(linkedInvoice.amount_paid) || 0;
      if (linkedInvoice.status === 'paid' || paidAmount > 0) {
        return res.status(400).json({
          error: 'INTEGRITY_VIOLATION',
          message: `This sale has an invoice (${linkedInvoice.invoice_number}) with KES ${paidAmount.toLocaleString()} already collected. You must cancel the invoice first before deleting the sale, or contact your admin to reverse the payment.`
        });
      }
    }

    // ACID: re-check payment status inside transaction and cascade-delete atomically.
    // This prevents a race where a payment is recorded between the pre-flight check and the delete.
    await db.transaction(async () => {
      if (linkedInvoice) {
        // Re-read invoice inside transaction for authoritative payment status
        const inv = await db.prepare('SELECT amount_paid, status FROM invoices WHERE id=?').get(linkedInvoice.id);
        if (inv && (inv.status === 'paid' || parseFloat(inv.amount_paid) > 0)) {
          const e = new Error(`A payment was recorded against invoice ${linkedInvoice.invoice_number} concurrently. Please refresh and cancel the invoice first before deleting the sale.`);
          e.paymentRace = true;
          throw e;
        }
        await db.prepare('DELETE FROM invoice_payments WHERE invoice_id=?').run(linkedInvoice.id);
        await db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(linkedInvoice.id);
        await db.prepare('DELETE FROM invoices WHERE id=?').run(linkedInvoice.id);
      }
      await db.prepare('DELETE FROM sales WHERE id=?').run(id);
    });

    await writeAudit(db, { userId: req.user.id, action: 'DELETE_SALE', table: 'sales',
      recordId: id, oldVals: row,
      newVals: linkedInvoice ? { cascaded_invoice: linkedInvoice.invoice_number } : null,
      ip: req.ip });

    const msg = linkedInvoice
      ? `Sale deleted. Its invoice (${linkedInvoice.invoice_number}) has been automatically removed.`
      : 'Sale deleted successfully.';
    res.json({ message: msg });
  } catch(e) {
    if (e.paymentRace) return res.status(400).json({ error: 'INTEGRITY_VIOLATION', message: e.message });
    console.error('DELETE sale error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get distinct customer names for autocomplete
router.get('/customers/distinct', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const customers = await db.prepare(`
      SELECT DISTINCT buyer_name 
      FROM sales 
      WHERE buyer_name IS NOT NULL AND buyer_name != '' 
      ORDER BY buyer_name ASC
    `).all();
    
    const customerNames = customers.map(c => c.buyer_name.trim()).filter(name => name.length > 0);
    res.json(customerNames);
  } catch(e) {
    console.error('Get distinct customers error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ══════════════════════════════════════════════════════════════════
// AVAILABLE INVENTORY BY GAUGE + PIECE TYPE
// ══════════════════════════════════════════════════════════════════

/* GET /api/daily/available-inventory — Critical: Show sellable stock by gauge */
router.get('/available-inventory', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const inventory = await db.prepare(`
      WITH produced AS (
        SELECT
          pi.piece_type_id,
          COALESCE(pr.gauge, '') AS gauge,
          COALESCE(SUM(pi.pieces_produced), 0) AS produced
        FROM production_items pi
        JOIN production pr ON pi.production_id = pr.id
        GROUP BY pi.piece_type_id, COALESCE(pr.gauge, '')
      ),
      sold AS (
        SELECT
          s.piece_type_id,
          COALESCE(s.gauge_source, '') AS gauge,
          COALESCE(SUM(s.quantity), 0) AS sold
        FROM sales s
        GROUP BY s.piece_type_id, COALESCE(s.gauge_source, '')
      ),
      gauge_pairs AS (
        SELECT piece_type_id, gauge FROM produced
        UNION
        SELECT piece_type_id, gauge FROM sold
      )
      SELECT
        pt.id AS piece_type_id,
        pt.name AS piece_type_name,
        gp.gauge,
        COALESCE(p.produced, 0) AS produced,
        COALESCE(s.sold, 0) AS sold,
        COALESCE(p.produced, 0) - COALESCE(s.sold, 0) AS available
      FROM gauge_pairs gp
      JOIN piece_types pt ON pt.id = gp.piece_type_id
      LEFT JOIN produced p
        ON p.piece_type_id = gp.piece_type_id
       AND p.gauge = gp.gauge
      LEFT JOIN sold s
        ON s.piece_type_id = gp.piece_type_id
       AND s.gauge = gp.gauge
      WHERE pt.active = 1
      ORDER BY pt.name, gp.gauge
    `).all();

    res.json((inventory || []).map(item => {
      const gauge = item.gauge || 'Unspecified';
      const produced = parseInt(item.produced) || 0;
      const sold = parseInt(item.sold) || 0;
      const available = parseInt(item.available) || 0;
      return {
        piece_type_id: parseInt(item.piece_type_id) || 0,
        piece_type_name: item.piece_type_name,
        gauge,
        produced,
        sold,
        available,
        can_sell: available > 0,
        label: `${item.piece_type_name} (${gauge || 'Unspecified Gauge'}) - ${available} available`
      };
    }));
  } catch(e) {
    console.error('GET available-inventory error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GAUGE ANALYTICS — full lifecycle purchase→production→sale
// ══════════════════════════════════════════════════════════════════

/* GET /api/daily/gauge-kpi  — KPIs per gauge */
router.get('/gauge-kpi', authenticate, async (req, res) => {
  try {
    const db   = getDb();
    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2099-12-31';

    // Wire purchased per gauge
    const purchased = await db.prepare(`
      SELECT gauge,
             ROUND(SUM(kgs_bought),2)                        AS kgs_bought,
             ROUND(SUM(kgs_bought * cost_per_kg),2)          AS wire_cost,
             ROUND(SUM(transport_cost),2)                    AS transport_cost,
             COUNT(*)                                                   AS purchase_count
      FROM purchases
      WHERE entry_date BETWEEN ? AND ? AND gauge != ''
      GROUP BY gauge ORDER BY kgs_bought DESC
    `).all(from, to);

    // Wire used in production per gauge
    const produced = await db.prepare(`
      SELECT pr.gauge,
             ROUND(SUM(pr.kgs_used),2)                       AS kgs_used,
             COALESCE(SUM(pi.pieces_produced),0)                       AS pieces_produced,
             COUNT(DISTINCT pr.id)                                      AS run_count
      FROM production pr
      LEFT JOIN production_items pi ON pi.production_id = pr.id
      WHERE pr.entry_date BETWEEN ? AND ? AND pr.gauge != ''
      GROUP BY pr.gauge ORDER BY kgs_used DESC
    `).all(from, to);

    // Sales revenue per gauge
    const sold = await db.prepare(`
      SELECT gauge_source                                               AS gauge,
             SUM(quantity)                                             AS pieces_sold,
             ROUND(SUM(quantity * selling_price),2)           AS revenue,
             ROUND(AVG(selling_price),2)                      AS avg_price,
             COUNT(DISTINCT buyer_name)                                 AS unique_customers,
             COUNT(*)                                                   AS sale_count
      FROM sales
      WHERE entry_date BETWEEN ? AND ? AND gauge_source != ''
      GROUP BY gauge_source ORDER BY revenue DESC
    `).all(from, to);

    // Merge into gauge map
    const gaugeMap = {};
    for (const r of purchased) {
      gaugeMap[r.gauge] = gaugeMap[r.gauge] || { gauge: r.gauge };
      Object.assign(gaugeMap[r.gauge], {
        kgs_bought: parseFloat(r.kgs_bought)||0,
        wire_cost:  parseFloat(r.wire_cost)||0,
        transport_cost: parseFloat(r.transport_cost)||0,
        purchase_count: parseInt(r.purchase_count)||0,
      });
    }
    for (const r of produced) {
      gaugeMap[r.gauge] = gaugeMap[r.gauge] || { gauge: r.gauge };
      Object.assign(gaugeMap[r.gauge], {
        kgs_used:        parseFloat(r.kgs_used)||0,
        pieces_produced: parseInt(r.pieces_produced)||0,
        run_count:       parseInt(r.run_count)||0,
      });
    }
    for (const r of sold) {
      gaugeMap[r.gauge] = gaugeMap[r.gauge] || { gauge: r.gauge };
      Object.assign(gaugeMap[r.gauge], {
        pieces_sold:      parseInt(r.pieces_sold)||0,
        revenue:          parseFloat(r.revenue)||0,
        avg_price:        parseFloat(r.avg_price)||0,
        unique_customers: parseInt(r.unique_customers)||0,
        sale_count:       parseInt(r.sale_count)||0,
      });
    }

    const gauges = Object.values(gaugeMap).map(g => ({
      gauge:            g.gauge,
      kgs_bought:       g.kgs_bought       || 0,
      kgs_used:         g.kgs_used         || 0,
      kgs_remaining:    parseFloat(((g.kgs_bought||0) - (g.kgs_used||0)).toFixed(2)),
      wire_cost:        g.wire_cost        || 0,
      pieces_produced:  g.pieces_produced  || 0,
      pieces_sold:      g.pieces_sold      || 0,
      pieces_in_stock:  Math.max(0,(g.pieces_produced||0) - (g.pieces_sold||0)),
      revenue:          g.revenue          || 0,
      avg_price:        g.avg_price        || 0,
      purchase_count:   g.purchase_count   || 0,
      run_count:        g.run_count        || 0,
      sale_count:       g.sale_count       || 0,
      unique_customers: g.unique_customers || 0,
    }));

    // Best gauge by revenue
    const best = gauges.reduce((b, g) => (!b || g.revenue > b.revenue) ? g : b, null);

    res.json({ period: { from, to }, gauges, best_gauge: best?.gauge || null });
  } catch(e) {
    console.error('GET gauge-kpi error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /api/daily/gauge-stock  — Current stock by gauge */
router.get('/gauge-stock', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const bought = await db.prepare(`
      SELECT gauge, COALESCE(SUM(kgs_bought),0) AS kgs_bought
      FROM purchases WHERE gauge != ''
      GROUP BY gauge
    `).all();
    const used = await db.prepare(`
      SELECT gauge, COALESCE(SUM(kgs_used),0) AS kgs_used
      FROM production WHERE gauge != ''
      GROUP BY gauge
    `).all();
    const usedMap = {};
    for (const r of used) usedMap[r.gauge] = parseFloat(r.kgs_used)||0;
    const stock = bought.map(b => ({
      gauge:       b.gauge,
      kgs_bought:  parseFloat(b.kgs_bought)||0,
      kgs_used:    usedMap[b.gauge] || 0,
      kgs_stock:   parseFloat(((parseFloat(b.kgs_bought)||0) - (usedMap[b.gauge]||0)).toFixed(2)),
    }));
    res.json(stock);
  } catch(e) {
    console.error('GET gauge-stock error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

// routes/inventory.js — IMARA LINKS Inventory (GAUGE-AWARE, ACID)
const router = require('express').Router();
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
//  GAUGE-AWARE raw-material balance
//  Logic: for each gauge, stock = Σ kgs_bought(gauge) - Σ kgs_used(gauge)
//         You cannot use more wire than you bought of that specific gauge.
// ─────────────────────────────────────────────────────────────────────────────
async function getGaugeStock(db) {
  // All purchased gauges
  const purchased = await db.prepare(`
    SELECT COALESCE(gauge,'') AS gauge,
           ROUND(SUM(kgs_bought)::numeric,3) AS kgs_bought,
           ROUND(SUM(kgs_bought * cost_per_kg)::numeric,2) AS total_cost
    FROM purchases
    GROUP BY gauge
    ORDER BY gauge
  `).all();

  // All used gauges
  const used = await db.prepare(`
    SELECT COALESCE(gauge,'') AS gauge,
           ROUND(SUM(kgs_used)::numeric,3) AS kgs_used
    FROM production
    GROUP BY gauge
  `).all();

  const usedMap = {};
  for (const u of used) usedMap[u.gauge] = parseFloat(u.kgs_used) || 0;

  const gaugeStocks = purchased.map(p => {
    const g       = p.gauge || '';
    const bought  = parseFloat(p.kgs_bought) || 0;
    const usedKgs = usedMap[g] || 0;
    const remaining = parseFloat((bought - usedKgs).toFixed(3));
    return {
      gauge:          g || 'Unspecified',
      kgs_bought:     bought,
      kgs_used:       usedKgs,
      remaining_kgs:  remaining,
      remaining_pct:  bought > 0 ? parseFloat(((remaining / bought) * 100).toFixed(1)) : 0,
      total_cost:     parseFloat(p.total_cost) || 0,
      out_of_stock:   remaining <= 0,
    };
  });

  // Also catch production gauge entries that have no matching purchase gauge (data anomaly)
  for (const u of used) {
    if (!gaugeStocks.find(g => g.gauge === (u.gauge || 'Unspecified'))) {
      gaugeStocks.push({
        gauge:         u.gauge || 'Unspecified',
        kgs_bought:    0,
        kgs_used:      parseFloat(u.kgs_used) || 0,
        remaining_kgs: -(parseFloat(u.kgs_used) || 0),
        remaining_pct: 0,
        total_cost:    0,
        out_of_stock:  true,
        anomaly:       true, // used more than bought
      });
    }
  }

  const totals = {
    total_bought_kgs:    gaugeStocks.reduce((s, g) => s + g.kgs_bought,    0),
    total_used_kgs:      gaugeStocks.reduce((s, g) => s + g.kgs_used,      0),
    total_remaining_kgs: gaugeStocks.reduce((s, g) => s + g.remaining_kgs, 0),
  };
  totals.total_remaining_kgs = parseFloat(totals.total_remaining_kgs.toFixed(3));

  return { by_gauge: gaugeStocks, totals };
}

// GET /api/inventory
router.get('/', authenticate, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDb();

    const thresholdResult = await db.prepare('SELECT value FROM config WHERE key = ?').get('stock_threshold');
    const threshold = parseFloat(thresholdResult?.value || '100');

    // Gauge-aware raw material
    const gaugeData  = await getGaugeStock(db);
    const { totals } = gaugeData;
    const remaining_kgs = totals.total_remaining_kgs;
    const total_bought  = totals.total_bought_kgs;

    // Finished goods: one row per piece_type × gauge so stock is visible per gauge
    const finished_goods = await db.prepare(`
      WITH produced AS (
        SELECT
          pi.piece_type_id,
          COALESCE(NULLIF(p.gauge,''), 'Unspecified') AS gauge,
          SUM(pi.pieces_produced) AS pieces_produced
        FROM production_items pi
        JOIN production p ON p.id = pi.production_id
        GROUP BY pi.piece_type_id, COALESCE(NULLIF(p.gauge,''), 'Unspecified')
      ),
      sold AS (
        SELECT
          piece_type_id,
          COALESCE(NULLIF(gauge_source,''), 'Unspecified') AS gauge,
          SUM(quantity) AS pieces_sold
        FROM sales
        GROUP BY piece_type_id, COALESCE(NULLIF(gauge_source,''), 'Unspecified')
      )
      SELECT
        pt.id,
        pt.name,
        pt.length_m,
        pt.weight_kg,
        pt.default_price,
        pt.active,
        pr.gauge,
        COALESCE(pr.pieces_produced, 0) AS total_produced,
        COALESCE(so.pieces_sold,    0) AS total_sold,
        COALESCE(pr.pieces_produced, 0) - COALESCE(so.pieces_sold, 0) AS available_pieces,
        CASE
          WHEN COALESCE(pr.pieces_produced,0) - COALESCE(so.pieces_sold,0) <= 0  THEN 'out_of_stock'
          WHEN COALESCE(pr.pieces_produced,0) - COALESCE(so.pieces_sold,0) <= 10 THEN 'low_stock'
          ELSE 'in_stock'
        END AS stock_status
      FROM piece_types pt
      JOIN produced pr ON pr.piece_type_id = pt.id
      LEFT JOIN sold so ON so.piece_type_id = pt.id AND so.gauge = pr.gauge
      WHERE pt.active = 1
      ORDER BY pt.name, pr.gauge
    `).all();

    // Gauge breakdown for sold wire
    const soldByGauge = await db.prepare(`
      SELECT COALESCE(gauge_source,'') AS gauge,
             SUM(quantity) AS pieces_sold,
             ROUND(SUM(quantity * selling_price)::numeric, 2) AS revenue
      FROM sales
      GROUP BY gauge_source
      ORDER BY gauge
    `).all();

    res.json({
      raw_material: {
        remaining_kgs:    parseFloat(remaining_kgs.toFixed(3)),
        total_bought_kgs: parseFloat(total_bought.toFixed(3)),
        total_used_kgs:   parseFloat(totals.total_used_kgs.toFixed(3)),
        remaining_pct:    total_bought > 0 ? parseFloat(((remaining_kgs / total_bought) * 100).toFixed(1)) : 0,
        threshold,
        out_of_stock: remaining_kgs <= 0,
        low_stock:    remaining_kgs > 0 && remaining_kgs <= threshold,
        by_gauge:     gaugeData.by_gauge,
      },
      finished_goods: finished_goods.map(fg => {
        const availablePieces = parseInt(fg.available_pieces) || 0;
        const weightKg = parseFloat(fg.weight_kg) || 0;
        const lengthM = parseFloat(fg.length_m) || 0;
        const defaultPrice = parseFloat(fg.default_price) || 0;
        return {
          ...fg,
          total_produced:   parseInt(fg.total_produced) || 0,
          total_sold:       parseInt(fg.total_sold) || 0,
          available:        availablePieces,
          available_pieces: availablePieces,
          available_kgs:    parseFloat((availablePieces * weightKg).toFixed(2)),
          available_meters:   parseFloat((availablePieces * lengthM).toFixed(2)),
          stock_value:      parseFloat((availablePieces * defaultPrice).toFixed(2)),
          gauge:            fg.gauge || '—',
        };
      }),
      sold_by_gauge: soldByGauge,
      stock_turnover: { ratio: 0, turnover_trend: 'stable', avg_days_to_sell_current_stock: 0 },
    });

  } catch (error) {
    console.error('Inventory data error:', error);
    res.status(500).json({ error: 'Failed to load inventory data' });
  }
});

// GET /api/inventory/worker — limited view for knuckler/operator
router.get('/worker', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gaugeData = await getGaugeStock(db);
    const { totals } = gaugeData;

    const finished_goods = await db.prepare(`
      SELECT
        pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price,
        COALESCE(SUM(pi.pieces_produced), 0)
          - COALESCE((SELECT SUM(s.quantity) FROM sales s WHERE s.piece_type_id = pt.id), 0)
          AS available_pieces,
        CASE
          WHEN COALESCE(SUM(pi.pieces_produced), 0)
               - COALESCE((SELECT SUM(s.quantity) FROM sales s WHERE s.piece_type_id = pt.id), 0) <= 0
            THEN 'out_of_stock'
          WHEN COALESCE(SUM(pi.pieces_produced), 0)
               - COALESCE((SELECT SUM(s.quantity) FROM sales s WHERE s.piece_type_id = pt.id), 0) <= 10
            THEN 'low_stock'
          ELSE 'in_stock'
        END AS stock_status
      FROM piece_types pt
      LEFT JOIN production_items pi ON pt.id = pi.piece_type_id
      WHERE pt.active = 1
      GROUP BY pt.id, pt.name, pt.length_m, pt.weight_kg, pt.default_price
      ORDER BY pt.name
    `).all();

    res.json({
      raw_material: {
        remaining_kgs:    parseFloat(totals.total_remaining_kgs.toFixed(3)),
        total_bought_kgs: parseFloat(totals.total_bought_kgs.toFixed(3)),
        total_used_kgs:   parseFloat(totals.total_used_kgs.toFixed(3)),
        out_of_stock:     totals.total_remaining_kgs <= 0,
        low_stock:        totals.total_remaining_kgs > 0 && totals.total_remaining_kgs <= 100,
        by_gauge:         gaugeData.by_gauge,
      },
      finished_goods: finished_goods.map(fg => ({
        ...fg,
        available_pieces: parseInt(fg.available_pieces) || 0,
      })),
    });
  } catch (error) {
    console.error('Worker inventory error:', error);
    res.status(500).json({ error: 'Failed to load inventory data' });
  }
});

module.exports = router;

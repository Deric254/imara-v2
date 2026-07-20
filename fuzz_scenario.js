// Runs ONE fuzz scenario in its own process - true isolation, no shared state.
const seed = parseInt(process.argv[2]);

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

(async () => {
  process.env.JWT_SECRET = 'fuzz-secret-' + seed + '-1234567890abcdef';
  const express = require('express');
  const cors = require('cors');
  const helmet = require('helmet');
  const { initDb, getDb } = require('./backend/db');

  const app = express();
  await initDb();
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', require('./backend/routes/auth'));
  app.use('/api/users', require('./backend/routes/users'));
  app.use('/api/daily', require('./backend/routes/daily'));
  app.use('/api/reconciliation', require('./backend/routes/reconciliation'));
  app.use('/api/invoices', require('./backend/routes/invoices'));
  app.use('/api', require('./backend/routes/reports'));
  app.use('/api', require('./backend/routes/systemcheck'));
  const server = app.listen(0);
  const BASE_URL = `http://127.0.0.1:${server.address().port}/api`;

  let TOKEN;
  async function req(method, url, body) {
    const res = await fetch(BASE_URL + url, {
      method, headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  const login = await req('POST', '/auth/login', { username: 'owner', password: 'owner1234' });
  TOKEN = login.data.token;

  const numPieceTypes = randInt(1, 4);
  const numGauges = randInt(1, 3);
  const gauges = Array.from({ length: numGauges }, (_, i) => String(10 + i * 2));
  const pieceTypeIds = [];
  for (let i = 0; i < numPieceTypes; i++) {
    await req('POST', '/piece-types', { name: `F${i}`, length_m: randInt(3, 10), weight_kg: randInt(5, 30), default_price: randInt(500, 5000) });
  }
  const pts = await req('GET', '/piece-types');
  for (const pt of pts.data) pieceTypeIds.push(pt.id);

  await req('POST', '/suppliers', { name: `FuzzSupplier` });
  const sups = await req('GET', '/suppliers');
  const supplierId = sups.data[0].id;

  await req('POST', '/users', { username: `fzop`, password: `fzop1234x`, full_name: 'Fuzz Op', role: 'operator' });
  await req('POST', '/users', { username: `fzkn`, password: `fzkn1234x`, full_name: 'Fuzz Kn', role: 'knuckler' });
  const users = await req('GET', '/users');
  const opId = users.data.find(u => u.username === `fzop`).id;
  const knId = users.data.find(u => u.username === `fzkn`).id;

  await req('PUT', '/config', {
    operator_cost: String(randInt(50, 500)), knuckler_cost: String(randInt(25, 250)),
    sack_cost: String(randInt(10, 100)), transport_to_market: String(randInt(5, 50)),
  });

  const numPurchases = randInt(3, 10);
  let day = 1;
  for (let i = 0; i < numPurchases; i++) {
    const gauge = pick(gauges);
    await req('POST', '/daily/purchases', {
      entry_date: `2026-01-${String(day).padStart(2, '0')}`, supplier_id: supplierId, gauge,
      kgs_bought: randInt(20, 300), cost_per_kg: randInt(100, 400), transport_cost: randInt(0, 1000),
    });
    day = Math.min(day + randInt(0, 2), 28);
  }

  const numProdRuns = randInt(2, 8);
  const producedByTypeGauge = {};
  const db = getDb();
  for (let i = 0; i < numProdRuns; i++) {
    const gauge = pick(gauges);
    const stockRes = await db.prepare(`
      SELECT COALESCE(SUM(kgs_bought),0) b, COALESCE((SELECT SUM(kgs_used) FROM production WHERE gauge=?),0) u
      FROM purchases WHERE gauge=?
    `).get(gauge, gauge);
    const available = stockRes.b - stockRes.u;
    if (available < 5) continue;
    const kgsToUse = Math.min(available, randInt(5, 50));
    const typesInRun = pieceTypeIds.slice(0, randInt(1, pieceTypeIds.length));
    const piecesPerType = Math.max(1, Math.floor(kgsToUse / (typesInRun.length * 15)));
    const items = typesInRun.map(ptId => ({ piece_type_id: ptId, pieces_produced: piecesPerType }));
    const r = await req('POST', '/daily/production', {
      entry_date: `2026-01-${String(day).padStart(2, '0')}`, gauge, kgs_used: kgsToUse,
      operator_id: opId, knuckler_id: knId, items,
    });
    if (r.status === 201) {
      for (const ptId of typesInRun) {
        const key = `${ptId}::${gauge}`;
        producedByTypeGauge[key] = (producedByTypeGauge[key] || 0) + piecesPerType;
      }
    }
    day = Math.min(day + randInt(0, 2), 28);
  }

  const numSales = randInt(3, 12);
  const sellEverything = Math.random() < 0.5;
  for (let i = 0; i < numSales; i++) {
    const keys = Object.keys(producedByTypeGauge).filter(k => producedByTypeGauge[k] > 0);
    if (keys.length === 0) break;
    const key = pick(keys);
    const [ptId, gauge] = key.split('::');
    const maxQty = producedByTypeGauge[key];
    const qty = sellEverything ? maxQty : randInt(1, Math.max(1, Math.floor(maxQty * 0.6)));
    const r = await req('POST', '/daily/sales/batch', {
      entry_date: `2026-01-${String(day).padStart(2, '0')}`, buyer_name: `FuzzCustomer${i}`,
      items: [{ piece_type_id: parseInt(ptId), quantity: qty, selling_price: randInt(500, 5000), gauge_source: gauge }],
    });
    if (r.status === 201) producedByTypeGauge[key] -= qty;
    day = Math.min(day + randInt(0, 2), 28);
  }
  if (sellEverything) {
    for (const key of Object.keys(producedByTypeGauge)) {
      if (producedByTypeGauge[key] > 0) {
        const [ptId, gauge] = key.split('::');
        await req('POST', '/daily/sales/batch', {
          entry_date: `2026-01-28`, buyer_name: 'FuzzCleanup',
          items: [{ piece_type_id: parseInt(ptId), quantity: producedByTypeGauge[key], selling_price: 1000, gauge_source: gauge }],
        });
      }
    }
  }

  const billedPerSupplier = await db.prepare('SELECT supplier_id, SUM(kgs_bought*cost_per_kg+transport_cost) v FROM purchases GROUP BY supplier_id').all();
  for (const b of billedPerSupplier) {
    await req('POST', '/reconciliation/payments', { payment_date: '2026-01-28', category: 'supplier', payee_supplier_id: b.supplier_id, amount: b.v });
  }
  const totalOp = (await db.prepare('SELECT COALESCE(SUM(operator_cost),0) v FROM production').get()).v;
  const totalKn = (await db.prepare('SELECT COALESCE(SUM(knuckler_cost),0) v FROM production').get()).v;
  const totalSack = (await db.prepare('SELECT COALESCE(SUM(sack_cost),0) v FROM production').get()).v;
  const totalTransport = (await db.prepare('SELECT COALESCE(SUM(transport_to_market),0) v FROM sales').get()).v;
  if (totalOp > 0) await req('POST', '/reconciliation/payments', { payment_date: '2026-01-28', category: 'wages_operator', payee_user_id: opId, amount: totalOp });
  if (totalKn > 0) await req('POST', '/reconciliation/payments', { payment_date: '2026-01-28', category: 'wages_knuckler', payee_user_id: knId, amount: totalKn });
  if (totalSack > 0) await req('POST', '/reconciliation/payments', { payment_date: '2026-01-28', category: 'sack', amount: totalSack });
  if (totalTransport > 0) await req('POST', '/reconciliation/payments', { payment_date: '2026-01-28', category: 'transport_to_market', amount: totalTransport });

  const allInvoices = await req('GET', '/invoices?from=2026-01-01&to=2026-12-31');
  for (const inv of (allInvoices.data || [])) {
    if (inv.total_amount > inv.amount_paid + 0.01) {
      await req('POST', `/invoices/${inv.id}/cash`, { amount_paid: inv.total_amount - inv.amount_paid, payment_method: 'cash', payment_date: '2026-01-28' });
    }
  }

  const check = await req('GET', '/system-check');
  const fails = (check.data.checks || []).filter(c => c.status === 'fail');

  const dash = await req('GET', '/dashboard?from=2026-01-01&to=2026-01-31');
  let convergeDiff = null;
  if (dash.data && dash.data.kpis) {
    const netProfit = dash.data.kpis.net_profit;
    const soldNet = dash.data.kpis.cogs_net_profit;
    if (netProfit !== undefined && soldNet !== undefined) {
      convergeDiff = Math.abs(netProfit - soldNet);
    }
  }

  server.close();

  // Output a single parseable JSON line for the parent process to collect
  console.log('FUZZRESULT:' + JSON.stringify({
    seed, sellEverything,
    checksTotal: (check.data.checks || []).length,
    failCount: fails.length,
    fails: fails.map(f => ({ label: f.label, detail: f.detail })),
    netProfit: dash.data?.kpis?.net_profit,
    soldNet: dash.data?.kpis?.cogs_net_profit,
    convergeDiff,
  }));
  process.exit(0);
})().catch(e => { console.log('FUZZRESULT:' + JSON.stringify({ seed, crashed: true, error: e.message })); process.exit(1); });

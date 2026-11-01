// test-ecosystem.js — TEST ONLY, not part of the shipped app.
// The public capability card: served without login, carries no secrets, follows its file, and a bad file never breaks the app.
const fs = require('fs');
const http = require('http');
const express = require('express');
const eco = require('./lib/ecosystem');

let failures = 0;
const report = (name, ok, detail) => { console.log(`${ok ? '✅ PASS' : '❌ FAIL'} — ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };

function get(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/ecosystem/card' }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
}

(async () => {
  const app = express();
  app.get('/api/ecosystem/card', eco.handler);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const keep = fs.readFileSync(eco.FILE);
  try {
    let r = await get(port); const card = JSON.parse(r.body);
    report('card is served', r.status === 200 && card.contract === 'dericbi.ecosystem/1' && !!card.id && !!card.name);
    report('offers and accepts are plain strings', [...card.offers, ...card.accepts].every((x) => typeof x === 'string'));
    report('card holds no secret', !/token|secret|password|jwt/i.test(r.body));
    fs.writeFileSync(eco.FILE, JSON.stringify({ ...card, name: 'Renamed' }));
    r = await get(port); report('editing the file changes the card, no code involved', JSON.parse(r.body).name === 'Renamed');
    fs.writeFileSync(eco.FILE, 'not json'); r = await get(port); report('a broken file answers 404', r.status === 404);
    fs.writeFileSync(eco.FILE, JSON.stringify({ id: 'x' })); r = await get(port); report('a file that is not a card answers 404', r.status === 404);
  } finally {
    fs.writeFileSync(eco.FILE, keep);
    server.close();
  }
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log('\n✅ ALL CHECKS PASSED');
})();

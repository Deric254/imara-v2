// The app's public "capability card": who it is and what it offers to other DericBI systems.
// It is read as written from backend/ecosystem.json, so what it says can be edited without touching code.
// It holds no business data and needs no login. A missing or broken file answers 404 and nothing else is affected.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ecosystem.json');

function card() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const ok = c && typeof c === 'object' && ['contract', 'id', 'name'].every((k) => typeof c[k] === 'string' && c[k]);
    return ok ? c : null;
  } catch (_) {
    return null;
  }
}

function handler(_req, res) {
  const c = card();
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
}

module.exports = { handler, FILE };

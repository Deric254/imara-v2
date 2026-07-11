// middleware/auth.js — IMARA LINKS
const jwt     = require('jsonwebtoken');
const { getDb } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

async function authenticate(req, res, next) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token)
    return res.status(401).json({ error: 'No token provided' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db   = getDb();
    const user = await db.prepare(
      'SELECT id,username,role,full_name,active,password_changed_at FROM users WHERE id=?'
    ).get(payload.id);
    if (!user || !user.active)
      return res.status(401).json({ error: 'Account inactive or not found' });

    // Reject tokens issued before the last password change.
    // pca in the token is stored as milliseconds (Date.getTime()).
    // password_changed_at may be stored as ISO timestamp — normalise to ms
    // to milliseconds before comparing so both sides are the same unit.
    // Only enforce when BOTH the token carries a real pca AND the DB has a timestamp.
    const tokenPca = Number(payload.pca);
    if (tokenPca && tokenPca > 0 && user.password_changed_at) {
      const passwordChangedAt = new Date(user.password_changed_at).getTime();
      // Allow a 5-second grace window for clock skew
      if (!isNaN(passwordChangedAt) && passwordChangedAt > tokenPca + 5000) {
        return res.status(401).json({ error: 'Session expired — password was changed. Please log in again.' });
      }
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Insufficient permissions' });
}

// critical=true means: when called from inside a db.transaction() callback,
// a failed audit write must abort the whole transaction rather than being
// swallowed — so the mutation and its audit record are always both-or-neither.
// Every existing call site keeps its original never-throw behavior (critical
// defaults to false) so nothing outside this fix's scope changes behavior.
async function writeAudit(db, { userId, action, table, recordId, oldVals, newVals, ip }, { critical = false } = {}) {
  try {
    const dbHandle = (db && typeof db.prepare === 'function') ? db : getDb();
    let userName = null;
    if (userId != null) {
      const u = await dbHandle.prepare('SELECT full_name FROM users WHERE id=?').get(userId);
      userName = u?.full_name ?? null;
    }
    await dbHandle.prepare(
      `INSERT INTO audit_log(user_id,user_name,action,table_name,record_id,old_values,new_values,ip_address)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      userId   ?? null,
      userName,
      action,
      table    ?? null,
      recordId ?? null,
      oldVals  ? JSON.stringify(oldVals) : null,
      newVals  ? JSON.stringify(newVals) : null,
      ip       ?? null
    );
  } catch (err) {
    console.error(`AUDIT WRITE FAILED — action=${action} table=${table} recordId=${recordId} userId=${userId}:`, err?.message || err);
    // Non-critical (default): never let a failed audit write break the
    // caller's main operation, matching every existing call site's behavior.
    // Critical: propagate so a caller running this inside db.transaction()
    // rolls the whole transaction back rather than losing the audit trail.
    if (critical) throw err;
  }
}

module.exports = { authenticate, requireRole, writeAudit, JWT_SECRET };

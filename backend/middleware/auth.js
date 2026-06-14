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

function auditAction(action, tableName) {
  return (req, _res, next) => {
    req._auditAction = action;
    req._auditTable  = tableName;
    next();
  };
}

async function writeAudit(db, { userId, action, table, recordId, oldVals, newVals, ip }) {
  try {
    const dbHandle = (db && typeof db.prepare === 'function') ? db : getDb();
    await dbHandle.prepare(
      `INSERT INTO audit_log(user_id,action,table_name,record_id,old_values,new_values,ip_address)
       VALUES(?,?,?,?,?,?,?)`
    ).run(
      userId   ?? null,
      action,
      table    ?? null,
      recordId ?? null,
      oldVals  ? JSON.stringify(oldVals) : null,
      newVals  ? JSON.stringify(newVals) : null,
      ip       ?? null
    );
  } catch { /* never let audit break the flow */ }
}

module.exports = { authenticate, requireRole, auditAction, writeAudit, JWT_SECRET };

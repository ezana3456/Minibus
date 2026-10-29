const jwt = require('jsonwebtoken');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.kind === 'staff') return res.status(403).json({ error: 'Not allowed' });
    req.user = p;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
// Admin panel auth. roles = allowed roles (empty = any staff).
const staffAuth = (...roles) => (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.kind !== 'staff') return res.status(401).json({ error: 'Please log in' });
    if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: 'You do not have permission for this' });
    req.staff = p;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
};
// admin sees everything (null); others only their own operator
const opScope = (req) => (req.staff.role === 'admin' ? null : req.staff.operatorId ?? 0);

module.exports = { wrap, auth, staffAuth, opScope };

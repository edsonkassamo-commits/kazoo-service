const jwt = require('jsonwebtoken');
const db  = require('../utils/db');

// ── Verify JWT Access Token ───────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token inahitajika. Ingia kwanza.' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    // Fetch fresh user from DB (catches suspended/banned accounts)
    const user = await db('users')
      .where({ id: decoded.userId, deleted_at: null })
      .first();

    if (!user) {
      return res.status(401).json({ success: false, message: 'Akaunti haipatikani.' });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Akaunti imesimamishwa. Wasiliana na msaada.' });
    }
    if (user.status === 'banned') {
      return res.status(403).json({ success: false, message: 'Akaunti imefungwa.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token imekwisha. Ingia tena.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Token si sahihi.' });
  }
};

// ── Role-Based Access Control ─────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Unahitaji kuingia.' });
  if (!roles.includes(req.user.account_type)) {
    return res.status(403).json({
      success: false,
      message: `Huna ruhusa. Inahitajika: ${roles.join(' au ')}`
    });
  }
  next();
};

const isAdmin    = requireRole('admin');
const isProvider = requireRole('provider', 'admin');
const isCustomer = requireRole('customer', 'admin');

// ── Optional Auth (for public routes that show more to logged-in users) ──
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return next();
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await db('users').where({ id: decoded.userId, deleted_at: null }).first();
    req.user = user || null;
  } catch {
    req.user = null;
  }
  next();
};

module.exports = { authenticate, requireRole, isAdmin, isProvider, isCustomer, optionalAuth };

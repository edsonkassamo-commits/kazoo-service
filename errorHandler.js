const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.message}`, err.stack);

  // Joi validation errors
  if (err.isJoi) {
    return res.status(400).json({
      success: false,
      message: 'Data si sahihi.',
      errors: err.details.map(d => d.message)
    });
  }

  // Knex / DB errors
  if (err.code === '23505') { // unique violation
    return res.status(409).json({ success: false, message: 'Rekodi hii tayari ipo.' });
  }
  if (err.code === '23503') { // foreign key violation
    return res.status(400).json({ success: false, message: 'Kiungo hakipatikani.' });
  }

  // JWT errors handled in middleware/auth.js — but fallback:
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Token si sahihi.' });
  }

  // App-level operational errors (thrown with statusCode)
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }

  // Unexpected errors
  return res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Hitilafu ya ndani ya seva. Wasiliana na msaada.'
      : err.message
  });
};

// Helper to create app errors
const createError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

module.exports = errorHandler;
module.exports.createError = createError;

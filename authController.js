const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Joi     = require('joi');
const db      = require('../utils/db');
const redis   = require('../utils/redis');
const sms     = require('../services/smsService');
const { createError } = require('../middleware/errorHandler');

// ── Validation Schemas ────────────────────────────────────
const registerSchema = Joi.object({
  full_name:    Joi.string().min(2).max(100).required(),
  phone:        Joi.string().pattern(/^\+255[67]\d{8}$/).required()
                  .messages({ 'string.pattern.base': 'Namba ya simu si sahihi. Tumia +255XXXXXXXXX' }),
  email:        Joi.string().email().optional().allow(''),
  password:     Joi.string().min(6).required(),
  account_type: Joi.string().valid('customer', 'provider').required(),
  nin:          Joi.string().min(8).max(30).required(),
  lang:         Joi.string().valid('sw','en','fr','ar').default('sw'),
});

const loginSchema = Joi.object({
  phone:    Joi.string().required(),
  password: Joi.string().required(),
});

const otpSchema = Joi.object({
  phone: Joi.string().pattern(/^\+255[67]\d{8}$/).required(),
  type:  Joi.string().valid('verify_phone','reset_password','login_2fa').default('verify_phone'),
});

// ── Helpers ───────────────────────────────────────────────
const generateTokens = (userId, accountType) => {
  const access = jwt.sign(
    { userId, accountType },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' }
  );
  const refresh = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d' }
  );
  return { access, refresh };
};

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const safeUser = (user) => {
  const { password_hash, nin, ...safe } = user;
  return safe;
};

// ── Controllers ───────────────────────────────────────────

// POST /auth/register
exports.register = async (req, res, next) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { full_name, phone, email, password, account_type, nin, lang } = value;

    // Check duplicates
    const existing = await db('users')
      .where(function() { this.where('phone', phone).orWhere('nin', nin) })
      .whereNull('deleted_at').first();

    if (existing) {
      if (existing.phone === phone) return res.status(409).json({ success: false, message: 'Namba hii ya simu tayari imesajiliwa.' });
      if (existing.nin === nin)     return res.status(409).json({ success: false, message: 'NIN hii tayari imesajiliwa.' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    await db.transaction(async trx => {
      await trx('users').insert({
        id: userId, full_name, phone, email: email || null,
        password_hash, account_type, nin, lang,
        status: 'active',
        created_at: new Date(), updated_at: new Date()
      });

      // Create provider profile placeholder
      if (account_type === 'provider') {
        await trx('provider_profiles').insert({
          id: uuidv4(), user_id: userId,
          is_verified: false, is_available: true,
          avg_rating: 0, total_jobs: 0, total_earnings: 0,
          commission_rate: 15.00,
          created_at: new Date(), updated_at: new Date()
        });
      }
    });

    // Send OTP to verify phone
    const otp = generateOtp();
    await db('otp_codes').insert({
      id: uuidv4(), phone, code: otp, type: 'verify_phone',
      expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10 min
      used: false, created_at: new Date()
    });
    await sms.sendOtp(phone, otp, lang);

    const tokens = generateTokens(userId, account_type);
    const newUser = await db('users').where({ id: userId }).first();

    res.status(201).json({
      success: true,
      message: lang === 'sw' ? 'Akaunti imefunguliwa! Thibitisha simu yako.' : 'Account created! Verify your phone.',
      data: { user: safeUser(newUser), tokens }
    });
  } catch (err) { next(err); }
};

// POST /auth/login
exports.login = async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { phone, password } = value;
    const user = await db('users').where({ phone }).whereNull('deleted_at').first();

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, message: 'Namba ya simu au nywila si sahihi.' });
    }
    if (user.status === 'suspended') return res.status(403).json({ success: false, message: 'Akaunti imesimamishwa.' });
    if (user.status === 'banned')    return res.status(403).json({ success: false, message: 'Akaunti imefungwa.' });

    // Update last seen
    await db('users').where({ id: user.id }).update({ last_seen_at: new Date(), updated_at: new Date() });

    const tokens = generateTokens(user.id, user.account_type);

    // Store refresh token in Redis
    await redis.setEx(`refresh:${user.id}`, 7 * 24 * 3600, tokens.refresh);

    res.json({
      success: true,
      message: `Karibu tena, ${user.full_name}!`,
      data: { user: safeUser(user), tokens }
    });
  } catch (err) { next(err); }
};

// POST /auth/send-otp
exports.sendOtp = async (req, res, next) => {
  try {
    const { error, value } = otpSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { phone, type } = value;

    // Rate limit: max 3 OTPs per phone per 15 min
    const recent = await db('otp_codes')
      .where({ phone, type })
      .where('created_at', '>', new Date(Date.now() - 15 * 60 * 1000))
      .count('id as cnt').first();
    if (parseInt(recent.cnt) >= 3) {
      return res.status(429).json({ success: false, message: 'OTP nyingi sana. Subiri dakika 15.' });
    }

    // Expire old unused OTPs
    await db('otp_codes').where({ phone, type, used: false }).update({ used: true });

    const otp = generateOtp();
    await db('otp_codes').insert({
      id: uuidv4(), phone, code: otp, type,
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      used: false, created_at: new Date()
    });

    const user = await db('users').where({ phone }).first();
    await sms.sendOtp(phone, otp, user?.lang || 'sw');

    res.json({ success: true, message: 'OTP imetumwa kwa simu yako. Inakwisha dakika 10.' });
  } catch (err) { next(err); }
};

// POST /auth/verify-otp
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, code, type = 'verify_phone' } = req.body;
    if (!phone || !code) return res.status(400).json({ success: false, message: 'Simu na OTP zinahitajika.' });

    const otpRecord = await db('otp_codes')
      .where({ phone, code, type, used: false })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc').first();

    if (!otpRecord) {
      return res.status(400).json({ success: false, message: 'OTP si sahihi au imekwisha.' });
    }

    await db('otp_codes').where({ id: otpRecord.id }).update({ used: true });

    if (type === 'verify_phone') {
      await db('users').where({ phone }).update({ phone_verified: true, updated_at: new Date() });
    }

    res.json({ success: true, message: 'Uthibitisho umefanikiwa.' });
  } catch (err) { next(err); }
};

// POST /auth/refresh
exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ success: false, message: 'Refresh token inahitajika.' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const stored  = await redis.get(`refresh:${decoded.userId}`);
    if (!stored || stored !== refreshToken) {
      return res.status(401).json({ success: false, message: 'Token si halali. Ingia tena.' });
    }

    const user = await db('users').where({ id: decoded.userId, deleted_at: null }).first();
    if (!user) return res.status(401).json({ success: false, message: 'Mtumiaji haipatikani.' });

    const tokens = generateTokens(user.id, user.account_type);
    await redis.setEx(`refresh:${user.id}`, 7 * 24 * 3600, tokens.refresh);

    res.json({ success: true, data: { tokens } });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token si halali. Ingia tena.' });
    }
    next(err);
  }
};

// POST /auth/logout
exports.logout = async (req, res, next) => {
  try {
    await redis.del(`refresh:${req.user.id}`);
    res.json({ success: true, message: 'Umetoka salama. Kwa heri! 👋' });
  } catch (err) { next(err); }
};

// POST /auth/forgot-password
exports.forgotPassword = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const user = await db('users').where({ phone }).whereNull('deleted_at').first();
    // Always return success to prevent phone enumeration
    if (!user) return res.json({ success: true, message: 'Kama namba ipo, OTP imetumwa.' });

    const otp = generateOtp();
    await db('otp_codes').where({ phone, type: 'reset_password', used: false }).update({ used: true });
    await db('otp_codes').insert({
      id: uuidv4(), phone, code: otp, type: 'reset_password',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      used: false, created_at: new Date()
    });
    await sms.sendOtp(phone, otp, user.lang, 'reset');

    res.json({ success: true, message: 'Kama namba ipo, OTP imetumwa.' });
  } catch (err) { next(err); }
};

// POST /auth/reset-password
exports.resetPassword = async (req, res, next) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) {
      return res.status(400).json({ success: false, message: 'Taarifa zote zinahitajika.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Nywila iwe angalau herufi 6.' });
    }

    const otpRecord = await db('otp_codes')
      .where({ phone, code, type: 'reset_password', used: false })
      .where('expires_at', '>', new Date()).first();

    if (!otpRecord) return res.status(400).json({ success: false, message: 'OTP si sahihi au imekwisha.' });

    const password_hash = await bcrypt.hash(newPassword, 12);
    await db('users').where({ phone }).update({ password_hash, updated_at: new Date() });
    await db('otp_codes').where({ id: otpRecord.id }).update({ used: true });

    // Invalidate all sessions
    const user = await db('users').where({ phone }).first();
    if (user) await redis.del(`refresh:${user.id}`);

    res.json({ success: true, message: 'Nywila imebadilishwa. Ingia upya.' });
  } catch (err) { next(err); }
};

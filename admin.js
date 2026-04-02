const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db      = require('../utils/db');
const push    = require('../services/pushService');
const payment = require('../services/paymentService');
const { authenticate, isAdmin } = require('../middleware/auth');

router.use(authenticate, isAdmin); // All admin routes require admin role

// ── Dashboard Stats ────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const [users, providers, bookings, revenue, reports, openReports] = await Promise.all([
      db('users').whereNull('deleted_at').count('id as c').first(),
      db('users').where({ account_type: 'provider' }).whereNull('deleted_at').count('id as c').first(),
      db('bookings').count('id as c').first(),
      db('payments').where({ status: 'success' }).sum('amount as total').first(),
      db('reports').count('id as c').first(),
      db('reports').where({ status: 'open' }).count('id as c').first(),
    ]);

    // Bookings by status
    const bookingStats = await db('bookings').select('status').count('id as count').groupBy('status');

    // Revenue last 30 days
    const recentRevenue = await db('payments')
      .where({ status: 'success' })
      .where('confirmed_at', '>', new Date(Date.now() - 30 * 86400000))
      .sum('amount as total').first();

    // New users last 7 days
    const newUsers = await db('users')
      .where('created_at', '>', new Date(Date.now() - 7 * 86400000))
      .whereNull('deleted_at').count('id as c').first();

    res.json({
      success: true,
      data: {
        total_users:       parseInt(users.c),
        total_providers:   parseInt(providers.c),
        total_bookings:    parseInt(bookings.c),
        total_revenue:     parseFloat(revenue.total || 0),
        total_reports:     parseInt(reports.c),
        open_reports:      parseInt(openReports.c),
        new_users_7d:      parseInt(newUsers.c),
        revenue_30d:       parseFloat(recentRevenue.total || 0),
        bookings_by_status: bookingStats,
      }
    });
  } catch (err) { next(err); }
});

// ── Users Management ───────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const { search, account_type, status, page = 1, limit = 30 } = req.query;
    let query = db('users').whereNull('deleted_at').orderBy('created_at', 'desc').limit(limit).offset((page - 1) * limit);
    if (search)       query = query.where(q => q.where('full_name', 'ilike', `%${search}%`).orWhere('phone', 'ilike', `%${search}%`));
    if (account_type) query = query.where({ account_type });
    if (status)       query = query.where({ status });
    const users = await query.select('id','full_name','phone','email','account_type','status','phone_verified','nin_verified','created_at','last_seen_at');
    const total = await db('users').whereNull('deleted_at').count('id as c').first();
    res.json({ success: true, data: users, total: parseInt(total.c), page: +page });
  } catch (err) { next(err); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ success: false, message: 'Mtumiaji haipatikani.' });
    const provProfile = await db('provider_profiles').where({ user_id: user.id }).first();
    const bookingCount = await db('bookings').where(q => q.where('customer_id', user.id).orWhere('provider_id', user.id)).count('id as c').first();
    const reports = await db('reports').where('reported_id', user.id).count('id as c').first();
    res.json({ success: true, data: { ...user, provider_profile: provProfile, booking_count: parseInt(bookingCount.c), report_count: parseInt(reports.c) } });
  } catch (err) { next(err); }
});

// Suspend / Ban / Activate user
router.put('/users/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const validStatuses = ['active', 'suspended', 'banned'];
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Hali si sahihi.' });

    await db('users').where({ id: req.params.id }).update({ status, updated_at: new Date() });
    await db('admin_actions').insert({
      id: uuidv4(), admin_id: req.user.id, target_id: req.params.id,
      action: `user_${status}`, reason: reason || '', created_at: new Date()
    });

    const msgs = { active: 'Akaunti imewashwa.', suspended: 'Akaunti imesimamishwa.', banned: 'Akaunti imefungwa.' };
    res.json({ success: true, message: msgs[status] });
  } catch (err) { next(err); }
});

// ── Provider Verification ──────────────────────────────────
router.get('/providers/pending', async (req, res, next) => {
  try {
    const providers = await db('provider_profiles as pp')
      .join('users as u', 'pp.user_id', 'u.id')
      .where({ 'pp.is_verified': false })
      .whereNotNull('pp.id_doc_url')
      .select('pp.*', 'u.full_name', 'u.phone', 'u.email', 'u.avatar_url', 'u.nin')
      .orderBy('pp.created_at', 'desc');
    res.json({ success: true, data: providers });
  } catch (err) { next(err); }
});

router.put('/providers/:id/verify', async (req, res, next) => {
  try {
    const { approved, reason } = req.body;
    const profile = await db('provider_profiles').where({ user_id: req.params.id }).first();
    if (!profile) return res.status(404).json({ success: false, message: 'Profaili haipatikani.' });

    await db('provider_profiles').where({ user_id: req.params.id }).update({ is_verified: !!approved, updated_at: new Date() });
    if (!approved) {
      await db('users').where({ id: req.params.id }).update({ status: 'active' });
    }
    await db('admin_actions').insert({
      id: uuidv4(), admin_id: req.user.id, target_id: req.params.id,
      action: approved ? 'provider_verified' : 'provider_rejected', reason: reason || '', created_at: new Date()
    });

    // Notify provider
    const user = await db('users').where({ id: req.params.id }).first();
    if (user?.fcm_token) {
      const title = approved ? '✅ Umethbitishwa!' : '❌ Uthibitisho Umekataliwa';
      const body  = approved ? 'Profaili yako imethibitishwa. Anza kupokea bookings!' : `Uthibitisho ulikataliwa: ${reason || 'Wasiliana na msaada.'}`;
      push.send(user.fcm_token, title, body);
    }

    res.json({ success: true, message: approved ? 'Provider amethibitishwa.' : 'Provider amekataliwa.' });
  } catch (err) { next(err); }
});

// ── Reports Management ─────────────────────────────────────
router.get('/reports', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let query = db('reports as r')
      .join('users as reporter', 'r.reporter_id', 'reporter.id')
      .join('users as reported', 'r.reported_id', 'reported.id')
      .leftJoin('bookings as b', 'r.booking_id', 'b.id')
      .select('r.*', 'reporter.full_name as reporter_name', 'reporter.phone as reporter_phone',
              'reported.full_name as reported_name', 'reported.phone as reported_phone', 'reported.account_type as reported_type',
              'b.booking_ref', 'b.total_amount as booking_amount')
      .orderBy('r.created_at', 'desc').limit(limit).offset((page - 1) * limit);
    if (status) query = query.where('r.status', status);
    const reports = await query;
    res.json({ success: true, data: reports });
  } catch (err) { next(err); }
});

router.put('/reports/:id/resolve', async (req, res, next) => {
  try {
    const { action, admin_notes } = req.body;
    const validActions = ['none','warning','suspended','banned','refunded','dismissed'];
    if (!validActions.includes(action)) return res.status(400).json({ success: false, message: 'Action si sahihi.' });

    const report = await db('reports').where({ id: req.params.id }).first();
    if (!report) return res.status(404).json({ success: false, message: 'Ripoti haipatikani.' });

    await db('reports').where({ id: report.id }).update({
      status: action === 'dismissed' ? 'dismissed' : 'resolved',
      action_taken: action, admin_notes: admin_notes || '',
      resolved_by: req.user.id, resolved_at: new Date()
    });

    // Apply action to reported user
    if (action === 'suspended' || action === 'banned') {
      await db('users').where({ id: report.reported_id }).update({ status: action, updated_at: new Date() });
    }

    // Process refund if action is 'refunded'
    if (action === 'refunded' && report.booking_id) {
      try { await payment.refund({ bookingId: report.booking_id, reason: admin_notes, adminId: req.user.id }); }
      catch (e) { logger.warn('Refund failed during report resolution:', e.message); }
    }

    await db('admin_actions').insert({
      id: uuidv4(), admin_id: req.user.id, target_id: report.reported_id,
      action: `report_${action}`, reason: admin_notes || '', created_at: new Date()
    });

    // Notify both parties
    const [reporter, reported] = await Promise.all([
      db('users').where({ id: report.reporter_id }).first(),
      db('users').where({ id: report.reported_id }).first(),
    ]);
    if (reporter?.fcm_token) push.send(reporter.fcm_token, '📋 Ripoti Imeshughulikiwa', `Ripoti yako imeshughulikiwa. Hatua: ${action}`);
    if (reported?.fcm_token && action !== 'none') push.send(reported.fcm_token, '⚠️ Taarifa Muhimu', `Akaunti yako imeshughulikiwa. Wasiliana na msaada kwa maelezo.`);

    res.json({ success: true, message: 'Ripoti imeshughulikiwa.' });
  } catch (err) { next(err); }
});

// ── Analytics ──────────────────────────────────────────────
router.get('/analytics/revenue', async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const data = await db('payments')
      .where({ status: 'success' })
      .where('confirmed_at', '>', new Date(Date.now() - days * 86400000))
      .select(db.raw('DATE(confirmed_at) as date'), db.raw('SUM(amount) as revenue'), db.raw('COUNT(*) as count'))
      .groupByRaw('DATE(confirmed_at)').orderBy('date', 'asc');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/analytics/bookings', async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const data = await db('bookings')
      .where('created_at', '>', new Date(Date.now() - days * 86400000))
      .select(db.raw('DATE(created_at) as date'), db.raw('COUNT(*) as count'), 'status')
      .groupByRaw('DATE(created_at), status').orderBy('date', 'asc');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── Broadcast Notification ─────────────────────────────────
router.post('/broadcast', async (req, res, next) => {
  try {
    const { title, body, segment = 'all' } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: 'Title na body zinahitajika.' });

    let query = db('users').whereNotNull('fcm_token').whereNull('deleted_at').where({ status: 'active' });
    if (segment === 'customers') query = query.where({ account_type: 'customer' });
    if (segment === 'providers') query = query.where({ account_type: 'provider' });

    const users = await query.select('fcm_token');
    const tokens = users.map(u => u.fcm_token).filter(Boolean);

    // Send in batches of 500 (FCM limit)
    for (let i = 0; i < tokens.length; i += 500) {
      await push.sendMulti(tokens.slice(i, i + 500), title, body);
    }

    res.json({ success: true, message: `Notification imetumwa kwa watumiaji ${tokens.length}.` });
  } catch (err) { next(err); }
});

module.exports = router;

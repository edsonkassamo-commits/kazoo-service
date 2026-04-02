const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db  = require('../utils/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// POST /reviews — Only after booking completed AND paid
router.post('/', async (req, res, next) => {
  try {
    const { booking_id, rating, comment } = req.body;
    if (!booking_id || !rating) return res.status(400).json({ success: false, message: 'booking_id na rating zinahitajika.' });
    if (rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating lazima iwe kati ya 1 na 5.' });

    const booking = await db('bookings').where({ id: booking_id }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });

    // Must be involved party
    if (booking.customer_id !== req.user.id && booking.provider_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Huna ruhusa kutoa tathmini hii.' });
    }
    // CRITICAL: Can only rate after payment
    if (!booking.can_rate) {
      return res.status(403).json({ success: false, message: 'Unaweza kutoa tathmini baada ya huduma kulipwa tu.' });
    }
    // Prevent duplicate review per booking per user
    const existing = await db('reviews').where({ booking_id, reviewer_id: req.user.id }).first();
    if (existing) return res.status(409).json({ success: false, message: 'Umeshatathmini booking hii.' });

    // Determine who is being reviewed
    const revieweeId = req.user.id === booking.customer_id ? booking.provider_id : booking.customer_id;

    const review = { id: uuidv4(), booking_id, reviewer_id: req.user.id, reviewee_id: revieweeId, rating: parseInt(rating), comment: comment || null, is_visible: true, created_at: new Date() };
    await db('reviews').insert(review);

    // Update provider avg_rating
    if (revieweeId === booking.provider_id) {
      const stats = await db('reviews').where({ reviewee_id: revieweeId, is_visible: true }).avg('rating as avg').count('id as cnt').first();
      await db('provider_profiles').where({ user_id: revieweeId }).update({
        avg_rating: parseFloat(stats.avg || 0).toFixed(2),
        updated_at: new Date()
      });
    }

    res.status(201).json({ success: true, message: 'Tathmini imetumwa. Asante! ⭐', data: review });
  } catch (err) { next(err); }
});

// GET /reviews/provider/:id
router.get('/provider/:id', async (req, res, next) => {
  try {
    const reviews = await db('reviews as r')
      .join('users as u', 'r.reviewer_id', 'u.id')
      .where({ 'r.reviewee_id': req.params.id, 'r.is_visible': true })
      .select('r.*', 'u.full_name as reviewer_name', 'u.avatar_url as reviewer_avatar')
      .orderBy('r.created_at', 'desc').limit(50);
    const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
    res.json({ success: true, data: reviews, avg_rating: +avg.toFixed(2), total: reviews.length });
  } catch (err) { next(err); }
});

module.exports = router;

// ════════════════════════════════════════════════
// Reports Router (separate export below — 
// in production put in routes/reports.js)
// ════════════════════════════════════════════════
const reportRouter = express.Router();
reportRouter.use(authenticate);

// POST /reports
reportRouter.post('/', async (req, res, next) => {
  try {
    const { reported_id, booking_id, reason, description, evidence_urls } = req.body;
    if (!reported_id || !description) return res.status(400).json({ success: false, message: 'Taarifa zote zinahitajika.' });

    const validReasons = ['fraud','abuse','no_show','poor_service','harassment','other'];
    if (!validReasons.includes(reason)) return res.status(400).json({ success: false, message: 'Sababu si sahihi.' });

    // Can't report yourself
    if (reported_id === req.user.id) return res.status(400).json({ success: false, message: 'Huwezi kujiripoti mwenyewe.' });

    const report = {
      id: uuidv4(), reporter_id: req.user.id, reported_id,
      booking_id: booking_id || null, reason, description,
      evidence_urls: evidence_urls ? JSON.stringify(evidence_urls) : null,
      status: 'open', created_at: new Date()
    };
    await db('reports').insert(report);

    res.status(201).json({ success: true, message: 'Ripoti imewasilishwa. Admin atashughulikia hivi karibuni.', data: { id: report.id } });
  } catch (err) { next(err); }
});

// GET /reports/me
reportRouter.get('/me', async (req, res, next) => {
  try {
    const reports = await db('reports as r')
      .join('users as rep', 'r.reported_id', 'rep.id')
      .where('r.reporter_id', req.user.id)
      .select('r.*', 'rep.full_name as reported_name', 'rep.avatar_url as reported_avatar')
      .orderBy('r.created_at', 'desc');
    res.json({ success: true, data: reports });
  } catch (err) { next(err); }
});

module.exports.reportRouter = reportRouter;

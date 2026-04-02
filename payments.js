const express = require('express');
const router  = express.Router();
const { authenticate, isAdmin } = require('../middleware/auth');
const paymentSvc = require('../services/paymentService');
const db = require('../utils/db');
const { v4: uuidv4 } = require('uuid');

// POST /payments/initiate
router.post('/initiate', authenticate, async (req, res, next) => {
  try {
    const { booking_id, phone, method = 'mpesa' } = req.body;
    if (!booking_id || !phone) return res.status(400).json({ success: false, message: 'booking_id na phone zinahitajika.' });

    const booking = await db('bookings').where({ id: booking_id, customer_id: req.user.id, payment_status: 'unpaid' }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani au tayari imelipwa.' });

    const result = await paymentSvc.initiate({
      bookingId: booking.id, phone, amount: booking.total_amount,
      customerId: req.user.id, method
    });
    res.json({ success: true, message: result.message, data: result });
  } catch (err) { next(err); }
});

// GET /payments/:id/status
router.get('/:id/status', authenticate, async (req, res, next) => {
  try {
    const payment = await paymentSvc.checkStatus(req.params.id);
    res.json({ success: true, data: payment });
  } catch (err) { next(err); }
});

// GET /payments/history
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const payments = await db('payments as pay')
      .join('bookings as b', 'pay.booking_id', 'b.id')
      .join('services as s', 'b.service_id', 's.id')
      .where('pay.payer_id', req.user.id)
      .select('pay.*', 's.title as service_title', 'b.booking_ref')
      .orderBy('pay.initiated_at', 'desc')
      .limit(50);
    res.json({ success: true, data: payments });
  } catch (err) { next(err); }
});

// POST /payments/webhook/selcom (public — verified by HMAC)
router.post('/webhook/selcom', paymentSvc.handleSelcomWebhook);

// POST /payments/refund (admin only)
router.post('/refund', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { booking_id, reason } = req.body;
    if (!booking_id) return res.status(400).json({ success: false, message: 'booking_id inahitajika.' });
    const result = await paymentSvc.refund({ bookingId: booking_id, reason, adminId: req.user.id });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;

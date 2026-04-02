const { v4: uuidv4 } = require('uuid');
const db   = require('../utils/db');
const push = require('../services/pushService');
const sms  = require('../services/smsService');
const { createError } = require('../middleware/errorHandler');

// Generate booking reference: KZ-2025-XXXXXX
const generateRef = () => {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `KZ-${year}-${rand}`;
};

const sendBookingNotif = async (io, toUserId, type, booking, extra = {}) => {
  const msgs = {
    new_booking:   { title: '📅 Booking Mpya', body: `Una booking mpya kutoka ${extra.customerName}` },
    accepted:      { title: '✅ Booking Imekubaliwa', body: `${extra.providerName} atakuja ${booking.scheduled_at}` },
    rejected:      { title: '❌ Booking Imekataliwa', body: `${extra.providerName} alikataa booking yako` },
    started:       { title: '🔧 Huduma Imeanza', body: `${extra.providerName} yupo njiani!` },
    completed:     { title: '🎉 Huduma Imekamilika', body: `Lipa na toa tathmini yako` },
    cancelled:     { title: '🚫 Booking Imefutwa', body: `Booking ${booking.booking_ref} imefutwa` },
  };
  const n = msgs[type];
  if (!n) return;

  // Save to DB
  await db('notifications').insert({
    id: uuidv4(), user_id: toUserId,
    title: n.title, body: n.body, type,
    data: JSON.stringify({ booking_id: booking.id, booking_ref: booking.booking_ref }),
    read: false, created_at: new Date()
  });

  // Send FCM push
  const user = await db('users').where({ id: toUserId }).select('fcm_token').first();
  if (user?.fcm_token) {
    push.send(user.fcm_token, n.title, n.body, { booking_id: booking.id });
  }

  // Socket real-time
  if (io) io.to(`user:${toUserId}`).emit('notification', { type, booking });
};

// POST /bookings — Create new booking
exports.create = async (req, res, next) => {
  try {
    const { service_id, provider_id, scheduled_at, address, address_lat, address_lng, notes } = req.body;
    if (!service_id || !provider_id || !scheduled_at || !address) {
      return res.status(400).json({ success: false, message: 'Taarifa zote za lazima zinahitajika.' });
    }

    // Validate service exists and belongs to provider
    const service = await db('services')
      .where({ id: service_id, provider_id, is_active: true }).first();
    if (!service) return res.status(404).json({ success: false, message: 'Huduma haipatikani.' });

    // Validate provider is verified and available
    const provProfile = await db('provider_profiles').where({ user_id: provider_id, is_available: true }).first();
    if (!provProfile) return res.status(400).json({ success: false, message: 'Mtoa huduma hapatikani sasa.' });

    // Calculate amounts
    const platformFee   = (service.price * provProfile.commission_rate) / 100;
    const providerAmount = service.price - platformFee;

    const bookingId = uuidv4();
    const booking = {
      id: bookingId,
      booking_ref:     generateRef(),
      customer_id:     req.user.id,
      provider_id,
      service_id,
      status:          'pending',
      scheduled_at:    new Date(scheduled_at),
      address,
      address_lat:     address_lat || null,
      address_lng:     address_lng || null,
      notes:           notes || null,
      total_amount:    service.price,
      platform_fee:    platformFee,
      provider_amount: providerAmount,
      payment_status:  'unpaid',
      can_rate:        false,
      created_at:      new Date(),
      updated_at:      new Date()
    };

    await db('bookings').insert(booking);

    const io = req.app.get('io');
    const customer = await db('users').where({ id: req.user.id }).first();
    await sendBookingNotif(io, provider_id, 'new_booking', booking, { customerName: customer.full_name });

    res.status(201).json({ success: true, message: 'Booking imewekwa!', data: booking });
  } catch (err) { next(err); }
};

// GET /bookings — List user's bookings
exports.list = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = db('bookings as b')
      .join('services as s', 'b.service_id', 's.id')
      .join('users as c', 'b.customer_id', 'c.id')
      .join('users as p', 'b.provider_id', 'p.id')
      .select(
        'b.*',
        's.title as service_title', 's.category as service_category',
        'c.full_name as customer_name', 'c.phone as customer_phone', 'c.avatar_url as customer_avatar',
        'p.full_name as provider_name', 'p.phone as provider_phone', 'p.avatar_url as provider_avatar'
      )
      .orderBy('b.created_at', 'desc')
      .limit(limit).offset(offset);

    // Show own bookings depending on role
    if (req.user.account_type === 'customer') {
      query = query.where('b.customer_id', req.user.id);
    } else if (req.user.account_type === 'provider') {
      query = query.where('b.provider_id', req.user.id);
    }

    if (status) query = query.where('b.status', status);

    const bookings = await query;
    res.json({ success: true, data: bookings, page: +page, limit: +limit });
  } catch (err) { next(err); }
};

// GET /bookings/:id
exports.getOne = async (req, res, next) => {
  try {
    const booking = await db('bookings as b')
      .join('services as s', 'b.service_id', 's.id')
      .join('users as c', 'b.customer_id', 'c.id')
      .join('users as p', 'b.provider_id', 'p.id')
      .leftJoin('provider_profiles as pp', 'p.id', 'pp.user_id')
      .where('b.id', req.params.id)
      .select('b.*', 's.title as service_title', 's.price', 's.category',
              'c.full_name as customer_name', 'c.phone as customer_phone', 'c.avatar_url as customer_avatar',
              'p.full_name as provider_name', 'p.phone as provider_phone', 'p.avatar_url as provider_avatar',
              'pp.avg_rating as provider_rating')
      .first();

    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });

    // Only involved parties can see
    if (req.user.account_type !== 'admin' &&
        booking.customer_id !== req.user.id &&
        booking.provider_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Huna ruhusa kuona booking hii.' });
    }

    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
};

// GET /bookings/:id/receipt
exports.getReceipt = async (req, res, next) => {
  try {
    const booking = await db('bookings as b')
      .join('users as c', 'b.customer_id', 'c.id')
      .join('users as p', 'b.provider_id', 'p.id')
      .join('services as s', 'b.service_id', 's.id')
      .leftJoin('payments as pay', 'b.id', 'pay.booking_id')
      .where('b.id', req.params.id)
      .select('b.*', 'c.full_name as customer_name', 'c.phone as customer_phone',
              'p.full_name as provider_name', 'p.phone as provider_phone',
              's.title as service_title', 'pay.method as payment_method',
              'pay.transaction_id', 'pay.confirmed_at as paid_at')
      .first();

    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });
    if (booking.customer_id !== req.user.id && booking.provider_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Huna ruhusa.' });
    }

    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
};

// PUT /bookings/:id/accept
exports.accept = async (req, res, next) => {
  try {
    const booking = await db('bookings').where({ id: req.params.id, provider_id: req.user.id, status: 'pending' }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani au tayari imeshughulikiwa.' });

    await db('bookings').where({ id: booking.id }).update({ status: 'accepted', updated_at: new Date() });
    const io = req.app.get('io');
    const provider = await db('users').where({ id: req.user.id }).first();
    await sendBookingNotif(io, booking.customer_id, 'accepted', booking, { providerName: provider.full_name });

    res.json({ success: true, message: 'Booking imekubaliwa!' });
  } catch (err) { next(err); }
};

// PUT /bookings/:id/reject
exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const booking = await db('bookings').where({ id: req.params.id, provider_id: req.user.id, status: 'pending' }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });

    await db('bookings').where({ id: booking.id }).update({ status: 'rejected', notes: reason || booking.notes, updated_at: new Date() });
    const io = req.app.get('io');
    const provider = await db('users').where({ id: req.user.id }).first();
    await sendBookingNotif(io, booking.customer_id, 'rejected', booking, { providerName: provider.full_name });

    res.json({ success: true, message: 'Booking imekataliwa.' });
  } catch (err) { next(err); }
};

// PUT /bookings/:id/start
exports.start = async (req, res, next) => {
  try {
    const booking = await db('bookings').where({ id: req.params.id, provider_id: req.user.id, status: 'accepted' }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani au haijakubaliwa bado.' });

    await db('bookings').where({ id: booking.id }).update({ status: 'in_progress', updated_at: new Date() });
    const io = req.app.get('io');
    const provider = await db('users').where({ id: req.user.id }).first();
    await sendBookingNotif(io, booking.customer_id, 'started', booking, { providerName: provider.full_name });

    res.json({ success: true, message: 'Huduma imeanza!' });
  } catch (err) { next(err); }
};

// PUT /bookings/:id/complete
exports.complete = async (req, res, next) => {
  try {
    const booking = await db('bookings').where({ id: req.params.id, provider_id: req.user.id, status: 'in_progress' }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });

    await db('bookings').where({ id: booking.id }).update({
      status: 'completed', completed_at: new Date(), updated_at: new Date()
    });

    const io = req.app.get('io');
    await sendBookingNotif(io, booking.customer_id, 'completed', booking, {});

    res.json({ success: true, message: 'Huduma imekamilika! Mteja anaweza kulipa na kutoa tathmini.' });
  } catch (err) { next(err); }
};

// PUT /bookings/:id/cancel
exports.cancel = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const booking = await db('bookings').where({ id: req.params.id })
      .whereIn('status', ['pending', 'accepted']).first();

    if (!booking) return res.status(404).json({ success: false, message: 'Booking haiwezi kufutwa.' });
    if (booking.customer_id !== req.user.id && booking.provider_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Huna ruhusa.' });
    }

    await db('bookings').where({ id: booking.id }).update({ status: 'cancelled', notes: reason || booking.notes, updated_at: new Date() });

    const io = req.app.get('io');
    const notifyUserId = req.user.id === booking.customer_id ? booking.provider_id : booking.customer_id;
    await sendBookingNotif(io, notifyUserId, 'cancelled', booking, {});

    res.json({ success: true, message: 'Booking imefutwa.' });
  } catch (err) { next(err); }
};

// POST /bookings/:id/dispute
exports.dispute = async (req, res, next) => {
  try {
    const { description, reason = 'other' } = req.body;
    if (!description) return res.status(400).json({ success: false, message: 'Elezea tatizo lako.' });

    const booking = await db('bookings').where({ id: req.params.id }).first();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking haipatikani.' });
    if (booking.customer_id !== req.user.id && booking.provider_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Huna ruhusa.' });
    }

    const reportedId = req.user.id === booking.customer_id ? booking.provider_id : booking.customer_id;
    await db('reports').insert({
      id: uuidv4(),
      reporter_id:  req.user.id,
      reported_id:  reportedId,
      booking_id:   booking.id,
      reason,
      description,
      status:       'open',
      created_at:   new Date()
    });

    await db('bookings').where({ id: booking.id }).update({ status: 'disputed', updated_at: new Date() });

    res.status(201).json({ success: true, message: 'Malalamiko yamewasilishwa. Admin atashughulikia hivi karibuni.' });
  } catch (err) { next(err); }
};

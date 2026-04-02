// ══════════════════════════════════════════════════════════
// SELCOM PAYMENT — INTEGRATION KAMILI
// File: src/services/selcomService.js
// Docs: https://developer.selcommobile.com
// ══════════════════════════════════════════════════════════
const axios  = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db     = require('../utils/db');
const logger = require('../utils/logger');
const push   = require('./pushService');
const sms    = require('./smsService');

const BASE    = process.env.SELCOM_BASE_URL || 'https://apigw.selcommobile.com/v1';
const KEY     = process.env.SELCOM_API_KEY;
const SECRET  = process.env.SELCOM_API_SECRET;
const VENDOR  = process.env.SELCOM_VENDOR;

// ── HMAC-SHA256 Auth Headers ──────────────────────────────
const buildHeaders = (body = '') => {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign  = crypto.createHmac('sha256', SECRET)
    .update(KEY + nonce + ts + (body || '')).digest('base64');
  return {
    'Content-Type':  'application/json',
    'Authorization': `SELCOM ${KEY}`,
    'Digest-Method': 'HS256',
    'Digest':        sign,
    'Timestamp':     ts,
    'Nonce':         nonce,
    'Cache-Control': 'no-cache',
  };
};

// ── Operator mapping ──────────────────────────────────────
const OPERATOR_MAP = {
  mpesa:    'VODACOM',
  tigopesa: 'TIGO',
  airtel:   'AIRTEL',
  halopesa: 'HALOTEL',
};

// ══════════════════════════════════════════════════════════
//  1. CREATE CHECKOUT ORDER (STK Push)
// ══════════════════════════════════════════════════════════
const createOrder = async ({ bookingId, customerId, phone, amount, method = 'mpesa', customerName = 'Kazoo Customer' }) => {
  const paymentId = uuidv4();
  const orderRef  = `KZ-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  // Save pending record
  await db('payments').insert({
    id: paymentId, booking_id: bookingId, payer_id: customerId,
    method, phone_number: phone, amount: Math.round(amount),
    currency: 'TZS', provider_ref: orderRef,
    status: 'pending', initiated_at: new Date()
  });

  const payload = {
    vendor:          VENDOR,
    order_id:        orderRef,
    buyer_email:     '',
    buyer_name:      customerName,
    buyer_phone:     phone.replace('+', '').replace(/\s/g, ''),
    amount:          Math.round(amount),
    currency:        'TZS',
    product_id:      'KAZOO_BOOKING',
    product_name:    'Huduma ya Kazoo',
    payment_methods: OPERATOR_MAP[method] || 'VODACOM',
    redirect_url:    `${process.env.FRONTEND_URL}/payment/success`,
    cancel_url:      `${process.env.FRONTEND_URL}/payment/cancel`,
    webhook:         `${process.env.API_URL}/api/v1/payments/webhook/selcom`,
    // For mobile apps — request push callback instead of redirect
    no_redirect:     '1',
  };

  const body = JSON.stringify(payload);
  try {
    const { data } = await axios.post(`${BASE}/checkout/create-order`, body, { headers: buildHeaders(body) });
    if (data.result === '000') {
      logger.info(`[Selcom] Order created: ${orderRef} | ${phone} | TZS ${amount}`);
      return { success: true, paymentId, orderRef, checkoutUrl: data.data?.checkout_url };
    }
    throw new Error(`Selcom error: ${data.message || JSON.stringify(data)}`);
  } catch (err) {
    await db('payments').where({ id: paymentId }).update({ status: 'failed' });
    logger.error('[Selcom] Create order failed:', err.message);
    throw err;
  }
};

// ══════════════════════════════════════════════════════════
//  2. QUERY ORDER STATUS
// ══════════════════════════════════════════════════════════
const queryOrder = async (orderRef) => {
  const params = new URLSearchParams({ vendor: VENDOR, order_id: orderRef }).toString();
  const { data } = await axios.get(`${BASE}/checkout/order-status?${params}`, { headers: buildHeaders() });
  return data;
};

// ══════════════════════════════════════════════════════════
//  3. WEBHOOK HANDLER
// ══════════════════════════════════════════════════════════
const handleWebhook = async (req, res) => {
  try {
    // 1. Verify signature
    const sig  = req.headers['x-selcom-hmac-sha256'] || req.headers['x-webhook-signature'] || '';
    const body = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
      .update(body).digest('base64');

    if (sig && sig !== expected) {
      logger.warn('[Selcom Webhook] Invalid signature — possible fraud');
      return res.status(401).json({ result: 'FAIL', message: 'Invalid signature' });
    }

    const { order_id, resultcode, resultdesc, transid, msisdn, channel } = req.body;
    logger.info(`[Selcom Webhook] ${order_id} — code: ${resultcode} — transid: ${transid}`);

    const payment = await db('payments').where({ provider_ref: order_id }).first();
    if (!payment) {
      logger.warn(`[Selcom Webhook] Unknown order: ${order_id}`);
      return res.json({ result: 'SUCCESS' }); // ACK even for unknown
    }

    // Idempotency — ignore if already processed
    if (payment.status !== 'pending') {
      logger.info(`[Selcom Webhook] Already processed: ${order_id}`);
      return res.json({ result: 'SUCCESS' });
    }

    if (resultcode === '000') {
      await _processSuccess(payment, transid, msisdn, channel, req.body);
    } else {
      await db('payments').where({ id: payment.id }).update({
        status: 'failed', metadata: JSON.stringify(req.body), updated_at: new Date()
      });
      logger.info(`[Selcom Webhook] Payment FAILED: ${order_id} — ${resultdesc}`);
      // Notify customer of failure
      const payer = await db('users').where({ id: payment.payer_id }).first();
      if (payer?.fcm_token) {
        push.send(payer.fcm_token, '❌ Malipo Yalishindwa', `Tafadhali jaribu tena. ${resultdesc || ''}`);
      }
    }

    res.json({ result: 'SUCCESS' });
  } catch (err) {
    logger.error('[Selcom Webhook] Error:', err.message, err.stack);
    res.status(500).json({ result: 'FAIL' });
  }
};

const _processSuccess = async (payment, transid, msisdn, channel, rawBody) => {
  await db.transaction(async trx => {
    // 1. Update payment
    await trx('payments').where({ id: payment.id }).update({
      status: 'success', transaction_id: transid,
      confirmed_at: new Date(), metadata: JSON.stringify(rawBody), updated_at: new Date()
    });

    // 2. Update booking
    await trx('bookings').where({ id: payment.booking_id }).update({
      payment_status: 'paid', can_rate: true, updated_at: new Date()
    });

    // 3. Log commission
    const booking = await trx('bookings').where({ id: payment.booking_id }).first();
    if (booking) {
      await trx('commission_logs').insert({
        id: uuidv4(),
        booking_id:        payment.booking_id,
        provider_id:       booking.provider_id,
        gross_amount:      payment.amount,
        commission_rate:   15.00,
        commission_amount: (payment.amount * 0.15).toFixed(2),
        provider_payout:   (payment.amount * 0.85).toFixed(2),
        created_at:        new Date()
      });
    }
  });

  // 4. Notify all parties
  const booking = await db('bookings as b')
    .join('users as c', 'b.customer_id', 'c.id')
    .join('users as p', 'b.provider_id', 'p.id')
    .join('services as s', 'b.service_id', 's.id')
    .where('b.id', payment.booking_id)
    .select('b.*','c.full_name as cn','c.phone as cp','c.fcm_token as ct','c.lang as cl',
            'p.full_name as pn','p.phone as pp','p.fcm_token as pt','s.title as st')
    .first();

  if (!booking) return;

  // Customer notifications
  push.send(booking.ct, '✅ Malipo Yamefanikiwa!',
    `Tshs ${Math.round(payment.amount).toLocaleString()} yamepokelewa. Ref: ${transid}`);
  sms.sendPaymentSuccess(booking.cp, payment.amount, transid, booking.cl);

  // Provider notifications
  push.send(booking.pt, '💰 Umepokea Malipo!',
    `${booking.cn} amelipa Tshs ${Math.round(payment.amount * 0.85).toLocaleString()} kwa ${booking.st}`);

  logger.info(`[Selcom] Payment SUCCESS: ${payment.provider_ref} | TZS ${payment.amount} | ${transid}`);
};

// ══════════════════════════════════════════════════════════
//  4. REFUND
// ══════════════════════════════════════════════════════════
const refund = async ({ bookingId, reason, adminId }) => {
  const payment = await db('payments').where({ booking_id: bookingId, status: 'success' }).first();
  if (!payment) throw new Error('Malipo halisi haipatikani kwa booking hii.');

  // TODO: Call Selcom refund API when available in your region
  // For now — mark as refunded and update booking
  await db.transaction(async trx => {
    await trx('payments').where({ id: payment.id }).update({ status: 'refunded', updated_at: new Date() });
    await trx('bookings').where({ id: bookingId }).update({ payment_status: 'refunded', can_rate: false, updated_at: new Date() });
    await trx('admin_actions').insert({
      id: uuidv4(), admin_id: adminId, target_id: bookingId,
      action: 'refund', reason: reason || 'Admin refund', created_at: new Date()
    });
  });

  // Notify customer
  const booking = await db('bookings as b').join('users as c','b.customer_id','c.id').where('b.id', bookingId).select('c.fcm_token','c.phone','c.lang','c.full_name').first();
  if (booking?.fcm_token) push.send(booking.fcm_token, '↩️ Pesa Imerudishwa', `Tshs ${Math.round(payment.amount).toLocaleString()} imerudishwa kwa ${payment.phone_number}`);

  return { success: true, message: `Pesa ya Tshs ${Math.round(payment.amount).toLocaleString()} imerudishwa.` };
};

// ══════════════════════════════════════════════════════════
//  5. TEST SCRIPT (run: node test-payment.js)
// ══════════════════════════════════════════════════════════
/*
const testPayment = async () => {
  require('dotenv').config();
  const result = await createOrder({
    bookingId:    'test-booking-id',
    customerId:   'test-user-id',
    phone:        '+255712345678',
    amount:       1000, // TZS 1,000 for testing
    method:       'mpesa',
    customerName: 'Test User',
  });
  console.log('Result:', JSON.stringify(result, null, 2));
};
testPayment().catch(console.error);
*/

module.exports = { createOrder, queryOrder, handleWebhook, refund };

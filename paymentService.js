const axios  = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db     = require('../utils/db');
const push   = require('./pushService');
const logger = require('../utils/logger');

const SELCOM_BASE = process.env.SELCOM_BASE_URL || 'https://apigw.selcommobile.com/v1';
const VENDOR      = process.env.SELCOM_VENDOR;
const API_KEY     = process.env.SELCOM_API_KEY;
const API_SECRET  = process.env.SELCOM_API_SECRET;

// ── Generate Selcom Auth Header ────────────────────────────
const selcomHeaders = (payload = '') => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = uuidv4().replace(/-/g, '');
  const signStr   = API_KEY + nonce + timestamp + payload;
  const signature = crypto.createHmac('sha256', API_SECRET).update(signStr).digest('base64');
  return {
    'Content-Type': 'application/json',
    'Authorization': `SELCOM ${API_KEY}`,
    'Digest-Method': 'HS256',
    'Digest': signature,
    'Timestamp': timestamp,
    'Nonce': nonce,
    'Cache-Control': 'no-cache'
  };
};

// ── Initiate Payment (STK Push) ────────────────────────────
exports.initiate = async ({ bookingId, phone, amount, customerId, method = 'mpesa' }) => {
  const paymentId  = uuidv4();
  const orderRef   = `KZ-PAY-${Date.now()}`;

  // Save pending payment record
  await db('payments').insert({
    id: paymentId, booking_id: bookingId, payer_id: customerId,
    method, phone_number: phone, amount, currency: 'TZS',
    provider_ref: orderRef, status: 'pending',
    initiated_at: new Date()
  });

  try {
    const payload = JSON.stringify({
      vendor:      VENDOR,
      pin:         process.env.SELCOM_PIN || '',
      buyer_email: '',
      buyer_name:  'Kazoo Customer',
      buyer_phone: phone.replace('+', ''),
      amount:      Math.round(amount),
      currency:    'TZS',
      order_id:    orderRef,
      product_id:  'BOOKING',
      payment_methods: method === 'mpesa' ? 'M-PESA' : method.toUpperCase(),
      redirect_url: `${process.env.FRONTEND_URL}/payment/callback`,
      cancel_url:   `${process.env.FRONTEND_URL}/payment/cancel`,
      webhook:      `${process.env.API_URL || 'https://api.kazoo.co.tz'}/api/v1/payments/webhook/selcom`
    });

    const response = await axios.post(
      `${SELCOM_BASE}/checkout/create-order`,
      payload,
      { headers: selcomHeaders(payload) }
    );

    if (response.data?.result === '000') {
      logger.info(`Payment initiated: ${orderRef} — ${phone} — Tshs ${amount}`);
      return {
        success: true,
        paymentId,
        orderRef,
        gatewayUrl: response.data.data?.gateway_url || null,
        message: 'Ombi la malipo limetumwa. Angalia simu yako.'
      };
    } else {
      await db('payments').where({ id: paymentId }).update({ status: 'failed' });
      throw new Error(response.data?.message || 'Selcom ilikataa ombi.');
    }
  } catch (err) {
    await db('payments').where({ id: paymentId }).update({ status: 'failed' });
    logger.error('Payment initiation error:', err.message);
    throw err;
  }
};

// ── Handle Selcom Webhook ──────────────────────────────────
exports.handleSelcomWebhook = async (req, res) => {
  try {
    // Verify HMAC signature
    const receivedSig = req.headers['x-selcom-signature'] || '';
    const body        = JSON.stringify(req.body);
    const expectedSig = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
      .update(body).digest('base64');

    if (receivedSig !== expectedSig) {
      logger.warn('Webhook signature mismatch — possible fraud attempt');
      return res.status(401).json({ result: 'FAIL', message: 'Invalid signature' });
    }

    const { order_id, resultcode, resultdesc, transid } = req.body;
    const payment = await db('payments').where({ provider_ref: order_id }).first();
    if (!payment) {
      logger.warn('Webhook for unknown payment:', order_id);
      return res.json({ result: 'SUCCESS' }); // ACK to prevent retries
    }

    if (resultcode === '000') {
      // Payment successful
      await db.transaction(async trx => {
        await trx('payments').where({ id: payment.id }).update({
          status: 'success', transaction_id: transid,
          confirmed_at: new Date(), metadata: JSON.stringify(req.body)
        });
        await trx('bookings').where({ id: payment.booking_id }).update({
          payment_status: 'paid', can_rate: true,
          status: 'completed', updated_at: new Date()
        });
      });

      // Notify both parties
      const booking = await db('bookings as b')
        .join('users as c', 'b.customer_id', 'c.id')
        .join('users as p', 'b.provider_id', 'p.id')
        .where('b.id', payment.booking_id)
        .select('b.*', 'c.full_name as customer_name', 'c.fcm_token as customer_token',
                'p.full_name as provider_name', 'p.fcm_token as provider_token')
        .first();

      if (booking) {
        if (booking.customer_token) {
          push.send(booking.customer_token, '✅ Malipo Yamefanikiwa',
            `Tshs ${payment.amount.toLocaleString()} yamepokelewa. Ref: ${transid}`);
        }
        if (booking.provider_token) {
          push.send(booking.provider_token, '💰 Malipo Yamepokelewa',
            `${booking.customer_name} amelipa kwa huduma yako.`);
        }
      }

      logger.info(`Payment SUCCESS: ${order_id} — transid: ${transid}`);
    } else {
      // Payment failed
      await db('payments').where({ id: payment.id }).update({
        status: 'failed', metadata: JSON.stringify(req.body)
      });
      logger.info(`Payment FAILED: ${order_id} — ${resultdesc}`);
    }

    res.json({ result: 'SUCCESS' });
  } catch (err) {
    logger.error('Webhook handler error:', err);
    res.status(500).json({ result: 'FAIL' });
  }
};

// ── Check Payment Status ───────────────────────────────────
exports.checkStatus = async (paymentId) => {
  const payment = await db('payments').where({ id: paymentId }).first();
  if (!payment) throw new Error('Malipo haipatikani.');
  return payment;
};

// ── Process Refund ─────────────────────────────────────────
exports.refund = async ({ bookingId, reason, adminId }) => {
  const payment = await db('payments').where({ booking_id: bookingId, status: 'success' }).first();
  if (!payment) throw new Error('Malipo halisi haipatikani kwa booking hii.');

  // In production: call Selcom refund API here
  // For now: mark as refunded
  await db.transaction(async trx => {
    await trx('payments').where({ id: payment.id }).update({ status: 'refunded' });
    await trx('bookings').where({ id: bookingId }).update({ payment_status: 'refunded', can_rate: false });
    await trx('admin_actions').insert({
      id: uuidv4(), admin_id: adminId,
      target_id: bookingId, action: 'refund',
      reason, created_at: new Date()
    });
  });

  logger.info(`Refund processed for booking ${bookingId} by admin ${adminId}`);
  return { success: true, message: 'Pesa imerudishwa.' };
};

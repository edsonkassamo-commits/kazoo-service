const AfricasTalking = require('africastalking');
const logger = require('../utils/logger');

let client;
try {
  const at = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
  client = at.SMS;
} catch (err) {
  logger.warn('Africa\'s Talking SDK not initialized:', err.message);
}

const TEMPLATES = {
  sw: {
    otp_verify:  (code) => `Kazoo OTP: ${code}\nThibitisha simu yako. Inakwisha dakika 10.\nUsishiriki nambari hii na mtu yeyote.`,
    otp_reset:   (code) => `Kazoo: Nambari yako ya kubadilisha nywila ni ${code}.\nInakwisha dakika 10. Usishiriki.`,
    booking_new: (ref, service) => `Kazoo: Booking mpya! ${service} — Ref: ${ref}. Ingia kwenye app kukubali au kukataa.`,
    booking_conf:(ref) => `Kazoo: Booking ${ref} imekubaliwa! Mtoa huduma atakuja wakati uliopangwa.`,
    payment_ok:  (amount, ref) => `Kazoo: Malipo ya Tshs ${amount} yamefanikiwa. Ref: ${ref}. Asante!`,
  },
  en: {
    otp_verify:  (code) => `Kazoo OTP: ${code}\nVerify your phone. Expires in 10 minutes.\nDo not share this code.`,
    otp_reset:   (code) => `Kazoo: Your password reset code is ${code}. Expires in 10 min.`,
    booking_new: (ref, service) => `Kazoo: New booking! ${service} — Ref: ${ref}. Open app to accept.`,
    booking_conf:(ref) => `Kazoo: Booking ${ref} confirmed! Provider will arrive as scheduled.`,
    payment_ok:  (amount, ref) => `Kazoo: Payment of TZS ${amount} successful. Ref: ${ref}. Thank you!`,
  }
};

const getTemplate = (lang, type, ...args) => {
  const templates = TEMPLATES[lang] || TEMPLATES.sw;
  const fn = templates[type];
  return fn ? fn(...args) : TEMPLATES.sw[type]?.(...args) || 'Taarifa kutoka Kazoo.';
};

exports.sendOtp = async (phone, code, lang = 'sw', type = 'verify') => {
  const templateKey = type === 'reset' ? 'otp_reset' : 'otp_verify';
  const message = getTemplate(lang, templateKey, code);
  return exports.send(phone, message);
};

exports.sendBookingNotif = async (phone, ref, service, lang = 'sw', type = 'new') => {
  const key = type === 'confirmed' ? 'booking_conf' : 'booking_new';
  const message = getTemplate(lang, key, ref, service);
  return exports.send(phone, message);
};

exports.sendPaymentSuccess = async (phone, amount, ref, lang = 'sw') => {
  const message = getTemplate(lang, 'payment_ok', amount.toLocaleString(), ref);
  return exports.send(phone, message);
};

exports.send = async (phone, message) => {
  if (process.env.NODE_ENV !== 'production') {
    logger.info(`[SMS MOCK] To: ${phone} | Msg: ${message}`);
    return { success: true, mock: true };
  }
  try {
    const result = await client.send({
      to:      [phone],
      message,
      from:    process.env.AT_SENDER_ID || 'KAZOO'
    });
    logger.info(`SMS sent to ${phone}:`, result);
    return { success: true, result };
  } catch (err) {
    logger.error(`SMS failed to ${phone}:`, err.message);
    return { success: false, error: err.message };
  }
};

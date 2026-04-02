const logger = require('../utils/logger');

let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      })
    });
  }
} catch (err) {
  logger.warn('Firebase not initialized:', err.message);
}

// Send to single device
exports.send = async (fcmToken, title, body, data = {}) => {
  if (!admin || !fcmToken) return;
  if (process.env.NODE_ENV !== 'production') {
    logger.info(`[PUSH MOCK] To: ${fcmToken.substring(0,20)}... | ${title}: ${body}`);
    return;
  }
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'default', channelId: 'kazoo_main' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } }
    });
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      logger.warn('Stale FCM token — should remove from DB:', fcmToken.substring(0,20));
    } else {
      logger.error('Push notification failed:', err.message);
    }
  }
};

// Send to multiple devices
exports.sendMulti = async (tokens, title, body, data = {}) => {
  if (!admin || !tokens?.length) return;
  const validTokens = tokens.filter(Boolean);
  if (!validTokens.length) return;
  try {
    const result = await admin.messaging().sendEachForMulticast({
      tokens: validTokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    });
    logger.info(`Push multicast: ${result.successCount} ok, ${result.failureCount} failed`);
  } catch (err) {
    logger.error('Push multicast failed:', err.message);
  }
};

// Send to a topic (e.g., all providers in Dar es Salaam)
exports.sendToTopic = async (topic, title, body, data = {}) => {
  if (!admin) return;
  try {
    await admin.messaging().send({
      topic,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    });
  } catch (err) {
    logger.error(`Push topic ${topic} failed:`, err.message);
  }
};

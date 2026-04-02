const { createClient } = require('redis');
const logger = require('./logger');

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => logger.error('Redis error:', err));
redis.connect().catch(err => logger.warn('Redis connect failed:', err.message));

module.exports = redis;

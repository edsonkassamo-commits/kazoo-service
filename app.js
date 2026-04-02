require('dotenv').config();
const express    = require('express');
const http       = require('http');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const compression= require('compression');
const rateLimit  = require('express-rate-limit');
const { Server } = require('socket.io');

const db         = require('./utils/db');
const redis      = require('./utils/redis');
const logger     = require('./utils/logger');
const { initSockets } = require('./sockets');
const errorHandler   = require('./middleware/errorHandler');

// ── Routes ────────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const providerRoutes    = require('./routes/providers');
const serviceRoutes     = require('./routes/services');
const bookingRoutes     = require('./routes/bookings');
const paymentRoutes     = require('./routes/payments');
const reviewRoutes      = require('./routes/reviews');
const reportRoutes      = require('./routes/reports');
const chatRoutes        = require('./routes/chat');
const notifRoutes       = require('./routes/notifications');
const adminRoutes       = require('./routes/admin');
const analyticsRoutes   = require('./routes/analytics');

const app  = express();
const httpServer = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: [process.env.FRONTEND_URL, process.env.ADMIN_URL], methods: ['GET','POST'] }
});
app.set('io', io);
initSockets(io);

// ── Global Middleware ─────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(cors({
  origin: [process.env.FRONTEND_URL, process.env.ADMIN_URL],
  credentials: true
}));

// Rate limiting — global
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Maombi mengi sana. Jaribu baadaye.' }
}));

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { success: false, message: 'Majaribio mengi sana ya kuingia. Jaribu baada ya dakika 15.' }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Health Check ──────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({
      status: 'OK',
      service: 'Kazoo API',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      db: 'connected',
      env: process.env.NODE_ENV
    });
  } catch (err) {
    res.status(503).json({ status: 'ERROR', db: 'disconnected' });
  }
});

// ── API Routes ────────────────────────────────────────────
const v1 = '/api/v1';
app.use(`${v1}/auth`,          authLimiter, authRoutes);
app.use(`${v1}/users`,         userRoutes);
app.use(`${v1}/providers`,     providerRoutes);
app.use(`${v1}/services`,      serviceRoutes);
app.use(`${v1}/bookings`,      bookingRoutes);
app.use(`${v1}/payments`,      paymentRoutes);
app.use(`${v1}/reviews`,       reviewRoutes);
app.use(`${v1}/reports`,       reportRoutes);
app.use(`${v1}/chat`,          chatRoutes);
app.use(`${v1}/notifications`, notifRoutes);
app.use(`${v1}/admin`,         adminRoutes);
app.use(`${v1}/analytics`,     analyticsRoutes);

// ── 404 Handler ───────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} haipatikani.` });
});

// ── Global Error Handler ──────────────────────────────────
app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  logger.info(`🚀 Kazoo API imeanza kwenye port ${PORT} [${process.env.NODE_ENV}]`);
  try {
    await db.raw('SELECT 1');
    logger.info('✅ Database imeungana vizuri');
  } catch (err) {
    logger.error('❌ Database haikuungana:', err.message);
    process.exit(1);
  }
  try {
    await redis.ping();
    logger.info('✅ Redis imeungana vizuri');
  } catch (err) {
    logger.warn('⚠️  Redis haikuungana — caching haitafanya kazi:', err.message);
  }
});

module.exports = { app, httpServer };

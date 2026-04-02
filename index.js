const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db  = require('../utils/db');
const logger = require('../utils/logger');

const onlineUsers = new Map(); // userId → socketId

const initSockets = (io) => {
  // ── Auth middleware for Socket.io ──────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Token inahitajika.'));
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      const user = await db('users').where({ id: decoded.userId }).first();
      if (!user || user.status !== 'active') return next(new Error('Akaunti si halali.'));
      socket.userId = user.id;
      socket.user   = user;
      next();
    } catch (err) {
      next(new Error('Token si sahihi.'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    onlineUsers.set(userId, socket.id);
    socket.join(`user:${userId}`); // personal room

    logger.debug(`User connected: ${userId}`);

    // ── Join Conversation ───────────────────────────────
    socket.on('join_conversation', async ({ conversation_id }) => {
      try {
        const convo = await db('conversations').where({ id: conversation_id }).first();
        if (!convo) return;
        const participants = convo.participant_ids || [];
        if (!participants.includes(userId)) return; // security check
        socket.join(`conv:${conversation_id}`);
      } catch (err) { logger.error('join_conversation error:', err.message); }
    });

    // ── Send Message ────────────────────────────────────
    socket.on('send_message', async ({ conversation_id, content, type = 'text' }) => {
      try {
        if (!content?.trim()) return;

        const convo = await db('conversations').where({ id: conversation_id }).first();
        if (!convo || !convo.participant_ids.includes(userId)) return;

        const msgId = uuidv4();
        const msg = {
          id: msgId,
          conversation_id,
          sender_id: userId,
          content: content.trim(),
          type, // text | image | location
          read: false,
          created_at: new Date()
        };

        await db('messages').insert(msg);
        await db('conversations').where({ id: conversation_id }).update({
          last_message_id: msgId,
          updated_at: new Date()
        });

        // Enrich with sender info
        const enriched = {
          ...msg,
          sender_name:   socket.user.full_name,
          sender_avatar: socket.user.avatar_url
        };

        // Broadcast to conversation room
        io.to(`conv:${conversation_id}`).emit('new_message', enriched);

        // Notify offline users
        const otherParticipants = convo.participant_ids.filter(id => id !== userId);
        for (const participantId of otherParticipants) {
          if (!onlineUsers.has(participantId)) {
            // They are offline — push notification
            const participant = await db('users').where({ id: participantId }).select('fcm_token').first();
            if (participant?.fcm_token) {
              const push = require('../services/pushService');
              push.send(participant.fcm_token, `💬 ${socket.user.full_name}`, content.substring(0, 100));
            }
          }
        }
      } catch (err) { logger.error('send_message error:', err.message); }
    });

    // ── Typing Indicator ────────────────────────────────
    socket.on('typing', ({ conversation_id, is_typing }) => {
      socket.to(`conv:${conversation_id}`).emit('typing', {
        user_id: userId,
        name: socket.user.full_name,
        is_typing
      });
    });

    // ── Mark Messages as Read ───────────────────────────
    socket.on('mark_read', async ({ conversation_id }) => {
      try {
        await db('messages')
          .where({ conversation_id })
          .whereNot({ sender_id: userId })
          .where({ read: false })
          .update({ read: true, read_at: new Date() });
        socket.to(`conv:${conversation_id}`).emit('messages_read', { conversation_id, reader_id: userId });
      } catch (err) { logger.error('mark_read error:', err.message); }
    });

    // ── Provider Location Update ────────────────────────
    socket.on('update_location', async ({ lat, lng }) => {
      try {
        if (socket.user.account_type !== 'provider') return;
        await db('users').where({ id: userId }).update({
          location_lat: lat, location_lng: lng, updated_at: new Date()
        });
        // Broadcast to any customers tracking this provider
        io.to(`tracking:${userId}`).emit('provider_location', { provider_id: userId, lat, lng });
      } catch (err) { logger.error('update_location error:', err.message); }
    });

    // ── Track Provider (Customer following provider en route) ─
    socket.on('track_provider', ({ provider_id }) => {
      socket.join(`tracking:${provider_id}`);
    });

    // ── Disconnect ──────────────────────────────────────
    socket.on('disconnect', async () => {
      onlineUsers.delete(userId);
      logger.debug(`User disconnected: ${userId}`);
      // Update last seen
      await db('users').where({ id: userId }).update({ last_seen_at: new Date() }).catch(() => {});
    });
  });
};

// Check if a user is online
const isOnline = (userId) => onlineUsers.has(userId);

module.exports = { initSockets, isOnline };

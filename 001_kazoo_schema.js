// ══════════════════════════════════════════════════════════
// KAZOO — DATABASE MIGRATIONS
// Run: npx knex migrate:latest
// File: migrations/001_kazoo_schema.js
// ══════════════════════════════════════════════════════════

exports.up = async (knex) => {
  // Enable UUID and PostGIS extensions
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "postgis"');

  // ── USERS ─────────────────────────────────────────────
  await knex.schema.createTable('users', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('full_name', 100).notNullable();
    t.string('phone', 20).unique().notNullable();
    t.string('email', 255).unique();
    t.string('password_hash', 255).notNullable();
    t.enum('account_type', ['customer', 'provider', 'admin']).notNullable().defaultTo('customer');
    t.text('avatar_url');
    t.string('nin', 30).unique();
    t.boolean('nin_verified').defaultTo(false);
    t.boolean('phone_verified').defaultTo(false);
    t.enum('status', ['active', 'suspended', 'banned']).defaultTo('active');
    t.text('fcm_token');
    t.string('lang', 5).defaultTo('sw');
    t.decimal('location_lat', 10, 8);
    t.decimal('location_lng', 11, 8);
    t.timestamp('last_seen_at');
    t.timestamps(true, true);
    t.timestamp('deleted_at');
    t.index('phone');
    t.index('account_type');
    t.index('status');
  });

  // ── PROVIDER PROFILES ─────────────────────────────────
  await knex.schema.createTable('provider_profiles', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('bio');
    t.integer('experience_years');
    t.decimal('base_price', 10, 2);
    t.specificType('service_areas', 'TEXT[]');
    t.specificType('service_categories', 'TEXT[]');
    t.text('id_doc_url');
    t.string('work_permit_number', 50);
    t.boolean('is_verified').defaultTo(false);
    t.boolean('is_available').defaultTo(true);
    t.decimal('avg_rating', 3, 2).defaultTo(0);
    t.integer('total_jobs').defaultTo(0);
    t.decimal('total_earnings', 12, 2).defaultTo(0);
    t.decimal('commission_rate', 5, 2).defaultTo(15.00);
    t.timestamps(true, true);
    t.unique('user_id');
  });

  // ── SERVICES ──────────────────────────────────────────
  await knex.schema.createTable('services', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('provider_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('category', 50).notNullable();
    t.string('title', 150).notNullable();
    t.text('description');
    t.decimal('price', 10, 2).notNullable();
    t.enum('price_type', ['fixed', 'hourly', 'negotiable']).defaultTo('fixed');
    t.integer('duration_mins');
    t.specificType('images', 'TEXT[]');
    t.boolean('is_active').defaultTo(true);
    t.timestamps(true, true);
    t.index('category');
    t.index('provider_id');
    t.index('is_active');
  });

  // Add PostGIS geometry column for services
  await knex.raw(`
    ALTER TABLE services 
    ADD COLUMN IF NOT EXISTS location GEOMETRY(Point, 4326)
  `);
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_services_location ON services USING GIST(location)');

  // ── BOOKINGS ──────────────────────────────────────────
  await knex.schema.createTable('bookings', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('booking_ref', 15).unique().notNullable();
    t.uuid('customer_id').notNullable().references('id').inTable('users');
    t.uuid('provider_id').notNullable().references('id').inTable('users');
    t.uuid('service_id').notNullable().references('id').inTable('services');
    t.enum('status', ['pending','accepted','rejected','in_progress','completed','cancelled','disputed']).notNullable().defaultTo('pending');
    t.timestamp('scheduled_at').notNullable();
    t.text('address').notNullable();
    t.decimal('address_lat', 10, 8);
    t.decimal('address_lng', 11, 8);
    t.text('notes');
    t.decimal('total_amount', 10, 2).notNullable();
    t.decimal('platform_fee', 10, 2);
    t.decimal('provider_amount', 10, 2);
    t.enum('payment_status', ['unpaid','paid','refunded']).defaultTo('unpaid');
    t.boolean('can_rate').defaultTo(false);
    t.timestamp('rated_at');
    t.timestamp('completed_at');
    t.timestamps(true, true);
    t.index('customer_id');
    t.index('provider_id');
    t.index('status');
    t.index('payment_status');
  });

  // ── PAYMENTS ──────────────────────────────────────────
  await knex.schema.createTable('payments', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('booking_id').notNullable().references('id').inTable('bookings');
    t.uuid('payer_id').notNullable().references('id').inTable('users');
    t.enum('method', ['mpesa','tigopesa','airtel','halopesa','card']).notNullable();
    t.string('phone_number', 20);
    t.decimal('amount', 10, 2).notNullable();
    t.string('currency', 5).defaultTo('TZS');
    t.string('transaction_id', 100).unique();
    t.string('provider_ref', 100);
    t.enum('status', ['pending','success','failed','refunded']).defaultTo('pending');
    t.timestamp('initiated_at');
    t.timestamp('confirmed_at');
    t.jsonb('metadata');
    t.index('booking_id');
    t.index('status');
    t.index('payer_id');
  });

  // ── OTP CODES ─────────────────────────────────────────
  await knex.schema.createTable('otp_codes', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('phone', 20).notNullable();
    t.string('code', 6).notNullable();
    t.enum('type', ['verify_phone','reset_password','login_2fa']).notNullable();
    t.timestamp('expires_at').notNullable();
    t.boolean('used').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['phone', 'type']);
  });

  // ── CONVERSATIONS ─────────────────────────────────────
  await knex.schema.createTable('conversations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.specificType('participant_ids', 'UUID[]').notNullable();
    t.uuid('booking_id').references('id').inTable('bookings');
    t.uuid('last_message_id');
    t.timestamps(true, true);
  });

  // ── MESSAGES ──────────────────────────────────────────
  await knex.schema.createTable('messages', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    t.uuid('sender_id').notNullable().references('id').inTable('users');
    t.text('content').notNullable();
    t.enum('type', ['text','image','location']).defaultTo('text');
    t.boolean('read').defaultTo(false);
    t.timestamp('read_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('conversation_id');
    t.index('sender_id');
  });

  // ── REVIEWS ───────────────────────────────────────────
  await knex.schema.createTable('reviews', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('booking_id').notNullable().references('id').inTable('bookings');
    t.uuid('reviewer_id').notNullable().references('id').inTable('users');
    t.uuid('reviewee_id').notNullable().references('id').inTable('users');
    t.integer('rating').notNullable().checkBetween([1, 5]);
    t.text('comment');
    t.boolean('is_visible').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['booking_id', 'reviewer_id']); // one review per booking per user
    t.index('reviewee_id');
  });

  // ── REPORTS ───────────────────────────────────────────
  await knex.schema.createTable('reports', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('reporter_id').notNullable().references('id').inTable('users');
    t.uuid('reported_id').notNullable().references('id').inTable('users');
    t.uuid('booking_id').references('id').inTable('bookings');
    t.enum('reason', ['fraud','abuse','no_show','poor_service','harassment','other']).notNullable();
    t.text('description').notNullable();
    t.specificType('evidence_urls', 'TEXT[]');
    t.enum('status', ['open','under_review','resolved','dismissed']).defaultTo('open');
    t.text('admin_notes');
    t.enum('action_taken', ['none','warning','suspended','banned','refunded']).defaultTo('none');
    t.uuid('resolved_by').references('id').inTable('users');
    t.timestamp('resolved_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('reported_id');
    t.index('status');
  });

  // ── NOTIFICATIONS ─────────────────────────────────────
  await knex.schema.createTable('notifications', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('title', 150).notNullable();
    t.text('body');
    t.string('type', 50);
    t.jsonb('data');
    t.boolean('read').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['user_id', 'read']);
  });

  // ── ADMIN ACTIONS LOG ─────────────────────────────────
  await knex.schema.createTable('admin_actions', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('admin_id').notNullable().references('id').inTable('users');
    t.uuid('target_id');
    t.string('action', 50).notNullable();
    t.text('reason');
    t.jsonb('metadata');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('admin_id');
    t.index('target_id');
  });

  // ── COMMISSION LOGS ───────────────────────────────────
  await knex.schema.createTable('commission_logs', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('booking_id').notNullable().references('id').inTable('bookings');
    t.uuid('provider_id').notNullable().references('id').inTable('users');
    t.decimal('gross_amount', 10, 2);
    t.decimal('commission_rate', 5, 2);
    t.decimal('commission_amount', 10, 2);
    t.decimal('provider_payout', 10, 2);
    t.timestamp('paid_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  console.log('✅ All migrations completed successfully');
};

exports.down = async (knex) => {
  // Drop in reverse order (foreign key dependencies)
  const tables = [
    'commission_logs', 'admin_actions', 'notifications',
    'reports', 'reviews', 'messages', 'conversations',
    'otp_codes', 'payments', 'bookings',
    'services', 'provider_profiles', 'users'
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};

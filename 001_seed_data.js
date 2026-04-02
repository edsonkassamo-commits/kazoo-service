const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── Admin user & sample data seed ────────────────────────
exports.seed = async (knex) => {
  // Clear existing data
  await knex('commission_logs').del();
  await knex('admin_actions').del();
  await knex('notifications').del();
  await knex('reports').del();
  await knex('reviews').del();
  await knex('messages').del();
  await knex('conversations').del();
  await knex('otp_codes').del();
  await knex('payments').del();
  await knex('bookings').del();
  await knex('services').del();
  await knex('provider_profiles').del();
  await knex('users').del();

  const hash = await bcrypt.hash('kazoo2025', 12);

  // ── Users ───────────────────────────────────────────────
  const adminId    = uuidv4();
  const provider1  = uuidv4();
  const provider2  = uuidv4();
  const customer1  = uuidv4();
  const customer2  = uuidv4();

  await knex('users').insert([
    {
      id: adminId, full_name: 'Admin Kazoo', phone: '+255700000001',
      email: 'admin@kazoo.co.tz', password_hash: hash,
      account_type: 'admin', status: 'active',
      phone_verified: true, nin_verified: true,
      nin: 'ADMIN-NIN-001', lang: 'sw',
    },
    {
      id: provider1, full_name: 'Amina Hassan', phone: '+255712345678',
      email: 'amina@example.com', password_hash: hash,
      account_type: 'provider', status: 'active',
      phone_verified: true, nin_verified: true,
      nin: 'NIN20240001TZ', lang: 'sw',
      avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=amina',
    },
    {
      id: provider2, full_name: 'John Mwangi', phone: '+255754678901',
      email: 'john@example.com', password_hash: hash,
      account_type: 'provider', status: 'active',
      phone_verified: true, nin_verified: false,
      nin: 'NIN20240002TZ', lang: 'en',
      avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=john',
    },
    {
      id: customer1, full_name: 'Fatuma Said', phone: '+255789012345',
      email: 'fatuma@example.com', password_hash: hash,
      account_type: 'customer', status: 'active',
      phone_verified: true, nin: 'NIN20240003TZ', lang: 'sw',
      avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=fatuma',
    },
    {
      id: customer2, full_name: 'David Omondi', phone: '+255723456789',
      email: 'david@example.com', password_hash: hash,
      account_type: 'customer', status: 'active',
      phone_verified: true, nin: 'NIN20240004TZ', lang: 'en',
      avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=david',
    },
  ]);

  // ── Provider Profiles ────────────────────────────────────
  await knex('provider_profiles').insert([
    {
      id: uuidv4(), user_id: provider1,
      bio: 'Fundi wa umeme na plumbing mwenye uzoefu wa miaka 8. Niko Dar es Salaam.',
      experience_years: 8, base_price: 15000,
      service_areas: ['Sinza','Kinondoni','Mikocheni','Msasani'],
      service_categories: ['Fundi','Umeme'],
      is_verified: true, is_available: true,
      avg_rating: 4.90, total_jobs: 87, total_earnings: 1305000,
      commission_rate: 12.00,
    },
    {
      id: uuidv4(), user_id: provider2,
      bio: 'Professional cleaner and home services expert based in Kariakoo.',
      experience_years: 3, base_price: 12000,
      service_areas: ['Kariakoo','Ilala','Temeke'],
      service_categories: ['Usafi'],
      is_verified: false, is_available: true,
      avg_rating: 4.70, total_jobs: 54, total_earnings: 648000,
      commission_rate: 15.00,
    },
  ]);

  // ── Services ─────────────────────────────────────────────
  const svc1 = uuidv4();
  const svc2 = uuidv4();
  const svc3 = uuidv4();

  await knex('services').insert([
    {
      id: svc1, provider_id: provider1,
      category: 'Fundi', title: 'Matengenezo ya Umeme Nyumbani',
      description: 'Ninatengeneza nyaya, plugs, switches, circuit breakers na matatizo yote ya umeme.',
      price: 25000, price_type: 'fixed', duration_mins: 120,
      images: ['https://images.unsplash.com/photo-1621905251918-48416bd8575a?w=400'],
      is_active: true,
    },
    {
      id: svc2, provider_id: provider1,
      category: 'Fundi', title: 'Matengenezo ya Mabomba (Plumbing)',
      description: 'Kutengeneza mabomba yaliyovunjika, taps, sinks na choo.',
      price: 20000, price_type: 'fixed', duration_mins: 90,
      images: ['https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=400'],
      is_active: true,
    },
    {
      id: svc3, provider_id: provider2,
      category: 'Usafi', title: 'Usafi Kamili wa Nyumba',
      description: 'Usafi wa kina wa nyumba yote — sebule, vyumba, jiko na bafuni.',
      price: 35000, price_type: 'fixed', duration_mins: 240,
      images: ['https://images.unsplash.com/photo-1527515637462-cff94aca6111?w=400'],
      is_active: true,
    },
  ]);

  // ── Sample Booking ─────────────────────────────────────
  const bookingId = uuidv4();
  await knex('bookings').insert({
    id: bookingId,
    booking_ref: 'KZ-2025-SEED01',
    customer_id: customer1,
    provider_id: provider1,
    service_id: svc1,
    status: 'completed',
    scheduled_at: new Date(Date.now() - 2 * 86400000),
    address: 'Sinza, Dar es Salaam',
    address_lat: -6.7924, address_lng: 39.2083,
    total_amount: 25000, platform_fee: 3000, provider_amount: 22000,
    payment_status: 'paid', can_rate: true,
    completed_at: new Date(Date.now() - 2 * 86400000),
  });

  await knex('payments').insert({
    id: uuidv4(), booking_id: bookingId, payer_id: customer1,
    method: 'mpesa', phone_number: '+255789012345',
    amount: 25000, currency: 'TZS',
    transaction_id: 'MP250101001234',
    provider_ref: 'KZ-PAY-SEED01',
    status: 'success', initiated_at: new Date(Date.now() - 2 * 86400000),
    confirmed_at: new Date(Date.now() - 2 * 86400000),
  });

  await knex('reviews').insert({
    id: uuidv4(), booking_id: bookingId,
    reviewer_id: customer1, reviewee_id: provider1,
    rating: 5, comment: 'Amina alifanya kazi nzuri sana! Alikuja mapema na alifanya kila kitu vizuri.',
    is_visible: true,
  });

  console.log('✅ Seed data inserted successfully');
  console.log('');
  console.log('👤 Admin:    +255700000001 / kazoo2025');
  console.log('🛠️ Provider: +255712345678 / kazoo2025 (Amina — Verified)');
  console.log('🛠️ Provider: +255754678901 / kazoo2025 (John — Not Verified)');
  console.log('👤 Customer: +255789012345 / kazoo2025 (Fatuma)');
  console.log('👤 Customer: +255723456789 / kazoo2025 (David)');
};

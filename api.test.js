// ══════════════════════════════════════════════════════════
// KAZOO — API TESTS
// Run: npm test
// ══════════════════════════════════════════════════════════
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/utils/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── Test helpers ──────────────────────────────────────────
let customerToken, providerToken, adminToken;
let testBookingId, testServiceId, testProviderId, testCustomerId;

const createTestUser = async (type = 'customer') => {
  const id = uuidv4();
  const phone = `+2557${Math.floor(10000000 + Math.random() * 89999999)}`;
  await db('users').insert({
    id, full_name: `Test ${type}`, phone,
    email: `test_${id.slice(0,8)}@kazoo.test`,
    password_hash: await bcrypt.hash('test1234', 10),
    account_type: type, nin: `NIN-TEST-${id.slice(0,8)}`,
    status: 'active', phone_verified: true,
    created_at: new Date(), updated_at: new Date()
  });
  if (type === 'provider') {
    await db('provider_profiles').insert({
      id: uuidv4(), user_id: id, is_verified: true, is_available: true,
      base_price: 20000, avg_rating: 4.5, total_jobs: 10,
      commission_rate: 15.00, created_at: new Date(), updated_at: new Date()
    });
  }
  return { id, phone };
};

const login = async (phone, password = 'test1234') => {
  const res = await request(app).post('/api/v1/auth/login').send({ phone, password });
  return res.body?.data?.tokens?.access;
};

// ── Setup / Teardown ─────────────────────────────────────
beforeAll(async () => {
  // Create test users
  const admin    = await createTestUser('admin').catch(() => null);
  const provider = await createTestUser('provider');
  const customer = await createTestUser('customer');
  testProviderId = provider.id;
  testCustomerId = customer.id;

  // Fix admin type
  await db('users').where({ id: admin?.id }).update({ account_type: 'admin' }).catch(() => {});

  // Login
  customerToken = await login(customer.phone);
  providerToken = await login(provider.phone);
  adminToken    = admin ? await login(admin.phone) : null;

  // Create test service
  testServiceId = uuidv4();
  await db('services').insert({
    id: testServiceId, provider_id: testProviderId,
    category: 'Fundi', title: 'Test Service', price: 20000,
    price_type: 'fixed', is_active: true,
    created_at: new Date(), updated_at: new Date()
  });
});

afterAll(async () => {
  // Cleanup test data
  await db('reviews').where('reviewer_id', testCustomerId).del().catch(() => {});
  await db('payments').where('payer_id', testCustomerId).del().catch(() => {});
  await db('bookings').where('customer_id', testCustomerId).del().catch(() => {});
  await db('services').where('id', testServiceId).del().catch(() => {});
  await db('provider_profiles').where('user_id', testProviderId).del().catch(() => {});
  await db('users').whereIn('id', [testCustomerId, testProviderId]).del().catch(() => {});
  await db.destroy();
});

// ══════════════════════════════════════════════════════════
// AUTH TESTS
// ══════════════════════════════════════════════════════════
describe('🔐 AUTH', () => {
  const testPhone = `+25571${Math.floor(1000000 + Math.random() * 8999999)}`;

  test('POST /auth/register — inasajili customer mpya', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      full_name: 'Test User Mpya', phone: testPhone, password: 'test1234',
      account_type: 'customer', nin: `NIN-NEW-${Date.now()}`, lang: 'sw'
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('tokens');
    expect(res.body.data.tokens).toHaveProperty('access');
    expect(res.body.data.tokens).toHaveProperty('refresh');
  });

  test('POST /auth/register — inakataa simu iliyopo tayari', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      full_name: 'Duplicate', phone: testPhone, password: 'test1234',
      account_type: 'customer', nin: `NIN-DUP-${Date.now()}`, lang: 'sw'
    });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('POST /auth/login — inaingia vizuri', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ phone: testPhone, password: 'test1234' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.access).toBeTruthy();
  });

  test('POST /auth/login — inakataa nywila mbaya', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ phone: testPhone, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('POST /auth/send-otp — inatuma OTP', async () => {
    const res = await request(app).post('/api/v1/auth/send-otp').send({ phone: testPhone });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('GET /protected — inakataa bila token', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════
// USER TESTS
// ══════════════════════════════════════════════════════════
describe('👤 USERS', () => {
  test('GET /users/me — inarejesha profaili', async () => {
    const res = await request(app).get('/api/v1/users/me')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('full_name');
    expect(res.body.data).not.toHaveProperty('password_hash');
    expect(res.body.data).not.toHaveProperty('nin');
  });

  test('PUT /users/me — inabadilisha taarifa', async () => {
    const res = await request(app).put('/api/v1/users/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ full_name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// BOOKING TESTS
// ══════════════════════════════════════════════════════════
describe('📅 BOOKINGS', () => {
  test('POST /bookings — inaweka booking mpya', async () => {
    const res = await request(app).post('/api/v1/bookings')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        service_id:   testServiceId,
        provider_id:  testProviderId,
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        address:      'Sinza, Dar es Salaam',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('pending');
    testBookingId = res.body.data.id;
  });

  test('GET /bookings — inarejesha orodha', async () => {
    const res = await request(app).get('/api/v1/bookings')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('GET /bookings/:id — inarejesha booking moja', async () => {
    if (!testBookingId) return;
    const res = await request(app).get(`/api/v1/bookings/${testBookingId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(testBookingId);
  });

  test('PUT /bookings/:id/accept — provider anakubali', async () => {
    if (!testBookingId) return;
    const res = await request(app).put(`/api/v1/bookings/${testBookingId}/accept`)
      .set('Authorization', `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('PUT /bookings/:id/accept — customer hawezi kukubali', async () => {
    const res = await request(app).put(`/api/v1/bookings/${testBookingId}/accept`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  test('PUT /bookings/:id/cancel — inafuta booking', async () => {
    // Create a separate booking to cancel
    const b = await request(app).post('/api/v1/bookings')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ service_id: testServiceId, provider_id: testProviderId, scheduled_at: new Date(Date.now() + 86400000).toISOString(), address: 'Test' });
    const bid = b.body.data?.id;
    if (!bid) return;
    const res = await request(app).put(`/api/v1/bookings/${bid}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`).send({ reason: 'Test cancellation' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// REVIEW TESTS
// ══════════════════════════════════════════════════════════
describe('⭐ REVIEWS', () => {
  test('POST /reviews — inakataa bila malipo', async () => {
    if (!testBookingId) return;
    const res = await request(app).post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ booking_id: testBookingId, rating: 5, comment: 'Nzuri sana!' });
    // Booking haijalipiwa, lazima ikataliwe
    expect([400, 403]).toContain(res.status);
  });

  test('POST /reviews — rating lazima iwe 1-5', async () => {
    const res = await request(app).post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ booking_id: testBookingId, rating: 6 });
    expect(res.status).toBe(400);
  });

  test('GET /reviews/provider/:id — inarejesha reviews', async () => {
    const res = await request(app).get(`/api/v1/reviews/provider/${testProviderId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// REPORT TESTS
// ══════════════════════════════════════════════════════════
describe('⚠️ REPORTS', () => {
  test('POST /reports — inawasilisha ripoti', async () => {
    const res = await request(app).post('/api/v1/reports')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        reported_id:  testProviderId,
        booking_id:   testBookingId,
        reason:       'poor_service',
        description:  'Test report - kazi haikufanywa vizuri.',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test('POST /reports — mtu hawezi kujiripoti mwenyewe', async () => {
    const res = await request(app).post('/api/v1/reports')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ reported_id: testCustomerId, reason: 'fraud', description: 'Self report test' });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════
// ADMIN TESTS
// ══════════════════════════════════════════════════════════
describe('🔒 ADMIN', () => {
  test('GET /admin/stats — admin anapata stats', async () => {
    if (!adminToken) return;
    const res = await request(app).get('/api/v1/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('total_users');
    expect(res.body.data).toHaveProperty('open_reports');
  });

  test('GET /admin/stats — customer hawezi kupata', async () => {
    const res = await request(app).get('/api/v1/admin/stats')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  test('GET /admin/users — admin anapata orodha ya watumiaji', async () => {
    if (!adminToken) return;
    const res = await request(app).get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════
describe('🏥 HEALTH', () => {
  test('GET /health — inaonyesha hali ya server', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body).toHaveProperty('db');
  });
});

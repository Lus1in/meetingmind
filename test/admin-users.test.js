/**
 * Tests for GET /api/admin/users
 *
 * Run: npx jest test/admin-users.test.js
 */

const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'test-admin-users.db');
try { fs.unlinkSync(testDbPath); } catch (e) {}

process.env.DATABASE_PATH = testDbPath;
process.env.MOCK_MODE = 'true';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-1234567';
process.env.ADMIN_EMAIL = 'admin@test.com';

const db = require('../database');

const express = require('express');
const session = require('express-session');
const adminUsersRoutes = require('../routes/admin-users');

const app = express();
app.use(express.json());
app.use(session({
  secret: 'test-secret',
  resave: false,
  saveUninitialized: false
}));

app.get('/__test_login/:userId', (req, res) => {
  req.session.userId = parseInt(req.params.userId);
  req.session.save(() => res.json({ ok: true }));
});

app.use('/api/admin/users', adminUsersRoutes);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('password123', 4);

function createUser(email) {
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

let adminUser, regularUser;
let adminAgent, userAgent, unauthAgent;

beforeAll(async () => {
  adminUser = createUser('admin@test.com');
  regularUser = createUser('user@test.com');

  // Set last_seen_at for regularUser to simulate recent activity
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(regularUser.id);

  adminAgent = request.agent(app);
  userAgent = request.agent(app);
  unauthAgent = request.agent(app);

  await adminAgent.get(`/__test_login/${adminUser.id}`).expect(200);
  await userAgent.get(`/__test_login/${regularUser.id}`).expect(200);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}
});

describe('GET /api/admin/users', () => {
  test('non-admin gets 403', async () => {
    const res = await userAgent.get('/api/admin/users');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  test('unauthenticated gets 401', async () => {
    const res = await unauthAgent.get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  test('admin gets 200 with user list', async () => {
    const res = await adminAgent.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  test('response contains correct fields only', async () => {
    const res = await adminAgent.get('/api/admin/users');
    const user = res.body.find(u => u.email === 'user@test.com');
    expect(user).toBeDefined();

    // Required fields present
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('email');
    expect(user).toHaveProperty('plan');
    expect(user).toHaveProperty('is_lifetime');
    expect(user).toHaveProperty('subscription_status');
    expect(user).toHaveProperty('created_at');
    expect(user).toHaveProperty('last_seen_at');
    expect(user).toHaveProperty('isOnline');

    // Secrets NOT present
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('stripe_customer_id');
    expect(user).not.toHaveProperty('stripe_subscription_id');
    expect(user).not.toHaveProperty('reset_token');
  });

  test('isOnline is computed correctly', async () => {
    const res = await adminAgent.get('/api/admin/users');
    const recent = res.body.find(u => u.email === 'user@test.com');
    const noActivity = res.body.find(u => u.email === 'admin@test.com');

    // regularUser had last_seen_at set to now → online
    expect(recent.isOnline).toBe(true);
    // adminUser has no last_seen_at → offline
    expect(noActivity.isOnline).toBe(false);
  });
});

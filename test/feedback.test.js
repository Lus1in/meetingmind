/**
 * Integration tests for the feedback system.
 * Tests:
 *   1. User can submit feedback (200)
 *   2. Validation errors return 400
 *   3. Non-admin cannot GET /api/feedback/admin (403)
 *   4. Admin can list feedback
 *   5. Admin can update status
 *   6. Admin can delete feedback
 *   7. Unauthenticated user is rejected
 *
 * Run: npx jest test/feedback.test.js
 */

const path = require('path');
const fs = require('fs');

// Setup env before any app requires
const testDbPath = path.join(__dirname, 'test-feedback.db');
try { fs.unlinkSync(testDbPath); } catch (e) {}

process.env.DATABASE_PATH = testDbPath;
process.env.MOCK_MODE = 'true';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-1234567';
process.env.ADMIN_EMAIL = 'admin@test.com';

// Load the real database module (will use testDbPath via DATABASE_PATH)
const db = require('../database');

const express = require('express');
const session = require('express-session');
const feedbackRoutes = require('../routes/feedback');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: 'test-secret',
  resave: false,
  saveUninitialized: false
}));

// Helper route to set session (simulates login)
app.get('/__test_login/:userId', (req, res) => {
  req.session.userId = parseInt(req.params.userId);
  req.session.save(() => {
    res.json({ ok: true });
  });
});

// Mount feedback routes
app.use('/api/feedback', feedbackRoutes);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('password123', 4);

function createUser(email) {
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

// ---- Test Data ----
let adminUser, regularUser;
let adminAgent, userAgent, unauthAgent;

beforeAll(async () => {
  adminUser = createUser('admin@test.com');
  regularUser = createUser('user@test.com');

  adminAgent = request.agent(app);
  userAgent = request.agent(app);
  unauthAgent = request.agent(app);

  // Log in admin and regular user (wait for session save)
  await adminAgent.get(`/__test_login/${adminUser.id}`).expect(200);
  await userAgent.get(`/__test_login/${regularUser.id}`).expect(200);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}
});

// =============================================
// TEST SUITE
// =============================================

describe('Feedback System', () => {

  // ---- 1. User can submit feedback ----
  describe('POST /api/feedback (user submit)', () => {
    test('returns 200 and inserts feedback', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('severity', 'medium')
        .field('message', 'Please add dark mode support');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBeDefined();

      // Verify in DB
      const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(res.body.id));
      expect(row).toBeDefined();
      expect(row.category).toBe('feature');
      expect(row.severity).toBe('medium');
      expect(row.message).toBe('Please add dark mode support');
      expect(row.user_id).toBe(regularUser.id);
      expect(row.user_email).toBe('user@test.com');
      expect(row.status).toBe('new');
    });

    test('accepts bug category with high severity', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'bug')
        .field('severity', 'high')
        .field('message', 'App crashes when uploading large files');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('stores page_url when provided', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'other')
        .field('severity', 'low')
        .field('message', 'Suggestion for the dashboard layout')
        .field('page_url', 'http://localhost:3000/dashboard.html');

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(res.body.id));
      expect(row).toBeDefined();
      expect(row.page_url).toBe('http://localhost:3000/dashboard.html');
    });
  });

  // ---- 2. Validation errors return 400 ----
  describe('POST /api/feedback (validation)', () => {
    test('rejects missing category', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('severity', 'low')
        .field('message', 'Some feedback message here');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/category/i);
    });

    test('rejects invalid category', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'invalid')
        .field('severity', 'low')
        .field('message', 'Some feedback message here');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/category/i);
    });

    test('rejects missing severity', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('message', 'Some feedback message here');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/severity/i);
    });

    test('rejects invalid severity', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('severity', 'critical')
        .field('message', 'Some feedback message here');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/severity/i);
    });

    test('rejects message shorter than 5 chars', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('severity', 'low')
        .field('message', 'Hi');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/5 char/i);
    });

    test('rejects empty message', async () => {
      const res = await userAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('severity', 'low')
        .field('message', '');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/5 char/i);
    });
  });

  // ---- 3. Unauthenticated user is rejected ----
  describe('Authentication checks', () => {
    test('unauthenticated user cannot submit feedback', async () => {
      const res = await unauthAgent
        .post('/api/feedback')
        .field('category', 'feature')
        .field('severity', 'low')
        .field('message', 'This should be rejected');

      expect(res.status).toBe(401);
    });

    test('unauthenticated user cannot access admin list', async () => {
      const res = await unauthAgent.get('/api/feedback/admin');
      // requireAuth fires first → 401, then requireAdmin would check admin
      expect([401, 403]).toContain(res.status);
    });
  });

  // ---- 4. Non-admin cannot access admin endpoints ----
  describe('Admin authorization', () => {
    test('non-admin cannot GET /api/feedback/admin', async () => {
      const res = await userAgent.get('/api/feedback/admin');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    test('non-admin cannot PATCH feedback status', async () => {
      const fb = db.prepare(
        "INSERT INTO feedback (user_id, user_email, category, severity, message) VALUES (?, ?, 'bug', 'low', 'test msg')"
      ).run(regularUser.id, 'user@test.com');

      const res = await userAgent
        .patch(`/api/feedback/admin/${Number(fb.lastInsertRowid)}`)
        .send({ status: 'reviewed' });

      expect(res.status).toBe(403);
    });

    test('non-admin cannot DELETE feedback', async () => {
      const fb = db.prepare(
        "INSERT INTO feedback (user_id, user_email, category, severity, message) VALUES (?, ?, 'bug', 'low', 'test msg')"
      ).run(regularUser.id, 'user@test.com');

      const res = await userAgent.delete(`/api/feedback/admin/${Number(fb.lastInsertRowid)}`);
      expect(res.status).toBe(403);
    });
  });

  // ---- 5. Admin can list feedback ----
  describe('GET /api/feedback/admin (admin)', () => {
    test('admin can list all feedback', async () => {
      const res = await adminAgent.get('/api/feedback/admin?status=');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('admin can filter by status', async () => {
      const res = await adminAgent.get('/api/feedback/admin?status=new');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      res.body.forEach(item => {
        expect(item.status).toBe('new');
      });
    });

    test('admin can filter by category', async () => {
      const res = await adminAgent.get('/api/feedback/admin?status=&category=bug');
      expect(res.status).toBe(200);
      res.body.forEach(item => {
        expect(item.category).toBe('bug');
      });
    });

    test('admin can search by message', async () => {
      const res = await adminAgent.get('/api/feedback/admin?status=&q=dark+mode');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].message).toMatch(/dark mode/i);
    });
  });

  // ---- 6. Admin can update status ----
  describe('PATCH /api/feedback/admin/:id (admin)', () => {
    let targetId;

    beforeAll(() => {
      // Insert a fresh feedback for these tests
      const fb = db.prepare(
        "INSERT INTO feedback (user_id, user_email, category, severity, message) VALUES (?, ?, 'feature', 'medium', 'status test feedback')"
      ).run(regularUser.id, 'user@test.com');
      targetId = Number(fb.lastInsertRowid);
    });

    test('admin can mark feedback as reviewed', async () => {
      const res = await adminAgent
        .patch(`/api/feedback/admin/${targetId}`)
        .send({ status: 'reviewed' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT status FROM feedback WHERE id = ?').get(targetId);
      expect(row.status).toBe('reviewed');
    });

    test('admin can close feedback', async () => {
      const res = await adminAgent
        .patch(`/api/feedback/admin/${targetId}`)
        .send({ status: 'closed' });

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT status FROM feedback WHERE id = ?').get(targetId);
      expect(row.status).toBe('closed');
    });

    test('rejects invalid status', async () => {
      const res = await adminAgent
        .patch(`/api/feedback/admin/${targetId}`)
        .send({ status: 'invalid' });

      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent feedback', async () => {
      const res = await adminAgent
        .patch('/api/feedback/admin/99999')
        .send({ status: 'reviewed' });

      expect(res.status).toBe(404);
    });
  });

  // ---- 7. Admin can delete feedback ----
  describe('DELETE /api/feedback/admin/:id (admin)', () => {
    test('admin can delete feedback', async () => {
      const fb = db.prepare(
        "INSERT INTO feedback (user_id, user_email, category, severity, message) VALUES (?, ?, 'other', 'low', 'delete me please')"
      ).run(regularUser.id, 'user@test.com');
      const id = Number(fb.lastInsertRowid);

      const res = await adminAgent.delete(`/api/feedback/admin/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
      expect(row).toBeUndefined();
    });

    test('returns 404 for non-existent feedback', async () => {
      const res = await adminAgent.delete('/api/feedback/admin/99999');
      expect(res.status).toBe(404);
    });
  });
});

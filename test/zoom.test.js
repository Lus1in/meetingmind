/**
 * Tests for Zoom integration routes
 *
 * Run: npx jest test/zoom.test.js
 */

const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'test-zoom.db');
try { fs.unlinkSync(testDbPath); } catch (e) {}

process.env.DATABASE_PATH = testDbPath;
process.env.MOCK_MODE = 'true';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-1234567';
process.env.ADMIN_EMAIL = 'admin@test.com';

const db = require('../database');

const express = require('express');
const session = require('express-session');
const zoomRoutes = require('../routes/zoom');

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

app.use('/api/zoom', zoomRoutes);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('password123', 4);

function createUser(email) {
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

let user;
let agent, unauthAgent;

beforeAll(async () => {
  user = createUser('zoomuser@test.com');

  agent = request.agent(app);
  unauthAgent = request.agent(app);

  await agent.get(`/__test_login/${user.id}`).expect(200);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}
});

describe('Zoom integration', () => {
  test('unauthenticated requests get 401', async () => {
    const res = await unauthAgent.get('/api/zoom/status');
    expect(res.status).toBe(401);
  });

  test('GET /status returns not connected initially', async () => {
    const res = await agent.get('/api/zoom/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  test('GET /connect in mock mode redirects with zoom=connected', async () => {
    const res = await agent.get('/api/zoom/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard.html?zoom=connected');
  });

  test('GET /status returns connected after mock connect', async () => {
    const res = await agent.get('/api/zoom/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.configured).toBe(true);
  });

  test('GET /meetings returns mock meetings in MOCK_MODE', async () => {
    const res = await agent.get('/api/zoom/meetings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
    expect(res.body[0]).toHaveProperty('topic');
    expect(res.body[0]).toHaveProperty('start_time');
    expect(res.body[0]).toHaveProperty('duration');
  });

  test('POST /disconnect removes tokens', async () => {
    const res = await agent.post('/api/zoom/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const statusRes = await agent.get('/api/zoom/status');
    expect(statusRes.body.connected).toBe(false);
  });

  test('zoom columns exist in users table', () => {
    const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    expect(cols).toContain('zoom_access_token');
    expect(cols).toContain('zoom_refresh_token');
    expect(cols).toContain('zoom_token_expires');
  });
});

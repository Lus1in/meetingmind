/**
 * Tests for Live Transcription (live session endpoints)
 *
 * Run: npx jest test/live.test.js
 */

const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'test-live.db');
try { fs.unlinkSync(testDbPath); } catch (e) {}

process.env.DATABASE_PATH = testDbPath;
process.env.MOCK_MODE = 'true';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-1234567';
process.env.ADMIN_EMAIL = 'admin@test.com';

const db = require('../database');

const express = require('express');
const session = require('express-session');
const liveRoutes = require('../routes/live');
const meetingsRoutes = require('../routes/meetings');

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

app.use('/api/live', liveRoutes);
app.use('/api/meetings', meetingsRoutes);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('password123', 4);

function createUser(email, plan) {
  db.prepare('INSERT INTO users (email, password, plan) VALUES (?, ?, ?)').run(email, hash, plan || 'free');
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

let freeUser, paidUser, otherUser;
let freeAgent, paidAgent, otherAgent;

beforeAll(async () => {
  freeUser = createUser('free-live@test.com', 'free');
  paidUser = createUser('paid-live@test.com', 'ltd');
  otherUser = createUser('other-live@test.com', 'free');

  freeAgent = request.agent(app);
  paidAgent = request.agent(app);
  otherAgent = request.agent(app);

  await freeAgent.get(`/__test_login/${freeUser.id}`).expect(200);
  await paidAgent.get(`/__test_login/${paidUser.id}`).expect(200);
  await otherAgent.get(`/__test_login/${otherUser.id}`).expect(200);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}
});

describe('Live Transcription', () => {
  let sessionId;

  test('POST /api/live/start creates a live session', async () => {
    const res = await paidAgent
      .post('/api/live/start')
      .send({ title: 'Test Live Meeting', participants: 'Alice, Bob' });

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeDefined();
    expect(res.body.title).toBe('Test Live Meeting');
    sessionId = res.body.session_id;

    // Verify in DB
    const row = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
    expect(row).toBeDefined();
    expect(row.status).toBe('active');
    expect(row.user_id).toBe(paidUser.id);
    expect(row.participants).toBe('Alice, Bob');
  });

  test('POST /api/live/start rejects duplicate active sessions', async () => {
    const res = await paidAgent
      .post('/api/live/start')
      .send({ title: 'Second Session' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('session_active');
    expect(res.body.session_id).toBe(sessionId);
  });

  test('POST /api/live/start uses default title if none provided', async () => {
    // Use otherUser who has no active session
    const res = await otherAgent
      .post('/api/live/start')
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.title).toContain('Live Meeting');

    // Clean up — stop this session
    db.prepare("UPDATE live_sessions SET status = 'completed' WHERE id = ?").run(res.body.session_id);
  });

  test('GET /api/live/:id/status returns session info', async () => {
    const res = await paidAgent.get(`/api/live/${sessionId}/status`);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.status).toBe('active');
    expect(res.body.title).toBe('Test Live Meeting');
    expect(res.body.segment_count).toBe(0);
  });

  test('GET /api/live/:id/status returns 404 for other user', async () => {
    const res = await otherAgent.get(`/api/live/${sessionId}/status`);
    expect(res.status).toBe(404);
  });

  test('POST /api/live/:id/chunk accepts audio and creates segment (mock)', async () => {
    // Create a tiny valid audio blob
    const audioBuffer = Buffer.alloc(1024, 0);

    const res = await paidAgent
      .post(`/api/live/${sessionId}/chunk`)
      .attach('audio', audioBuffer, 'chunk.webm')
      .field('timestamp_ms', '5000');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.segment_index).toBe(0);

    // Verify segment in DB
    const seg = db.prepare('SELECT * FROM transcript_segments WHERE session_id = ? AND segment_index = 0').get(sessionId);
    expect(seg).toBeDefined();
    expect(seg.text.length).toBeGreaterThan(0);
    expect(seg.timestamp_ms).toBe(5000);
  });

  test('POST /api/live/:id/chunk increments segment_index', async () => {
    const audioBuffer = Buffer.alloc(1024, 0);

    const res = await paidAgent
      .post(`/api/live/${sessionId}/chunk`)
      .attach('audio', audioBuffer, 'chunk.webm')
      .field('timestamp_ms', '10000');

    expect(res.status).toBe(200);
    expect(res.body.segment_index).toBe(1);
  });

  test('POST /api/live/:id/chunk rejects for other user', async () => {
    const audioBuffer = Buffer.alloc(1024, 0);

    const res = await otherAgent
      .post(`/api/live/${sessionId}/chunk`)
      .attach('audio', audioBuffer, 'chunk.webm')
      .field('timestamp_ms', '15000');

    expect(res.status).toBe(404);
  });

  test('POST /api/live/:id/memory-hints returns hints', async () => {
    // First, add a past meeting for this user so hints have something to match
    db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(paidUser.id, 'Prior Sprint', 'Attendees: Alice\n\nAlice: The landing page redesign is done. We need to finalize the mobile breakpoints and kick off the meeting.', '{"action_items":[],"follow_up_email":""}');

    const res = await paidAgent
      .post(`/api/live/${sessionId}/memory-hints`)
      .send({});

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hints)).toBe(true);
    // Hints may or may not match depending on keywords — just check structure
  });

  test('POST /api/live/:id/stop finalizes session and creates meeting', async () => {
    const res = await paidAgent
      .post(`/api/live/${sessionId}/stop`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.meeting_id).toBeDefined();
    expect(res.body.title).toBe('Test Live Meeting');

    // Verify session is completed
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
    expect(session.status).toBe('completed');
    expect(session.meeting_id).toBe(res.body.meeting_id);
    expect(session.ended_at).toBeDefined();

    // Verify meeting was created with transcript
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(res.body.meeting_id);
    expect(meeting).toBeDefined();
    expect(meeting.raw_notes.length).toBeGreaterThan(0);
    expect(meeting.title).toBe('Test Live Meeting');

    // Verify action items were extracted (mock mode)
    const actionItems = JSON.parse(meeting.action_items);
    expect(actionItems.action_items.length).toBeGreaterThan(0);
    expect(actionItems.follow_up_email.length).toBeGreaterThan(0);
  });

  test('POST /api/live/:id/stop rejects already-stopped session', async () => {
    const res = await paidAgent
      .post(`/api/live/${sessionId}/stop`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Session is not active');
  });

  test('POST /api/live/:id/chunk rejects for stopped session', async () => {
    const audioBuffer = Buffer.alloc(1024, 0);

    const res = await paidAgent
      .post(`/api/live/${sessionId}/chunk`)
      .attach('audio', audioBuffer, 'chunk.webm')
      .field('timestamp_ms', '20000');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Session is not active');
  });

  test('unauthenticated requests return 401', async () => {
    const unauth = request.agent(app);

    const res1 = await unauth.post('/api/live/start').send({ title: 'test' });
    expect(res1.status).toBe(401);

    const res2 = await unauth.get('/api/live/1/status');
    expect(res2.status).toBe(401);

    const res3 = await unauth.post('/api/live/1/stop').send({});
    expect(res3.status).toBe(401);
  });

  test('POST /api/live/start checks meeting storage limit for free users', async () => {
    // Free user gets 3 meeting limit — fill it up
    for (let i = 0; i < 3; i++) {
      db.prepare(
        'INSERT INTO meetings (user_id, raw_notes, action_items) VALUES (?, ?, ?)'
      ).run(freeUser.id, 'notes ' + i, '{"action_items":[],"follow_up_email":""}');
    }

    const res = await freeAgent
      .post('/api/live/start')
      .send({ title: 'Over Limit' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('meeting_limit');
  });

  test('POST /api/live/:id/stop with no segments returns null meeting_id', async () => {
    // Create session directly in DB to avoid rate limit from prior tests
    const result = db.prepare(
      'INSERT INTO live_sessions (user_id, title, status) VALUES (?, ?, ?)'
    ).run(paidUser.id, 'Empty Session', 'active');
    const emptySessionId = result.lastInsertRowid;

    // Stop immediately (no chunks sent)
    const stopRes = await paidAgent
      .post(`/api/live/${emptySessionId}/stop`)
      .send({});

    expect(stopRes.status).toBe(200);
    expect(stopRes.body.meeting_id).toBeNull();
    expect(stopRes.body.message).toContain('No transcript');

    // Session marked as failed
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(emptySessionId);
    expect(session.status).toBe('failed');
  });
});

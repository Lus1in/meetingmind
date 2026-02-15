/**
 * Tests for Cross-Meeting Intelligence (insights endpoint)
 *
 * Run: npx jest test/insights.test.js
 */

const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'test-insights.db');
try { fs.unlinkSync(testDbPath); } catch (e) {}

process.env.DATABASE_PATH = testDbPath;
process.env.MOCK_MODE = 'true';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-1234567';
process.env.ADMIN_EMAIL = 'admin@test.com';

const db = require('../database');

const express = require('express');
const session = require('express-session');
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

app.use('/api/meetings', meetingsRoutes);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('password123', 4);

function createUser(email) {
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

let user, otherUser;
let agent, otherAgent;

beforeAll(async () => {
  user = createUser('insights@test.com');
  otherUser = createUser('other@test.com');

  agent = request.agent(app);
  otherAgent = request.agent(app);

  await agent.get(`/__test_login/${user.id}`).expect(200);
  await otherAgent.get(`/__test_login/${otherUser.id}`).expect(200);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}
});

describe('Cross-Meeting Intelligence', () => {
  let meetingId1, meetingId2, meetingId3;

  test('returns empty insights for first meeting (no prior meetings)', async () => {
    // Insert a meeting
    const row = db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'Sprint Planning', 'Attendees: Sarah, John\n\nSarah: The dashboard redesign is done.\nJohn: I will fix the authentication bug by Friday.', '{"action_items":[{"task":"Fix authentication bug","owner":"John","deadline":"Friday"}],"follow_up_email":""}');
    meetingId1 = row.lastInsertRowid;

    const res = await agent.get(`/api/meetings/${meetingId1}/insights`);
    expect(res.status).toBe(200);
    expect(res.body.meeting_id).toBe(meetingId1);
    expect(res.body.insights).toEqual([]);
    expect(res.body.message).toContain('first meeting');
  });

  test('detects recurring topics between two meetings', async () => {
    // Insert a second meeting with overlapping topics
    const row = db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'Sprint Review', 'Attendees: Sarah, John, Mike\n\nSarah: The dashboard redesign feedback is positive.\nJohn: The authentication bug is still open on staging.\nMike: Client onboarding went well.', '{"action_items":[{"task":"Close authentication bug","owner":"John","deadline":"Monday"}],"follow_up_email":""}');
    meetingId2 = row.lastInsertRowid;

    const res = await agent.get(`/api/meetings/${meetingId2}/insights`);
    expect(res.status).toBe(200);
    expect(res.body.insights.length).toBeGreaterThan(0);

    const repeatedTopics = res.body.insights.find(i => i.type === 'repeated_topics');
    expect(repeatedTopics).toBeDefined();
    expect(repeatedTopics.title).toBe('Recurring Topics');
    expect(repeatedTopics.details.length).toBeGreaterThan(0);
  });

  test('detects unresolved action items from prior meetings', async () => {
    const res = await agent.get(`/api/meetings/${meetingId2}/insights`);
    const unresolved = res.body.insights.find(i => i.type === 'unresolved_items');
    // The "authentication bug" action item from meeting1 is mentioned again in meeting2
    expect(unresolved).toBeDefined();
    expect(unresolved.details.length).toBeGreaterThan(0);
    expect(unresolved.details[0].task).toContain('authentication');
  });

  test('detects recurring participants', async () => {
    const res = await agent.get(`/api/meetings/${meetingId2}/insights`);
    const participants = res.body.insights.find(i => i.type === 'recurring_participants');
    expect(participants).toBeDefined();
    // Sarah and John appear in both meetings
    const names = participants.details.map(d => d.name.toLowerCase());
    expect(names).toContain('sarah');
    expect(names).toContain('john');
  });

  test('detects new topics not seen in prior meetings', async () => {
    const res = await agent.get(`/api/meetings/${meetingId2}/insights`);
    const newTopics = res.body.insights.find(i => i.type === 'new_topics');
    // "onboarding" and "client" are new in meeting2
    if (newTopics) {
      expect(newTopics.details.length).toBeGreaterThan(0);
    }
  });

  test('detects follow-up signals', async () => {
    // Insert a meeting with follow-up language
    const row = db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'Follow-up Meeting', 'Attendees: Sarah\n\nSarah: As discussed previously, the dashboard redesign needs one more round.\nFollowing up on the authentication issue from last time.', '{"action_items":[],"follow_up_email":""}');
    meetingId3 = row.lastInsertRowid;

    const res = await agent.get(`/api/meetings/${meetingId3}/insights`);
    expect(res.status).toBe(200);
    const signals = res.body.insights.find(i => i.type === 'follow_up_signals');
    expect(signals).toBeDefined();
    expect(signals.details.length).toBeGreaterThan(0);
  });

  test('returns 404 for non-existent meeting', async () => {
    const res = await agent.get('/api/meetings/99999/insights');
    expect(res.status).toBe(404);
  });

  test('returns 404 for another user\'s meeting', async () => {
    const res = await otherAgent.get(`/api/meetings/${meetingId1}/insights`);
    expect(res.status).toBe(404);
  });

  test('unauthenticated request returns 401', async () => {
    const unauthAgent = request.agent(app);
    const res = await unauthAgent.get(`/api/meetings/${meetingId1}/insights`);
    expect(res.status).toBe(401);
  });

  test('insights response structure is correct', async () => {
    const res = await agent.get(`/api/meetings/${meetingId2}/insights`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meeting_id');
    expect(Array.isArray(res.body.insights)).toBe(true);

    for (const insight of res.body.insights) {
      expect(insight).toHaveProperty('type');
      expect(insight).toHaveProperty('title');
      expect(insight).toHaveProperty('description');
      expect(insight).toHaveProperty('details');
    }
  });
});

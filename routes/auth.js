const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');

const router = express.Router();

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;

  // Validation
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Check if user already exists
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  // Hash password and create user
  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hash);

  // Auto-login after signup
  req.session.userId = result.lastInsertRowid;

  res.status(201).json({ message: 'Account created' });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT id, password FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.userId = user.id;

  res.json({ message: 'Logged in' });
});

// GET /api/auth/me — check if logged in
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.userId);
  res.json({ id: user.id, email: user.email });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

module.exports = router;

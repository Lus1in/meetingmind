const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { sendEmail } = require('../lib/email');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }); // 10 per 15min
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }); // 5 per 15min

// POST /api/auth/signup
router.post('/signup', authLimiter, async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

  // Validation
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
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
router.post('/login', authLimiter, async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

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
  const user = db.prepare('SELECT id, email, plan, is_lifetime, subscription_status FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not logged in' });
  }
  const adminEmail = process.env.ADMIN_EMAIL;
  const isAdmin = !!(adminEmail && user.email.toLowerCase() === adminEmail.toLowerCase());

  res.json({
    id: user.id,
    email: user.email,
    plan: user.plan,
    is_lifetime: user.is_lifetime === 1,
    subscription_status: user.subscription_status,
    mock_mode: process.env.MOCK_MODE === 'true',
    isAdmin
  });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  // Always return success (don't reveal whether email exists)
  if (!user) {
    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }

  // Generate token (48 bytes → 96-char hex string)
  const token = crypto.randomBytes(48).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
    .run(token, expires, user.id);

  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const resetUrl = `${APP_URL}/reset-password.html?token=${token}`;

  if (process.env.MOCK_MODE === 'true') {
    // Dev: log to console
    console.log(`[reset] Password reset link for ${email}: ${resetUrl}`);
  } else {
    // Production: send real email
    try {
      await sendEmail({
        to: email,
        subject: 'Reset your MeetingMind password',
        html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#333">
  <h2 style="margin:0 0 16px">Reset your password</h2>
  <p>You requested a password reset for your MeetingMind account.</p>
  <p style="margin:24px 0"><a href="${resetUrl}" style="display:inline-block;background:#4361ee;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500">Reset Password</a></p>
  <p style="color:#888;font-size:14px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
</div>`
      });
    } catch (err) {
      console.error('[email] Failed to send reset email:', err.message);
      // Still return success — don't leak info, and token is saved for manual recovery
    }
  }

  res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const user = db.prepare(
    'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?'
  ).get(token, new Date().toISOString());

  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
  }

  const hash = await bcrypt.hash(password, 10);

  db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(hash, user.id);

  res.json({ message: 'Password updated. You can now log in.' });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

module.exports = router;

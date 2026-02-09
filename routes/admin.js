const express = require('express');
const db = require('../database');

const router = express.Router();

// Block all admin routes if ADMIN_SECRET is not set
router.use((req, res, next) => {
  if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.length < 16) {
    return res.status(503).json({ error: 'Admin endpoint disabled. Set a strong ADMIN_SECRET (16+ chars) in .env' });
  }
  next();
});

// POST /api/admin/upgrade — change a user's plan
// Protected by ADMIN_SECRET header
router.post('/upgrade', (req, res) => {
  const secret = req.headers['x-admin-secret'];

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { email, plan } = req.body;

  if (!email || !plan) {
    return res.status(400).json({ error: 'Email and plan are required' });
  }

  const validPlans = ['free', 'ltd', 'fltd', 'sub_basic', 'sub_pro'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` });
  }

  const newIsLifetime = ['ltd', 'fltd'].includes(plan) ? 1 : 0;

  // Guard: prevent clearing lifetime unless force: true
  const existing = db.prepare('SELECT is_lifetime FROM users WHERE email = ?').get(email);
  if (existing && existing.is_lifetime === 1 && newIsLifetime === 0) {
    if (!req.body.force) {
      return res.status(409).json({
        error: 'This user has a lifetime plan. Pass { "force": true } to downgrade.',
        current_lifetime: true
      });
    }
    // Temporarily drop trigger to allow the override
    db.exec('DROP TRIGGER IF EXISTS protect_lifetime_flag');
  }

  let result;
  try {
    result = db.prepare('UPDATE users SET plan = ?, is_lifetime = ? WHERE email = ?').run(plan, newIsLifetime, email);
  } finally {
    // Re-create trigger if it was dropped
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS protect_lifetime_flag
      BEFORE UPDATE ON users
      WHEN OLD.is_lifetime = 1 AND NEW.is_lifetime = 0
      BEGIN
        SELECT RAISE(ABORT, 'Cannot clear is_lifetime flag. Drop trigger protect_lifetime_flag to override.');
      END;
    `);
  }

  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ message: `User ${email} upgraded to ${plan}` });
});

module.exports = router;

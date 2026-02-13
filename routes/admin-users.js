const express = require('express');
const db = require('../database');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// GET /api/admin/users — list all users (admin only)
router.get('/', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare(
    'SELECT id, email, plan, is_lifetime, subscription_status, created_at, last_seen_at FROM users ORDER BY created_at DESC'
  ).all();

  const now = Date.now();
  const users = rows.map(u => ({
    id: u.id,
    email: u.email,
    plan: u.plan,
    is_lifetime: u.is_lifetime === 1,
    subscription_status: u.subscription_status,
    created_at: u.created_at,
    last_seen_at: u.last_seen_at,
    isOnline: !!(u.last_seen_at && (now - new Date(u.last_seen_at + 'Z').getTime()) < 2 * 60 * 1000)
  }));

  res.json(users);
});

module.exports = router;

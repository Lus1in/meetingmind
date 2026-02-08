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

  const validPlans = ['free', 'ltd', 'fltd'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` });
  }

  const result = db.prepare('UPDATE users SET plan = ? WHERE email = ?').run(plan, email);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ message: `User ${email} upgraded to ${plan}` });
});

module.exports = router;

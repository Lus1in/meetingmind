const db = require('../database');

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.email.toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

module.exports = requireAdmin;

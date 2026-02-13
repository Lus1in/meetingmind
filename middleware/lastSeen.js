const db = require('../database');

const stmt = db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?");

function lastSeen(req, _res, next) {
  if (req.session && req.session.userId) {
    try { stmt.run(req.session.userId); } catch {}
  }
  next();
}

module.exports = lastSeen;

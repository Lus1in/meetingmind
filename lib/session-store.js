/**
 * SQLite-backed session store for express-session.
 * Uses the existing better-sqlite3 connection — no new dependency.
 * Sessions survive server restarts and Render deploys.
 */
const session = require('express-session');
const db = require('../database');

// Create sessions table
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  )
`);

// Prepared statements (reuse for performance)
const stmtGet = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
const stmtSet = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
const stmtDestroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtTouch = db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?');
const stmtCleanup = db.prepare('DELETE FROM sessions WHERE expired <= ?');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    // Cleanup expired sessions every 15 minutes
    const timer = setInterval(() => {
      stmtCleanup.run(Date.now());
    }, 15 * 60 * 1000);
    timer.unref();
  }

  get(sid, cb) {
    try {
      const row = stmtGet.get(sid, Date.now());
      if (!row) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 86400000;
      const expired = Date.now() + maxAge;
      stmtSet.run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try {
      stmtDestroy.run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 86400000;
      const expired = Date.now() + maxAge;
      stmtTouch.run(expired, sid);
      cb(null);
    } catch (err) { cb(err); }
  }
}

module.exports = SQLiteStore;

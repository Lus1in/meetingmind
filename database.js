const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
// Enforce foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    raw_notes TEXT NOT NULL,
    action_items TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    extracts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, month)
  );
`);

// Migration: add plan column if upgrading from older schema
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('plan')) {
  db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
}

module.exports = db;

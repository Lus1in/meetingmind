const Database = require('better-sqlite3');
const path = require('path');

// DATABASE_PATH env var lets Render mount a persistent disk (e.g. /var/data/data.db)
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

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
    is_lifetime INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none',
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

// Migrations for existing databases — meetings
const meetingCols = db.prepare("PRAGMA table_info(meetings)").all().map(c => c.name);
if (!meetingCols.includes('title')) {
  db.exec("ALTER TABLE meetings ADD COLUMN title TEXT");
}
if (!meetingCols.includes('updated_at')) {
  db.exec("ALTER TABLE meetings ADD COLUMN updated_at DATETIME");
}

// Migrations for existing databases — users
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('plan')) {
  db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
}
if (!cols.includes('is_lifetime')) {
  db.exec("ALTER TABLE users ADD COLUMN is_lifetime INTEGER NOT NULL DEFAULT 0");
  // Backfill: mark existing ltd/fltd users as lifetime
  db.exec("UPDATE users SET is_lifetime = 1 WHERE plan IN ('ltd', 'fltd')");
}
if (!cols.includes('stripe_customer_id')) {
  db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
}
if (!cols.includes('stripe_subscription_id')) {
  db.exec("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT");
}
if (!cols.includes('subscription_status')) {
  db.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none'");
}
if (!cols.includes('last_seen_at')) {
  db.exec("ALTER TABLE users ADD COLUMN last_seen_at DATETIME");
}
if (!cols.includes('reset_token')) {
  db.exec("ALTER TABLE users ADD COLUMN reset_token TEXT");
}
if (!cols.includes('reset_token_expires')) {
  db.exec("ALTER TABLE users ADD COLUMN reset_token_expires DATETIME");
}

// OAuth provider identities (supports Google, Apple, Microsoft, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(provider, provider_id)
  );
`);

// Feedback table
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_email TEXT,
    category TEXT NOT NULL CHECK(category IN ('feature','bug','other')),
    severity TEXT NOT NULL CHECK(severity IN ('low','medium','high')),
    message TEXT NOT NULL,
    screenshot_path TEXT,
    user_agent TEXT,
    page_url TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new','reviewed','closed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Constraints & triggers
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer
    ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
`);

// Fix 5: DB-level trigger — makes it physically impossible to clear is_lifetime
// Admin/migration scripts must DROP this trigger first to override
db.exec(`
  CREATE TRIGGER IF NOT EXISTS protect_lifetime_flag
  BEFORE UPDATE ON users
  WHEN OLD.is_lifetime = 1 AND NEW.is_lifetime = 0
  BEGIN
    SELECT RAISE(ABORT, 'Cannot clear is_lifetime flag. Drop trigger protect_lifetime_flag to override.');
  END;
`);

module.exports = db;

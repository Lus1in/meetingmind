const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');

const isProd = process.env.NODE_ENV === 'production';
const isMock = process.env.MOCK_MODE === 'true';

// ---- Startup Validation ----
// Always required
if (!process.env.SESSION_SECRET) {
  console.error('[startup] FATAL: SESSION_SECRET is not set. Exiting.');
  process.exit(1);
}

// Required when running real (MOCK_MODE=false)
if (!isMock) {
  const critical = { CLAUDE_API_KEY: process.env.CLAUDE_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const missing = Object.entries(critical).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.error(`[startup] FATAL: MOCK_MODE is false but missing: ${missing.join(', ')}`);
    console.error('[startup] Set MOCK_MODE=true for local dev, or provide these vars.');
    process.exit(1);
  }
}

// Optional — warn if missing (features disabled, not fatal)
const optional = {
  STRIPE_SECRET_KEY: 'Billing',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhooks',
  GOOGLE_CLIENT_ID: 'Google OAuth',
  RESEND_API_KEY: 'Password reset emails',
};
Object.entries(optional).forEach(([key, label]) => {
  if (!process.env[key]) console.warn(`[startup] WARN: ${key} not set — ${label} disabled`);
});

// Debug log (dev only)
if (!isProd) {
  console.log('[env] MOCK_MODE:', process.env.MOCK_MODE);
}

const SQLiteStore = require('./lib/session-store');
const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');
const meetingRoutes = require('./routes/meetings');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const feedbackRoutes = require('./routes/feedback');
const adminUsersRoutes = require('./routes/admin-users');
const zoomRoutes = require('./routes/zoom');
const liveRoutes = require('./routes/live');
const blogRoutes = require('./routes/blog');
const lastSeen = require('./middleware/lastSeen');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy when behind Render/Railway reverse proxy
if (isProd) {
  app.set('trust proxy', 1);
}

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Apple OAuth POSTs form data
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Track last seen for authenticated users
app.use(lastSeen);

// Health check — safe config flags only, never secrets
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock_mode: isMock,
    oauth: !!(process.env.GOOGLE_CLIENT_ID || process.env.APPLE_CLIENT_ID),
    email: !!process.env.RESEND_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    transcription: !!(process.env.OPENAI_API_KEY || isMock)
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/zoom', zoomRoutes);
app.use('/api/live', liveRoutes);
app.use('/blog', blogRoutes);

// Admin feedback page — served behind auth + admin check
const requireAuth = require('./middleware/auth');
const requireAdmin = require('./middleware/requireAdmin');
app.get('/admin/feedback', requireAuth, requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-feedback.html'));
});
app.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-users.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} [${isProd ? 'production' : 'development'}]`);
});

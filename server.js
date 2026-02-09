const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');

const isProd = process.env.NODE_ENV === 'production';

// Debug: verify .env loaded correctly (never in production)
if (!isProd) {
  console.log('[env] STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'set' : 'MISSING');
  console.log('[env] STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? 'set' : 'MISSING or empty');
  console.log('[env] MOCK_MODE:', process.env.MOCK_MODE);
}

const authRoutes = require('./routes/auth');
const meetingRoutes = require('./routes/meetings');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');

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
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'lax' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} [${isProd ? 'production' : 'development'}]`);
});

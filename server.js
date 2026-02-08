require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const meetingRoutes = require('./routes/meetings');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Trust proxy when behind Render/Railway reverse proxy
if (isProd) {
  app.set('trust proxy', 1);
}

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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} [${isProd ? 'production' : 'development'}]`);
});

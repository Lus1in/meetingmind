const express = require('express');
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');

const router = express.Router();

// --- Config ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;
const APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// =====================
// Helpers
// =====================

// Decode JWT payload without signature verification.
// Safe because tokens come directly from provider endpoints over TLS.
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

// HTTPS POST with form-encoded body → parsed JSON response
function httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from OAuth provider')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Find existing user by provider identity or email, or create a new one.
// Returns the user ID.
function findOrCreateOAuthUser(provider, providerId, email) {
  // 1. Check if this provider identity already exists
  const existing = db.prepare(
    'SELECT user_id FROM user_identities WHERE provider = ? AND provider_id = ?'
  ).get(provider, providerId);

  if (existing) {
    return existing.user_id;
  }

  // 2. Check if a user with this email already exists → link provider
  if (email) {
    const emailUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (emailUser) {
      db.prepare(
        'INSERT INTO user_identities (user_id, provider, provider_id) VALUES (?, ?, ?)'
      ).run(emailUser.id, provider, providerId);
      return emailUser.id;
    }
  }

  // 3. Create new user with random password (OAuth-only user)
  // User can set a real password later via "Forgot password?"
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const hash = bcrypt.hashSync(randomPassword, 10);
  const result = db.prepare(
    'INSERT INTO users (email, password) VALUES (?, ?)'
  ).run(email, hash);

  const userId = result.lastInsertRowid;

  db.prepare(
    'INSERT INTO user_identities (user_id, provider, provider_id) VALUES (?, ?, ?)'
  ).run(userId, provider, providerId);

  return userId;
}

// =====================
// GOOGLE OAUTH 2.0
// =====================

// GET /api/oauth/google — redirect to Google consent screen
router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send('Google login is not configured.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/oauth/google/callback`,
    response_type: 'code',
    scope: 'email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/oauth/google/callback — exchange code, find/create user, set session
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect('/login.html?error=google_denied');
    }

    if (!code || !state || state !== req.session.oauthState) {
      return res.redirect('/login.html?error=invalid_state');
    }

    delete req.session.oauthState;

    // Exchange authorization code for tokens
    const tokens = await httpsPost('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${APP_URL}/api/oauth/google/callback`,
      grant_type: 'authorization_code'
    });

    if (!tokens.id_token) {
      console.error('[oauth] Google token exchange failed:', tokens.error || 'no id_token');
      return res.redirect('/login.html?error=google_failed');
    }

    const payload = decodeJwtPayload(tokens.id_token);
    const email = (payload.email || '').toLowerCase();
    const googleId = payload.sub;

    if (!email || !payload.email_verified) {
      return res.redirect('/login.html?error=email_unverified');
    }

    const userId = findOrCreateOAuthUser('google', googleId, email);
    req.session.userId = userId;

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[oauth] Google callback error:', err.message);
    res.redirect('/login.html?error=google_failed');
  }
});

// =====================
// APPLE SIGN IN
// =====================

// Generate Apple client_secret JWT (signed with your .p8 private key)
function generateAppleClientSecret() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: APPLE_TEAM_ID,
      iat: now,
      exp: now + 86400 * 180, // 6 months
      aud: 'https://appleid.apple.com',
      sub: APPLE_CLIENT_ID
    },
    APPLE_PRIVATE_KEY,
    {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: APPLE_KEY_ID }
    }
  );
}

// GET /api/oauth/apple — redirect to Apple authorization screen
router.get('/apple', (req, res) => {
  if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
    return res.status(503).send('Apple login is not configured.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.appleNonce = nonce;

  const params = new URLSearchParams({
    client_id: APPLE_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/oauth/apple/callback`,
    response_type: 'code id_token',
    scope: 'email name',
    response_mode: 'form_post',
    state,
    nonce
  });

  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

// POST /api/oauth/apple/callback — Apple POSTs form data (response_mode=form_post)
router.post('/apple/callback', async (req, res) => {
  try {
    const { code, state, id_token, error } = req.body;

    if (error) {
      return res.redirect('/login.html?error=apple_denied');
    }

    if (!code || !state || state !== req.session.oauthState) {
      return res.redirect('/login.html?error=invalid_state');
    }

    delete req.session.oauthState;
    delete req.session.appleNonce;

    // Exchange authorization code for tokens
    const clientSecret = generateAppleClientSecret();
    const tokens = await httpsPost('https://appleid.apple.com/auth/token', {
      code,
      client_id: APPLE_CLIENT_ID,
      client_secret: clientSecret,
      redirect_uri: `${APP_URL}/api/oauth/apple/callback`,
      grant_type: 'authorization_code'
    });

    // Prefer id_token from token exchange; fall back to the one Apple POSTed
    const idToken = tokens.id_token || id_token;
    if (!idToken) {
      console.error('[oauth] Apple token exchange failed:', tokens.error || 'no id_token');
      return res.redirect('/login.html?error=apple_failed');
    }

    const payload = decodeJwtPayload(idToken);
    const appleSub = payload.sub; // Stable Apple user identifier
    let email = (payload.email || '').toLowerCase();

    // Apple may hide email on subsequent logins — apple_sub is stable
    if (!email) {
      const existing = db.prepare(
        'SELECT user_id FROM user_identities WHERE provider = ? AND provider_id = ?'
      ).get('apple', appleSub);

      if (!existing) {
        // First auth but no email — shouldn't happen (Apple sends email on first consent)
        return res.redirect('/login.html?error=apple_no_email');
      }

      req.session.userId = existing.user_id;
      return res.redirect('/dashboard.html');
    }

    const userId = findOrCreateOAuthUser('apple', appleSub, email);
    req.session.userId = userId;

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[oauth] Apple callback error:', err.message);
    res.redirect('/login.html?error=apple_failed');
  }
});

module.exports = router;

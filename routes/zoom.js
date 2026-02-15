const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const ZOOM_AUTH_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

function getZoomConfig() {
  return {
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
    redirectUri: (process.env.APP_URL || 'http://localhost:3000') + '/api/zoom/callback'
  };
}

function isZoomConfigured() {
  return !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
}

// GET /api/zoom/status — check if Zoom is connected for current user
router.get('/status', requireAuth, (req, res) => {
  if (!isZoomConfigured() && process.env.MOCK_MODE !== 'true') {
    return res.json({ configured: false, connected: false });
  }

  const user = db.prepare('SELECT zoom_access_token, zoom_token_expires FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.zoom_access_token) {
    return res.json({ configured: true, connected: false });
  }

  const expired = user.zoom_token_expires && new Date(user.zoom_token_expires + 'Z') < new Date();
  res.json({ configured: true, connected: true, expired: !!expired });
});

// GET /api/zoom/connect — redirect to Zoom OAuth
router.get('/connect', requireAuth, (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
    // Mock mode: simulate successful OAuth
    const now = new Date();
    const expires = new Date(now.getTime() + 3600 * 1000);
    db.prepare('UPDATE users SET zoom_access_token = ?, zoom_refresh_token = ?, zoom_token_expires = ? WHERE id = ?')
      .run('mock_access_token', 'mock_refresh_token', expires.toISOString().replace('T', ' ').slice(0, 19), req.session.userId);
    return res.redirect('/dashboard.html?zoom=connected');
  }

  if (!isZoomConfigured()) {
    return res.status(400).json({ error: 'Zoom integration is not configured.' });
  }

  const config = getZoomConfig();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.zoomOAuthState = state;
  req.session.save(() => {
    const url = `${ZOOM_AUTH_URL}?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&state=${state}`;
    res.redirect(url);
  });
});

// GET /api/zoom/callback — handle Zoom OAuth callback
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.zoomOAuthState) {
    return res.redirect('/dashboard.html?zoom=error&reason=invalid_state');
  }

  delete req.session.zoomOAuthState;

  const config = getZoomConfig();
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  try {
    const tokenRes = await fetch(ZOOM_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri
      })
    });

    if (!tokenRes.ok) {
      console.error('[zoom] Token exchange failed:', tokenRes.status);
      return res.redirect('/dashboard.html?zoom=error&reason=token_failed');
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    db.prepare('UPDATE users SET zoom_access_token = ?, zoom_refresh_token = ?, zoom_token_expires = ? WHERE id = ?')
      .run(tokens.access_token, tokens.refresh_token, expiresAt.toISOString().replace('T', ' ').slice(0, 19), req.session.userId);

    res.redirect('/dashboard.html?zoom=connected');
  } catch (err) {
    console.error('[zoom] OAuth callback error:', err.message);
    res.redirect('/dashboard.html?zoom=error&reason=exception');
  }
});

// POST /api/zoom/disconnect — remove Zoom tokens
router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET zoom_access_token = NULL, zoom_refresh_token = NULL, zoom_token_expires = NULL WHERE id = ?')
    .run(req.session.userId);
  res.json({ ok: true });
});

// Refresh access token if expired
async function refreshToken(userId) {
  const user = db.prepare('SELECT zoom_refresh_token FROM users WHERE id = ?').get(userId);
  if (!user || !user.zoom_refresh_token) return null;

  if (process.env.MOCK_MODE === 'true') {
    const expires = new Date(Date.now() + 3600 * 1000);
    db.prepare('UPDATE users SET zoom_access_token = ?, zoom_token_expires = ? WHERE id = ?')
      .run('mock_refreshed_token', expires.toISOString().replace('T', ' ').slice(0, 19), userId);
    return 'mock_refreshed_token';
  }

  const config = getZoomConfig();
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const tokenRes = await fetch(ZOOM_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.zoom_refresh_token
    })
  });

  if (!tokenRes.ok) return null;

  const tokens = await tokenRes.json();
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

  db.prepare('UPDATE users SET zoom_access_token = ?, zoom_refresh_token = ?, zoom_token_expires = ? WHERE id = ?')
    .run(tokens.access_token, tokens.refresh_token || user.zoom_refresh_token, expiresAt.toISOString().replace('T', ' ').slice(0, 19), userId);

  return tokens.access_token;
}

// Get valid access token (refresh if needed)
async function getAccessToken(userId) {
  const user = db.prepare('SELECT zoom_access_token, zoom_token_expires FROM users WHERE id = ?').get(userId);
  if (!user || !user.zoom_access_token) return null;

  if (process.env.MOCK_MODE === 'true') return 'mock_access_token';

  const expired = user.zoom_token_expires && new Date(user.zoom_token_expires + 'Z') < new Date();
  if (expired) return await refreshToken(userId);

  return user.zoom_access_token;
}

// GET /api/zoom/meetings — list recent Zoom meetings
router.get('/meetings', requireAuth, async (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
    return res.json([
      { id: 'mock-1', topic: 'Weekly Team Standup', start_time: '2026-02-14T10:00:00Z', duration: 30 },
      { id: 'mock-2', topic: 'Product Review', start_time: '2026-02-13T14:00:00Z', duration: 45 },
      { id: 'mock-3', topic: 'Sprint Planning', start_time: '2026-02-12T09:00:00Z', duration: 60 }
    ]);
  }

  const token = await getAccessToken(req.session.userId);
  if (!token) {
    return res.status(401).json({ error: 'Zoom not connected. Please connect your Zoom account.' });
  }

  try {
    const apiRes = await fetch(`${ZOOM_API_BASE}/users/me/meetings?type=previous_meetings&page_size=20`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!apiRes.ok) {
      if (apiRes.status === 401) {
        return res.status(401).json({ error: 'Zoom token expired. Please reconnect.' });
      }
      return res.status(apiRes.status).json({ error: 'Failed to fetch Zoom meetings.' });
    }

    const data = await apiRes.json();
    const meetings = (data.meetings || []).map(m => ({
      id: m.id,
      topic: m.topic,
      start_time: m.start_time,
      duration: m.duration
    }));

    res.json(meetings);
  } catch (err) {
    console.error('[zoom] List meetings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Zoom meetings.' });
  }
});

module.exports = router;

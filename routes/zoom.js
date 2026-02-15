const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ---- Token helpers ----

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

async function getAccessToken(userId) {
  const user = db.prepare('SELECT zoom_access_token, zoom_token_expires FROM users WHERE id = ?').get(userId);
  if (!user || !user.zoom_access_token) return null;

  if (process.env.MOCK_MODE === 'true') return 'mock_access_token';

  const expired = user.zoom_token_expires && new Date(user.zoom_token_expires + 'Z') < new Date();
  if (expired) return await refreshToken(userId);

  return user.zoom_access_token;
}

// ---- OpenAI Whisper (lazy init, same pattern as meetings.js) ----

let openai = null;
function getOpenAI() {
  if (process.env.MOCK_MODE === 'true') return null;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

const MOCK_TRANSCRIPT = `Zoom Meeting Transcript — Mock Mode

Attendees: Sarah, John, Mike

Sarah: Let's review the sprint. I finished the dashboard redesign and it's deployed to staging.

John: The API rate limiter is done and passing tests. I'll merge it today.

Mike: Client onboarding call went well. They want a demo next Thursday. I'll coordinate with Sarah on the updated designs.

Sarah: Sounds good. I also want to flag — we need to decide on the analytics provider by end of week.

John: I can research options and send a comparison by Wednesday.

Mike: Great. I'll update the project board after this call.`;

// ---- Routes ----

// GET /api/zoom/status
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

// GET /api/zoom/connect
router.get('/connect', requireAuth, (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
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

// GET /api/zoom/callback
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

// POST /api/zoom/disconnect
router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET zoom_access_token = NULL, zoom_refresh_token = NULL, zoom_token_expires = NULL WHERE id = ?')
    .run(req.session.userId);
  res.json({ ok: true });
});

// GET /api/zoom/recordings — list cloud recordings with audio files
router.get('/recordings', requireAuth, async (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
    return res.json([
      {
        meeting_id: 'mock-1',
        topic: 'Weekly Team Standup',
        start_time: '2026-02-14T10:00:00Z',
        duration: 30,
        recordings: [
          { id: 'rec-1a', file_type: 'MP4', file_size: 52428800, recording_type: 'shared_screen_with_speaker_view', status: 'completed' },
          { id: 'rec-1b', file_type: 'M4A', file_size: 8388608, recording_type: 'audio_only', status: 'completed' }
        ]
      },
      {
        meeting_id: 'mock-2',
        topic: 'Product Review',
        start_time: '2026-02-13T14:00:00Z',
        duration: 45,
        recordings: [
          { id: 'rec-2a', file_type: 'M4A', file_size: 12582912, recording_type: 'audio_only', status: 'completed' }
        ]
      },
      {
        meeting_id: 'mock-3',
        topic: 'Sprint Planning',
        start_time: '2026-02-12T09:00:00Z',
        duration: 60,
        recordings: [
          { id: 'rec-3a', file_type: 'MP4', file_size: 104857600, recording_type: 'shared_screen_with_speaker_view', status: 'completed' }
        ]
      }
    ]);
  }

  const token = await getAccessToken(req.session.userId);
  if (!token) {
    return res.status(401).json({ error: 'Zoom not connected. Please connect your Zoom account.' });
  }

  try {
    // Fetch recordings from last 30 days
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);

    const apiRes = await fetch(`${ZOOM_API_BASE}/users/me/recordings?from=${from}&to=${to}&page_size=30`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!apiRes.ok) {
      if (apiRes.status === 401) {
        return res.status(401).json({ error: 'Zoom token expired. Please reconnect your Zoom account.' });
      }
      return res.status(apiRes.status).json({ error: 'Failed to fetch Zoom recordings.' });
    }

    const data = await apiRes.json();
    const meetings = (data.meetings || []).map(m => ({
      meeting_id: String(m.id),
      topic: m.topic || 'Untitled Meeting',
      start_time: m.start_time,
      duration: m.duration,
      recordings: (m.recording_files || [])
        .filter(r => r.status === 'completed')
        .map(r => ({
          id: r.id,
          file_type: r.file_type,
          file_size: r.file_size,
          recording_type: r.recording_type,
          status: r.status,
          download_url: r.download_url
        }))
    })).filter(m => m.recordings.length > 0);

    res.json(meetings);
  } catch (err) {
    console.error('[zoom] List recordings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Zoom recordings.' });
  }
});

// POST /api/zoom/import — download a Zoom recording, transcribe, save as meeting
router.post('/import', requireAuth, async (req, res) => {
  const { meeting_id, recording_id, topic, start_time } = req.body;

  if (!meeting_id || !recording_id) {
    return res.status(400).json({ error: 'meeting_id and recording_id are required.' });
  }

  // Check meeting storage limit
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.session.userId);
  const plan = (user && user.plan) || 'free';
  const STORAGE_LIMITS = { free: 3, ltd: null, fltd: null, sub_basic: null, sub_pro: null };
  const maxMeetings = STORAGE_LIMITS[plan];
  if (maxMeetings !== null) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM meetings WHERE user_id = ?').get(req.session.userId).cnt;
    if (count >= maxMeetings) {
      return res.status(403).json({ error: 'meeting_limit', message: `Free plan is limited to ${maxMeetings} saved meetings. Upgrade for unlimited storage.` });
    }
  }

  const title = (topic || 'Zoom Meeting') + (start_time ? ' — ' + new Date(start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  let tempFile = null;

  try {
    let transcript;

    if (process.env.MOCK_MODE === 'true') {
      transcript = MOCK_TRANSCRIPT;
    } else {
      // Get access token
      const token = await getAccessToken(req.session.userId);
      if (!token) {
        return res.status(401).json({ error: 'Zoom not connected. Please reconnect your Zoom account.' });
      }

      // Find the recording download URL
      // First fetch the meeting's recordings to get the download URL for this recording_id
      const recRes = await fetch(`${ZOOM_API_BASE}/meetings/${meeting_id}/recordings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!recRes.ok) {
        if (recRes.status === 404) {
          return res.status(404).json({ error: 'Recording not found. It may have been deleted from Zoom.' });
        }
        return res.status(recRes.status).json({ error: 'Failed to fetch recording details from Zoom.' });
      }

      const recData = await recRes.json();
      const file = (recData.recording_files || []).find(r => r.id === recording_id);
      if (!file || !file.download_url) {
        return res.status(404).json({ error: 'Recording file not found.' });
      }

      // Download the recording file — Zoom requires the access token as query param
      const downloadUrl = file.download_url + '?access_token=' + token;
      const downloadRes = await fetch(downloadUrl);

      if (!downloadRes.ok) {
        return res.status(502).json({ error: 'Failed to download recording from Zoom.' });
      }

      // Determine file extension from file_type
      const ext = (file.file_type || 'mp4').toLowerCase() === 'm4a' ? '.m4a' : '.mp4';
      tempFile = path.join(os.tmpdir(), `zoom_${recording_id}_${Date.now()}${ext}`);

      // Stream to temp file
      const fileStream = fs.createWriteStream(tempFile);
      const reader = downloadRes.body.getReader();
      const writer = fileStream;

      // Use pipeline-style writing
      await new Promise((resolve, reject) => {
        const readable = new ReadableStream({
          async start(controller) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { controller.close(); break; }
              controller.enqueue(value);
            }
          }
        });
        const nodeReadable = require('stream').Readable.fromWeb(readable);
        nodeReadable.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // Transcribe with Whisper
      const client = getOpenAI();
      if (!client) {
        return res.status(501).json({ error: 'Transcription service is not available.' });
      }

      const result = await client.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model: 'whisper-1'
      });
      transcript = result.text;
    }

    // Save to database
    const row = db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(req.session.userId, title, transcript, '{"action_items":[],"follow_up_email":""}');

    res.status(201).json({
      ok: true,
      id: row.lastInsertRowid,
      title,
      transcript
    });
  } catch (err) {
    console.error('[zoom] Import error:', err.message);
    res.status(500).json({ error: 'Failed to import and transcribe Zoom recording.' });
  } finally {
    if (tempFile) {
      fs.unlink(tempFile, () => {});
    }
  }
});

module.exports = router;

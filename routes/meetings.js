const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../database');
const requireAuth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { safeJsonParse } = require('../lib/safe-json');

const extractLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }); // 20 per 15min

// Multer: store uploads in OS temp dir, max 25MB (used by /transcribe)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Multer: audio upload with format validation (used by /upload)
const ALLOWED_AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.webm'];
const uploadsDir = path.join(__dirname, '..', 'uploads');
// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const audioUpload = multer({
  dest: uploadsDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_AUDIO_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: mp3, wav, m4a, webm'));
    }
  }
});

// OpenAI client (lazy init like Anthropic)
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

const router = express.Router();

// Only initialize Anthropic if not in mock mode
let anthropic = null;
if (process.env.MOCK_MODE !== 'true') {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
}

const EXTRACT_PROMPT = `You are a meeting notes assistant. Analyze the meeting notes and extract action items and a follow-up email.

CRITICAL: Return ONLY a raw JSON object. No markdown fences, no backticks, no explanation text before or after. Do not wrap in \`\`\`json. Just the JSON object.

Required JSON schema:
{"action_items":[{"task":"...","owner":"...","deadline":"..."}],"follow_up_email":"..."}

Rules:
- "task": what needs to be done
- "owner": who is responsible (use "Unassigned" if unclear)
- "deadline": when it's due (use "Not specified" if unclear)
- "follow_up_email": short professional summary email addressed to "Hi team,"
- If no action items found, return: {"action_items":[],"follow_up_email":""}
- No trailing commas in arrays or objects

Meeting notes:
`;

const MOCK_RESPONSE = {
  action_items: [
    { task: "Finalize Q3 budget proposal and send to finance", owner: "Sarah", deadline: "Wednesday, Feb 12" },
    { task: "Fix authentication bug on staging environment", owner: "John", deadline: "End of day Friday" },
    { task: "Schedule follow-up call with client about onboarding", owner: "Mike", deadline: "Next week" },
    { task: "Update project timeline in shared doc", owner: "Unassigned", deadline: "Not specified" }
  ],
  follow_up_email: "Hi team,\n\nThanks for the productive meeting today. Here's a quick summary of what we discussed and the next steps:\n\n- Sarah will finalize the Q3 budget proposal and send it to finance by Wednesday, Feb 12.\n- John will fix the authentication bug on staging before end of day Friday.\n- Mike will schedule a follow-up call with the client about onboarding next week.\n- We still need someone to update the project timeline in the shared doc — please volunteer if you can take this on.\n\nLet me know if I missed anything or if you have questions.\n\nBest regards"
};

// Plan limits: { lifetime_max, monthly_max }
const PLAN_LIMITS = {
  free:      { lifetime: 5,    monthly: null },
  ltd:       { lifetime: null, monthly: 50 },
  fltd:      { lifetime: null, monthly: 100 },
  sub_basic: { lifetime: null, monthly: 50 },
  sub_pro:   { lifetime: null, monthly: 100 }
};

// Meeting storage limits (separate from extract usage limits)
const MEETING_STORAGE_LIMITS = {
  free: 3,
  ltd: null,       // unlimited
  fltd: null,
  sub_basic: null,
  sub_pro: null
};

function checkMeetingStorageLimit(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const plan = (user && user.plan) || 'free';
  const max = MEETING_STORAGE_LIMITS[plan];

  if (!max) return { allowed: true, plan };

  const count = db.prepare('SELECT COUNT(*) as count FROM meetings WHERE user_id = ?').get(userId).count;
  if (count >= max) {
    return {
      allowed: false,
      plan,
      message: `Free plan allows ${max} saved meetings. Upgrade for unlimited storage.`,
      count,
      max
    };
  }
  return { allowed: true, plan, count, max };
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-02"
}

function checkUsageLimit(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const plan = (user && user.plan) || 'free';
  const limits = PLAN_LIMITS[plan];

  if (!limits) return { allowed: true, plan };

  const month = getCurrentMonth();

  // Ensure usage row exists
  db.prepare(
    'INSERT OR IGNORE INTO usage (user_id, month, extracts) VALUES (?, ?, 0)'
  ).run(userId, month);

  if (limits.lifetime) {
    // Free plan: count ALL extracts ever
    const total = db.prepare(
      'SELECT COALESCE(SUM(extracts), 0) as total FROM usage WHERE user_id = ?'
    ).get(userId).total;

    if (total >= limits.lifetime) {
      return {
        allowed: false,
        plan,
        message: `Free plan limit reached (${limits.lifetime} extracts). Upgrade to continue.`,
        used: total,
        max: limits.lifetime
      };
    }
    return { allowed: true, plan, used: total, max: limits.lifetime };
  }

  if (limits.monthly) {
    // Paid plans: count this month only
    const row = db.prepare(
      'SELECT extracts FROM usage WHERE user_id = ? AND month = ?'
    ).get(userId, month);

    const used = row ? row.extracts : 0;

    if (used >= limits.monthly) {
      return {
        allowed: false,
        plan,
        message: `Monthly limit reached (${limits.monthly} extracts). Resets next month.`,
        used,
        max: limits.monthly
      };
    }
    return { allowed: true, plan, used, max: limits.monthly };
  }

  return { allowed: true, plan };
}

function incrementUsage(userId) {
  const month = getCurrentMonth();
  db.prepare(
    'INSERT INTO usage (user_id, month, extracts) VALUES (?, ?, 1) ON CONFLICT(user_id, month) DO UPDATE SET extracts = extracts + 1'
  ).run(userId, month);
}

const MOCK_TRANSCRIPT = `Team standup — February 8, 2026
Attendees: Sarah, John, Mike, Lisa

Sarah: I wrapped up the landing page redesign yesterday. I'll send it to the client for review by end of day tomorrow.

John: The auth bug on staging is still open. I found the root cause — it's a session timeout issue. I'll have a fix pushed by Friday.

Mike: I spoke with the client about onboarding. They want a walkthrough call next Tuesday. I'll send the calendar invite today.

Lisa: The Q3 metrics dashboard is about 80% done. I need the updated KPI definitions from Sarah before I can finish. Can you send those by Wednesday?

Sarah: Sure, I'll get those over to you by Wednesday morning.

John: One more thing — we need someone to update the deployment docs. They're outdated after the infra migration.

Mike: I can take that. I'll have it done by end of next week.`;

// POST /api/meetings/transcribe — upload audio, get transcript back
router.post('/transcribe', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }

  const tempPath = req.file.path;

  try {
    let transcript;

    if (process.env.MOCK_MODE === 'true') {
      transcript = MOCK_TRANSCRIPT;
    } else {
      // Future: plug in OpenAI Whisper, Deepgram, etc.
      // const transcript = await transcribeWithWhisper(tempPath);
      return res.status(501).json({ error: 'Transcription is not available right now. Please try again later.' });
    }

    res.json({ transcript });
  } catch (err) {
    console.error('Transcribe error:', err.message);
    res.status(500).json({ error: 'Transcription failed' });
  } finally {
    // Clean up temp file
    fs.unlink(tempPath, () => {});
  }
});

// POST /api/meetings/upload — upload audio file, transcribe with Whisper, save meeting
router.post('/upload', requireAuth, (req, res, next) => {
  audioUpload.single('audio')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required. Allowed formats: mp3, wav, m4a' });
  }

  // Check meeting storage limit before doing any work
  const storageLimit = checkMeetingStorageLimit(req.session.userId);
  if (!storageLimit.allowed) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'meeting_limit', message: storageLimit.message });
  }

  const filePath = req.file.path;
  const title = (req.body.title || '').trim() ||
    `Meeting \u2014 ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  try {
    let transcript;

    if (process.env.MOCK_MODE === 'true') {
      transcript = MOCK_TRANSCRIPT;
    } else {
      const client = getOpenAI();
      if (!client) {
        return res.status(501).json({ error: 'Transcription is not available right now. Please try again later.' });
      }

      // Whisper needs the original extension to detect format
      const ext = path.extname(req.file.originalname).toLowerCase() || '.mp3';
      const renamedPath = filePath + ext;
      fs.renameSync(filePath, renamedPath);

      try {
        const result = await client.audio.transcriptions.create({
          file: fs.createReadStream(renamedPath),
          model: 'whisper-1'
        });
        transcript = result.text;
      } finally {
        fs.unlink(renamedPath, () => {});
      }
    }

    // Save to database
    const row = db.prepare(
      'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
    ).run(req.session.userId, title, transcript, '{"action_items":[],"follow_up_email":""}');

    res.status(201).json({
      id: row.lastInsertRowid,
      title,
      transcript
    });
  } catch (err) {
    console.error('Upload/transcribe error:', err.message);
    res.status(500).json({ error: 'Transcription failed. Please try again.' });
  } finally {
    // Clean up original temp file (if it still exists — may have been renamed)
    fs.unlink(filePath, () => {});
  }
});

// POST /api/meetings/extract — send notes to Claude (or mock), return structured data
router.post('/extract', extractLimiter, requireAuth, async (req, res) => {
  const { notes } = req.body;

  if (!notes || notes.trim().length === 0) {
    return res.status(400).json({ error: 'Meeting notes are required' });
  }

  if (notes.length > 50000) {
    return res.status(400).json({ error: 'Notes too long (max 50,000 characters)' });
  }

  // Check usage limit
  const limit = checkUsageLimit(req.session.userId);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'limit_reached', message: limit.message });
  }

  try {
    let result;

    if (process.env.MOCK_MODE === 'true') {
      result = MOCK_RESPONSE;
    } else {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        messages: [
          { role: 'user', content: EXTRACT_PROMPT + notes }
        ]
      });

      const rawText = message.content[0].text;
      try {
        result = safeJsonParse(rawText);
      } catch (parseErr) {
        console.error('[extract] JSON parse failed:', parseErr.message);
        console.error('[extract] Raw model output (first 800 chars):', rawText.slice(0, 800));
        return res.status(500).json({ error: 'Failed to parse AI response' });
      }
    }

    // Increment usage only on success
    incrementUsage(req.session.userId);

    res.json(result);
  } catch (err) {
    console.error('[extract] Error:', err.message);
    res.status(500).json({ error: 'Failed to extract action items' });
  }
});

// POST /api/meetings — save meeting with extracted action items
router.post('/', requireAuth, (req, res) => {
  const { raw_notes, action_items } = req.body;

  if (!raw_notes || !action_items) {
    return res.status(400).json({ error: 'Notes and action items are required' });
  }

  // Check meeting storage limit
  const storageLimit = checkMeetingStorageLimit(req.session.userId);
  if (!storageLimit.allowed) {
    return res.status(403).json({ error: 'meeting_limit', message: storageLimit.message });
  }

  const result = db.prepare(
    'INSERT INTO meetings (user_id, raw_notes, action_items) VALUES (?, ?, ?)'
  ).run(req.session.userId, raw_notes, JSON.stringify(action_items));

  res.status(201).json({
    id: result.lastInsertRowid,
    message: 'Meeting saved'
  });
});

// GET /api/meetings — get all meetings for logged-in user
router.get('/', requireAuth, (req, res) => {
  const meetings = db.prepare(
    'SELECT id, title, raw_notes, action_items, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId);

  const parsed = meetings.map(m => {
    let action_items;
    try { action_items = JSON.parse(m.action_items); } catch { action_items = { action_items: [], follow_up_email: '' }; }
    return { ...m, action_items };
  });

  res.json(parsed);
});

// GET /api/meetings/:id — get a single meeting (must belong to logged-in user)
router.get('/:id', requireAuth, (req, res) => {
  const meeting = db.prepare(
    'SELECT id, title, raw_notes, action_items, created_at FROM meetings WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);

  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  let action_items;
  try { action_items = JSON.parse(meeting.action_items); } catch { action_items = { action_items: [], follow_up_email: '' }; }
  res.json({ ...meeting, action_items });
});

// PATCH /api/meetings/:id/transcript — edit transcript
router.patch('/:id/transcript', requireAuth, (req, res) => {
  const { transcript } = req.body;
  if (typeof transcript !== 'string') {
    return res.status(400).json({ error: 'transcript must be a string' });
  }
  if (transcript.length > 200000) {
    return res.status(400).json({ error: 'Transcript too long (max 200,000 characters)' });
  }

  const result = db.prepare(
    "UPDATE meetings SET raw_notes = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).run(transcript, req.params.id, req.session.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ ok: true });
});

// PATCH /api/meetings/:id/extraction — edit action items + follow-up email
router.patch('/:id/extraction', requireAuth, (req, res) => {
  const { action_items, follow_up_email } = req.body;

  if (!Array.isArray(action_items)) {
    return res.status(400).json({ error: 'action_items must be an array' });
  }
  for (let i = 0; i < action_items.length; i++) {
    const item = action_items[i];
    if (!item || typeof item.task !== 'string' || item.task.trim().length === 0) {
      return res.status(400).json({ error: `action_items[${i}].task is required` });
    }
    if (typeof item.owner !== 'string') item.owner = '';
    if (typeof item.deadline !== 'string') item.deadline = '';
  }
  if (typeof follow_up_email !== 'string') {
    return res.status(400).json({ error: 'follow_up_email must be a string' });
  }

  const payload = JSON.stringify({ action_items, follow_up_email });

  const result = db.prepare(
    "UPDATE meetings SET action_items = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).run(payload, req.params.id, req.session.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ ok: true });
});

// DELETE /api/meetings/:id — delete a meeting (only if owned by user)
router.delete('/:id', requireAuth, (req, res) => {
  const result = db.prepare(
    'DELETE FROM meetings WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.session.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  res.json({ message: 'Meeting deleted' });
});

module.exports = router;

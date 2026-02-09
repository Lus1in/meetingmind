const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../database');
const requireAuth = require('../middleware/auth');

// Multer: store uploads in OS temp dir, max 25MB
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const router = express.Router();

// Only initialize Anthropic if not in mock mode
let anthropic = null;
if (process.env.MOCK_MODE !== 'true') {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
}

const EXTRACT_PROMPT = `You are a meeting notes assistant. Analyze the meeting notes below and extract:

1. **Action items** — each with:
   - "task": what needs to be done
   - "owner": who is responsible (use "Unassigned" if unclear)
   - "deadline": when it's due (use "Not specified" if unclear)

2. **A follow-up email draft** — a short, professional email summarizing the meeting and listing the action items. Address it generically (e.g. "Hi team,").

Respond ONLY with valid JSON in this exact format, no other text:
{
  "action_items": [
    { "task": "...", "owner": "...", "deadline": "..." }
  ],
  "follow_up_email": "..."
}

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

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-02"
}

function checkUsageLimit(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const plan = user.plan || 'free';
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
      return res.status(501).json({ error: 'Transcription provider not configured. Set MOCK_MODE=true or implement a provider.' });
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

// POST /api/meetings/extract — send notes to Claude (or mock), return structured data
router.post('/extract', requireAuth, async (req, res) => {
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
      result = JSON.parse(message.content[0].text);
    }

    // Increment usage only on success
    incrementUsage(req.session.userId);

    res.json(result);
  } catch (err) {
    console.error('Extract error:', err.message);

    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    res.status(500).json({ error: 'Failed to extract action items' });
  }
});

// POST /api/meetings — save meeting with extracted action items
router.post('/', requireAuth, (req, res) => {
  const { raw_notes, action_items } = req.body;

  if (!raw_notes || !action_items) {
    return res.status(400).json({ error: 'Notes and action items are required' });
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
    'SELECT id, raw_notes, action_items, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId);

  const parsed = meetings.map(m => ({
    ...m,
    action_items: JSON.parse(m.action_items)
  }));

  res.json(parsed);
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

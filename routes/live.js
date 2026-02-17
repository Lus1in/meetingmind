/**
 * Live Transcription Routes
 *
 * Architecture: Chunked Whisper + Server-Sent Events (SSE)
 * - Client records mic audio via MediaRecorder, sends 5-second chunks
 * - Server transcribes each chunk with OpenAI Whisper API
 * - Server pushes transcript segments back to client via SSE
 * - On stop: concatenates segments, runs Claude extraction, saves meeting
 *
 * MVP Limitations:
 * - Mic input only (no system/tab audio)
 * - No speaker diarization (Whisper doesn't provide it)
 * - ~5-8s delay per segment (5s chunk + transcription latency)
 * - Provider can be swapped by replacing transcribeChunk()
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../database');
const requireAuth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { safeJsonParse } = require('../lib/safe-json');

const router = express.Router();

// Rate limit: 5 live sessions per 15 minutes
const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

// Multer for audio chunks — temp directory, max 5MB per chunk
const chunkUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Active SSE connections: session_id -> { res, keepaliveTimer }
const activeStreams = new Map();

// ---- OpenAI client (lazy init) ----
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

// ---- Anthropic client (lazy init) ----
let anthropic = null;
function getAnthropic() {
  if (process.env.MOCK_MODE === 'true') return null;
  if (!process.env.CLAUDE_API_KEY) return null;
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  }
  return anthropic;
}

/**
 * Transcribe a single audio chunk file.
 * Abstraction layer — swap provider by changing this function.
 */
async function transcribeChunk(filePath) {
  if (process.env.MOCK_MODE === 'true') {
    return null; // Mock mode handled by caller
  }

  const client = getOpenAI();
  if (!client) {
    throw new Error('Transcription not available — OPENAI_API_KEY not set');
  }

  const result = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1'
  });

  return result.text;
}

// Mock transcript segments for MOCK_MODE
const MOCK_SEGMENTS = [
  "Let's kick off the meeting. Thanks everyone for joining today.",
  "Sarah, can you give us an update on the landing page redesign?",
  "Sure. The redesign is about 90% complete. I need to finalize the mobile breakpoints.",
  "I'll have the mobile responsive version done by Wednesday.",
  "Great. John, what's the status on the authentication bug?",
  "I found the root cause yesterday. It's a session timeout issue on the staging server.",
  "I'll push a fix by end of day Friday at the latest.",
  "Mike, any updates on the client onboarding?",
  "Yes, I spoke with the client this morning. They want a walkthrough call next Tuesday.",
  "I'll send the calendar invite today and prepare a demo deck.",
  "Lisa, how's the Q3 metrics dashboard coming along?",
  "It's about 80% done. I need the updated KPI definitions from Sarah.",
  "Sarah, can you send those KPI definitions to Lisa by Wednesday?",
  "Absolutely, I'll get those over first thing Wednesday morning.",
  "One more thing — we need to update the deployment docs after the infrastructure migration.",
  "I can take that. I'll have the docs updated by end of next week.",
  "Perfect. Let's also discuss the follow-up from our last meeting about the API rate limits.",
  "Right, as discussed previously, we agreed to implement tiered rate limiting.",
  "I'll create the implementation plan and share it by Thursday.",
  "Alright, great progress everyone. Let's wrap up. Talk to you all next week."
];
let mockSegmentIndex = 0;

// ---- Meeting storage limit check (reused from meetings.js pattern) ----
const MEETING_STORAGE_LIMITS = {
  free: 3, ltd: null, fltd: null, sub_basic: null, sub_pro: null
};

function checkMeetingStorageLimit(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const plan = (user && user.plan) || 'free';
  const max = MEETING_STORAGE_LIMITS[plan];
  if (!max) return { allowed: true, plan };
  const count = db.prepare('SELECT COUNT(*) as count FROM meetings WHERE user_id = ?').get(userId).count;
  if (count >= max) {
    return { allowed: false, plan, message: `Free plan allows ${max} saved meetings. Upgrade for unlimited storage.` };
  }
  return { allowed: true, plan };
}

// ---- Keyword extraction (reused from meetings.js for memory hints) ----
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what',
  'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'about', 'above', 'after', 'again', 'also', 'am', 'any', 'as',
  'because', 'before', 'between', 'from', 'get', 'got', 'if', 'into',
  'new', 'now', 'out', 'over', 'then', 'there', 'through', 'time',
  'up', 'want', 'well', 'went', 'need', 'know', 'like', 'going',
  'think', 'make', 'said', 'look', 'come', 'let', 'still', 'll',
  're', 've', 'don', 'didn', 'won', 'isn', 'aren', 'doesn', 'wasn'
]);

function extractKeywords(text) {
  const words = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
}

// ---- Extraction prompt (same as meetings.js) ----
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

const MOCK_EXTRACTION = {
  action_items: [
    { task: "Finalize mobile responsive landing page", owner: "Sarah", deadline: "Wednesday" },
    { task: "Fix session timeout authentication bug on staging", owner: "John", deadline: "End of day Friday" },
    { task: "Send calendar invite for client walkthrough call", owner: "Mike", deadline: "Today" },
    { task: "Prepare demo deck for client onboarding", owner: "Mike", deadline: "Next Tuesday" },
    { task: "Send KPI definitions to Lisa", owner: "Sarah", deadline: "Wednesday morning" },
    { task: "Update deployment docs after infra migration", owner: "Unassigned", deadline: "End of next week" },
    { task: "Create tiered rate limiting implementation plan", owner: "Unassigned", deadline: "Thursday" }
  ],
  follow_up_email: "Hi team,\n\nThanks for the productive meeting today. Here's a summary of our action items:\n\n- Sarah: Finalize mobile responsive landing page by Wednesday, and send KPI definitions to Lisa by Wednesday morning.\n- John: Fix the session timeout auth bug on staging by end of day Friday.\n- Mike: Send calendar invite for client walkthrough call today and prepare a demo deck for next Tuesday.\n- Deployment docs need updating after the infra migration — please volunteer if you can take this by end of next week.\n- Tiered rate limiting implementation plan to be shared by Thursday.\n\nLet me know if I missed anything.\n\nBest regards"
};

// ---- Push segment to SSE client ----
function pushSegment(sessionId, segment) {
  const stream = activeStreams.get(sessionId);
  if (stream && stream.res && !stream.res.writableEnded) {
    stream.res.write(`data: ${JSON.stringify(segment)}\n\n`);
  }
}

function pushEvent(sessionId, event, data) {
  const stream = activeStreams.get(sessionId);
  if (stream && stream.res && !stream.res.writableEnded) {
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ---- Validate session ownership ----
function getOwnedSession(sessionId, userId) {
  return db.prepare(
    'SELECT * FROM live_sessions WHERE id = ? AND user_id = ?'
  ).get(sessionId, userId);
}

// ================================================================
// POST /api/live/start — Create a new live session
// ================================================================
router.post('/start', startLimiter, requireAuth, (req, res) => {
  const userId = req.session.userId;
  const title = (req.body.title || '').trim() ||
    `Live Meeting — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const participants = (req.body.participants || '').trim();

  // Check meeting storage limit
  const storageLimit = checkMeetingStorageLimit(userId);
  if (!storageLimit.allowed) {
    return res.status(403).json({ error: 'meeting_limit', message: storageLimit.message });
  }

  // Check for existing active session (one at a time)
  const existing = db.prepare(
    'SELECT id FROM live_sessions WHERE user_id = ? AND status = ?'
  ).get(userId, 'active');
  if (existing) {
    return res.status(409).json({
      error: 'session_active',
      message: 'You already have an active live session.',
      session_id: existing.id
    });
  }

  const result = db.prepare(
    'INSERT INTO live_sessions (user_id, title, participants) VALUES (?, ?, ?)'
  ).run(userId, title, participants || null);

  // Reset mock segment index for this session
  mockSegmentIndex = 0;

  res.status(201).json({ session_id: result.lastInsertRowid, title });
});

// ================================================================
// GET /api/live/:id/stream — SSE endpoint for transcript segments
// ================================================================
router.get('/:id/stream', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = getOwnedSession(sessionId, req.session.userId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.status !== 'active') {
    return res.status(400).json({ error: 'Session is not active' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);

  // Keepalive every 15 seconds
  const keepaliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15000);

  // Store connection
  activeStreams.set(sessionId, { res, keepaliveTimer });

  // Send any existing segments (for reconnection)
  const existing = db.prepare(
    'SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY segment_index ASC'
  ).all(sessionId);
  for (const seg of existing) {
    res.write(`data: ${JSON.stringify({
      segment_index: seg.segment_index,
      text: seg.text,
      timestamp_ms: seg.timestamp_ms,
      speaker: seg.speaker,
      is_final: !!seg.is_final
    })}\n\n`);
  }

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(keepaliveTimer);
    activeStreams.delete(sessionId);
  });
});

// ================================================================
// POST /api/live/:id/chunk — Receive and transcribe an audio chunk
// ================================================================
router.post('/:id/chunk', requireAuth, chunkUpload.single('audio'), async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = getOwnedSession(sessionId, req.session.userId);

  if (!session) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.status !== 'active') {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Session is not active' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Audio chunk is required' });
  }

  const tempPath = req.file.path;
  const timestampMs = parseInt(req.body.timestamp_ms) || Date.now();

  try {
    let text;

    if (process.env.MOCK_MODE === 'true') {
      // Simulate transcription with mock segments
      text = MOCK_SEGMENTS[mockSegmentIndex % MOCK_SEGMENTS.length];
      mockSegmentIndex++;
    } else {
      // Whisper needs a file extension to detect format
      const ext = '.webm';
      const renamedPath = tempPath + ext;
      fs.renameSync(tempPath, renamedPath);

      try {
        text = await transcribeChunk(renamedPath);
      } finally {
        fs.unlink(renamedPath, () => {});
      }
    }

    if (!text || text.trim().length === 0) {
      // Silent chunk — no speech detected
      return res.json({ ok: true, segment_index: null, silent: true });
    }

    // Get next segment index
    const lastSeg = db.prepare(
      'SELECT MAX(segment_index) as max_idx FROM transcript_segments WHERE session_id = ?'
    ).get(sessionId);
    const segmentIndex = (lastSeg && lastSeg.max_idx !== null) ? lastSeg.max_idx + 1 : 0;

    // Insert segment
    db.prepare(
      'INSERT INTO transcript_segments (session_id, segment_index, text, timestamp_ms, speaker, is_final) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(sessionId, segmentIndex, text.trim(), timestampMs, 'Speaker', 1);

    const segment = {
      segment_index: segmentIndex,
      text: text.trim(),
      timestamp_ms: timestampMs,
      speaker: 'Speaker',
      is_final: true
    };

    // Push to SSE client
    pushSegment(sessionId, segment);

    res.json({ ok: true, segment_index: segmentIndex });
  } catch (err) {
    console.error('[live/chunk] Transcription error:', err.message);
    res.status(500).json({ error: 'Transcription failed for this chunk' });
  } finally {
    // Clean up original temp file (may have been renamed already)
    fs.unlink(tempPath, () => {});
  }
});

// ================================================================
// POST /api/live/:id/stop — Stop session, extract, save meeting
// ================================================================
router.post('/:id/stop', requireAuth, async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = getOwnedSession(sessionId, req.session.userId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.status !== 'active') {
    return res.status(400).json({ error: 'Session is not active' });
  }

  // Close SSE connection
  pushEvent(sessionId, 'stopped', { session_id: sessionId });
  const stream = activeStreams.get(sessionId);
  if (stream) {
    clearInterval(stream.keepaliveTimer);
    if (!stream.res.writableEnded) stream.res.end();
    activeStreams.delete(sessionId);
  }

  // Concatenate all segments into full transcript
  const segments = db.prepare(
    'SELECT text, timestamp_ms, speaker FROM transcript_segments WHERE session_id = ? ORDER BY segment_index ASC'
  ).all(sessionId);

  if (segments.length === 0) {
    // No transcript — mark failed
    db.prepare(
      "UPDATE live_sessions SET status = 'failed', ended_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
    return res.json({ meeting_id: null, message: 'No transcript was captured.' });
  }

  const fullTranscript = segments.map(s => s.text).join('\n\n');
  const title = session.title || `Live Meeting — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // Run extraction
  let extraction;
  try {
    if (process.env.MOCK_MODE === 'true') {
      extraction = MOCK_EXTRACTION;
    } else {
      const client = getAnthropic();
      if (!client) {
        extraction = { action_items: [], follow_up_email: '' };
      } else {
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          messages: [{ role: 'user', content: EXTRACT_PROMPT + fullTranscript }]
        });
        try {
          extraction = safeJsonParse(message.content[0].text);
        } catch (parseErr) {
          console.error('[live/stop] Extraction parse failed:', parseErr.message);
          extraction = { action_items: [], follow_up_email: '' };
        }
      }
    }
  } catch (err) {
    console.error('[live/stop] Extraction error:', err.message);
    extraction = { action_items: [], follow_up_email: '' };
  }

  // Save as meeting
  const meetingResult = db.prepare(
    'INSERT INTO meetings (user_id, title, raw_notes, action_items) VALUES (?, ?, ?, ?)'
  ).run(req.session.userId, title, fullTranscript, JSON.stringify(extraction));

  const meetingId = meetingResult.lastInsertRowid;

  // Update live session
  db.prepare(
    "UPDATE live_sessions SET status = 'completed', ended_at = datetime('now'), meeting_id = ? WHERE id = ?"
  ).run(meetingId, sessionId);

  res.json({ meeting_id: meetingId, title });
});

// ================================================================
// GET /api/live/:id/status — Get session status
// ================================================================
router.get('/:id/status', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = getOwnedSession(sessionId, req.session.userId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const segCount = db.prepare(
    'SELECT COUNT(*) as count FROM transcript_segments WHERE session_id = ?'
  ).get(sessionId);

  res.json({
    session_id: session.id,
    status: session.status,
    title: session.title,
    started_at: session.started_at,
    ended_at: session.ended_at,
    meeting_id: session.meeting_id,
    segment_count: segCount.count
  });
});

// ================================================================
// POST /api/live/:id/memory-hints — Cross-meeting recall during live
// ================================================================
router.post('/:id/memory-hints', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = getOwnedSession(sessionId, req.session.userId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Get recent segments (last ~2 minutes worth, roughly last 20-24 segments at 5s each)
  const recentSegments = db.prepare(
    'SELECT text FROM transcript_segments WHERE session_id = ? ORDER BY segment_index DESC LIMIT 24'
  ).all(sessionId);

  if (recentSegments.length === 0) {
    return res.json({ hints: [] });
  }

  const recentText = recentSegments.map(s => s.text).join(' ').toLowerCase();
  const keywords = extractKeywords(recentText);

  if (keywords.length === 0) {
    return res.json({ hints: [] });
  }

  // Get past meetings for this user (not from the current live session)
  const pastMeetings = db.prepare(
    'SELECT id, title, raw_notes, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.session.userId);

  const hints = [];
  for (const meeting of pastMeetings) {
    const meetingText = (meeting.raw_notes || '').toLowerCase();
    const meetingKeywords = extractKeywords(meetingText);
    const shared = keywords.filter(w => meetingKeywords.includes(w));

    if (shared.length >= 2) {
      // Find a relevant snippet (first sentence containing a shared keyword)
      const sentences = meeting.raw_notes.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
      let snippet = '';
      for (const s of sentences) {
        const lower = s.toLowerCase();
        if (shared.some(w => lower.includes(w))) {
          snippet = s.trim().substring(0, 150);
          if (s.trim().length > 150) snippet += '...';
          break;
        }
      }

      hints.push({
        meeting_id: meeting.id,
        title: meeting.title || 'Untitled Meeting',
        date: meeting.created_at,
        shared_topics: shared.slice(0, 4),
        snippet: snippet || meeting.raw_notes.substring(0, 100) + '...'
      });
    }

    if (hints.length >= 3) break;
  }

  res.json({ hints });
});

module.exports = router;

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// Ensure feedback uploads directory exists
const feedbackUploadsDir = path.join(__dirname, '..', 'uploads', 'feedback');
if (!fs.existsSync(feedbackUploadsDir)) fs.mkdirSync(feedbackUploadsDir, { recursive: true });

// Multer for screenshot upload
const ALLOWED_IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const screenshotUpload = multer({
  dest: feedbackUploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMG_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Allowed: png, jpg, jpeg, webp, gif'));
    }
  }
});

// ---- USER SUBMIT ----
// POST /api/feedback
router.post('/', requireAuth, (req, res) => {
  screenshotUpload.single('screenshot')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, error: 'Screenshot too large (max 2MB)' });
      }
      return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
    }

    try {
      const { category, severity, message, page_url } = req.body;

      // Validate category
      const validCategories = ['feature', 'bug', 'other'];
      if (!category || !validCategories.includes(category)) {
        cleanupFile(req.file);
        return res.status(400).json({ ok: false, error: 'Category must be feature, bug, or other' });
      }

      // Validate severity
      const validSeverities = ['low', 'medium', 'high'];
      if (!severity || !validSeverities.includes(severity)) {
        cleanupFile(req.file);
        return res.status(400).json({ ok: false, error: 'Severity must be low, medium, or high' });
      }

      // Validate message
      const trimmedMsg = (message || '').trim();
      if (trimmedMsg.length < 5) {
        cleanupFile(req.file);
        return res.status(400).json({ ok: false, error: 'Message must be at least 5 characters' });
      }
      if (trimmedMsg.length > 4000) {
        cleanupFile(req.file);
        return res.status(400).json({ ok: false, error: 'Message too long (max 4000 characters)' });
      }

      // Get user email
      const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
      const userEmail = user ? user.email : null;

      // Handle screenshot: rename to safe filename
      let screenshotPath = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
        const safeName = `feedback_${Date.now()}_${req.session.userId}${ext}`;
        const newPath = path.join(feedbackUploadsDir, safeName);
        fs.renameSync(req.file.path, newPath);
        screenshotPath = safeName;
      }

      const result = db.prepare(`
        INSERT INTO feedback (user_id, user_email, category, severity, message, screenshot_path, user_agent, page_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.session.userId,
        userEmail,
        category,
        severity,
        trimmedMsg,
        screenshotPath,
        req.headers['user-agent'] || null,
        (page_url || '').slice(0, 2000) || null
      );

      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
      cleanupFile(req.file);
      console.error('[feedback] Submit error:', e.message);
      res.status(500).json({ ok: false, error: 'Failed to submit feedback' });
    }
  });
});

function cleanupFile(file) {
  if (file && file.path) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

// ---- ADMIN ROUTES ----

// GET /api/feedback/admin — list all feedback
router.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const { status, category, severity, q } = req.query;

  let sql = 'SELECT id, user_id, user_email, category, severity, message, screenshot_path, user_agent, page_url, status, created_at FROM feedback WHERE 1=1';
  const params = [];

  if (status && ['new', 'reviewed', 'closed'].includes(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (category && ['feature', 'bug', 'other'].includes(category)) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (severity && ['low', 'medium', 'high'].includes(severity)) {
    sql += ' AND severity = ?';
    params.push(severity);
  }
  if (q && q.trim()) {
    sql += ' AND (message LIKE ? OR user_email LIKE ?)';
    const term = `%${q.trim()}%`;
    params.push(term, term);
  }

  sql += ' ORDER BY created_at DESC LIMIT 200';

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// PATCH /api/feedback/admin/:id — update status
router.patch('/admin/:id', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!status || !['new', 'reviewed', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be new, reviewed, or closed' });
  }

  const result = db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Feedback not found' });
  }
  res.json({ ok: true });
});

// DELETE /api/feedback/admin/:id — delete feedback + screenshot
router.delete('/admin/:id', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT screenshot_path FROM feedback WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Feedback not found' });
  }

  // Delete screenshot file if exists
  if (row.screenshot_path) {
    const filePath = path.join(feedbackUploadsDir, row.screenshot_path);
    try { fs.unlinkSync(filePath); } catch {}
  }

  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/feedback/admin/:id/screenshot — serve screenshot (admin only)
router.get('/admin/:id/screenshot', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT screenshot_path FROM feedback WHERE id = ?').get(req.params.id);
  if (!row || !row.screenshot_path) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }

  const filePath = path.join(feedbackUploadsDir, row.screenshot_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Screenshot file missing' });
  }

  res.sendFile(filePath);
});

module.exports = router;

/**
 * Simple in-memory rate limiter middleware.
 *
 * Usage:
 *   const rateLimit = require('./middleware/rateLimit');
 *   router.post('/signup', rateLimit({ windowMs: 15*60*1000, max: 10 }), handler);
 *
 * Known limitation: state resets on server restart. Fine for beta.
 * Replace with Redis-backed limiter if horizontal scaling is needed.
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();

  // Periodic cleanup to prevent memory leak
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref(); // Don't keep process alive for cleanup

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count++;

    if (entry.count > max) {
      return res.status(429).json({
        error: 'Too many requests. Please wait a few minutes and try again.'
      });
    }

    next();
  };
}

module.exports = createRateLimiter;

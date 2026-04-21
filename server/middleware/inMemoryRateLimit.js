/**
 * In-memory IP-based rate limiter factory.
 * Usage: makeRateLimit({ max, windowMs, message })
 */
function makeRateLimit({ max, windowMs, message }) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const window = (hits.get(ip) || []).filter((t) => now - t < windowMs);

    if (window.length >= max) {
      hits.set(ip, window);
      return res.status(429).json({ error: message });
    }

    window.push(now);
    hits.set(ip, window);

    // Opportunistic cleanup to prevent unbounded growth
    if (hits.size > 10000) {
      for (const [k, v] of hits) {
        if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
    }

    next();
  };
}

module.exports = makeRateLimit;

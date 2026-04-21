# Backend Optimization & Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Wavecrest Pro backend with brute-force protection on auth, rate-limit enforcement in the v1 API, input validation (enums, dates, URLs), Stripe webhook dedup, correlation IDs, admin logging, and Discord retry logic.

**Architecture:** Two new shared middleware files (`validate.js`, `inMemoryRateLimit.js`) consumed across route files. Correlation ID threaded via `X-Request-ID`. Stripe event IDs deduplicated in-memory with a 25-hour TTL. Discord sends wrapped with exponential backoff (3 attempts).

**Tech Stack:** Node.js + Express, existing `pg` pool, zero new npm dependencies.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/middleware/validate.js` | Enum, date, URL, numeric-ID validators |
| Create | `server/middleware/inMemoryRateLimit.js` | Generic sliding-window IP rate-limiter factory |
| Create | `server/middleware/correlationId.js` | Attach X-Request-ID to every request/response |
| Modify | `server/routes/auth.js` | Login (5/15 min) + signup (1/hr) rate limits |
| Modify | `server/routes/feedback.js` | Rate limit submit (5/hr), validate page_url, Discord retry |
| Modify | `server/routes/trends.js` | Validate platform/score enums, date format |
| Modify | `server/routes/analytics.js` | Validate platform/score enums |
| Modify | `server/routes/v1.js` | Enforce DB rate limit (call checkRateLimit, return 429) + offset/q bounds |
| Modify | `server/routes/dashboard.js` | Validate trend_id numeric, Discord retry |
| Modify | `server/routes/stripe.js` | In-memory event-ID dedup for webhook |
| Modify | `server/routes/admin.js` | Log IP + path on every access attempt |
| Modify | `server/index.js` | Mount correlationId middleware, fix empty startup warning |

---

### Task 1: Validation helpers middleware

**Files:**
- Create: `server/middleware/validate.js`

- [ ] **Step 1: Create the file**

```javascript
// server/middleware/validate.js
const VALID_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'reddit', 'all'];
const VALID_SCORES    = ['hot', 'rising', 'warm'];
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE          = /^https?:\/\//;

function assertPlatform(val) {
  if (val && !VALID_PLATFORMS.includes(val))
    return `platform must be one of: ${VALID_PLATFORMS.join(', ')}`;
}
function assertScore(val) {
  if (val && !VALID_SCORES.includes(val))
    return `score must be one of: ${VALID_SCORES.join(', ')}`;
}
function assertDate(val) {
  if (val && !DATE_RE.test(val))
    return 'date must be YYYY-MM-DD';
}
function assertPageUrl(val) {
  if (!val) return;
  if (!URL_RE.test(val)) return 'page_url must be a valid http/https URL';
  if (val.length > 2048) return 'page_url too long (max 2048 chars)';
}
function assertNumericId(val, label) {
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) return `${label} must be a positive integer`;
}

module.exports = { assertPlatform, assertScore, assertDate, assertPageUrl, assertNumericId };
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "const v = require('./server/middleware/validate'); console.log(v.assertPlatform('myspace'))"
```
Expected: `platform must be one of: youtube, tiktok, instagram, reddit, all`

```bash
node -e "const v = require('./server/middleware/validate'); console.log(v.assertPlatform('youtube'))"
```
Expected: `undefined`

- [ ] **Step 3: Commit**

```bash
git add server/middleware/validate.js
git commit -m "feat: add shared input validation helpers"
```

---

### Task 2: In-memory sliding-window rate limiter factory

**Files:**
- Create: `server/middleware/inMemoryRateLimit.js`

- [ ] **Step 1: Create the file**

```javascript
// server/middleware/inMemoryRateLimit.js
//
// Returns an Express middleware that enforces a per-IP sliding window.
// Usage: makeRateLimit({ max: 5, windowMs: 15 * 60 * 1000 })

function makeRateLimit({ max, windowMs, message = 'Too many requests. Try again later.' }) {
  const hits = new Map();

  function cleanup(now) {
    if (hits.size > 10000) {
      for (const [ip, times] of hits) {
        if (!times.some(t => now - t < windowMs)) hits.delete(ip);
      }
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const times = (hits.get(ip) || []).filter(t => now - t < windowMs);
    cleanup(now);

    if (times.length >= max) {
      hits.set(ip, times);
      const retryAfter = Math.ceil((times[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    times.push(now);
    hits.set(ip, times);
    next();
  };
}

module.exports = makeRateLimit;
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "const f = require('./server/middleware/inMemoryRateLimit'); const mw = f({ max: 3, windowMs: 60000 }); console.log(typeof mw)"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add server/middleware/inMemoryRateLimit.js
git commit -m "feat: generic in-memory sliding-window rate limiter factory"
```

---

### Task 3: Login and signup brute-force protection

**Files:**
- Modify: `server/routes/auth.js`

Rate limits:
- Login: 5 attempts per 15 minutes per IP
- Signup: 1 attempt per hour per IP

- [ ] **Step 1: Add require and limiter instances near top of auth.js**

Find this line near the top of auth.js:
```javascript
const bcrypt = require('bcryptjs');
```

Add immediately after it:
```javascript
const makeRateLimit = require('../middleware/inMemoryRateLimit');
const loginRateLimit  = makeRateLimit({ max: 5,  windowMs: 15 * 60 * 1000, message: 'Too many login attempts. Try again in 15 minutes.' });
const signupRateLimit = makeRateLimit({ max: 1,  windowMs: 60 * 60 * 1000, message: 'Only one sign-up attempt per hour per IP. Try again later.' });
```

- [ ] **Step 2: Apply loginRateLimit to the /login route**

Find:
```javascript
router.post('/login', async (req, res) => {
```

Replace with:
```javascript
router.post('/login', loginRateLimit, async (req, res) => {
```

- [ ] **Step 3: Apply signupRateLimit to the /signup route**

Find:
```javascript
router.post('/signup', async (req, res) => {
```

Replace with:
```javascript
router.post('/signup', signupRateLimit, async (req, res) => {
```

- [ ] **Step 4: Test login rate limit**

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"x@x.com","password":"badpassword"}'
done
```
Expected: first 5 return 401 (invalid credentials), 6th returns 429.

- [ ] **Step 5: Test signup rate limit**

```bash
for i in 1 2; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/signup \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"test${i}_rl@x.com\",\"password\":\"password123\"}"
done
```
Expected: first returns 201 (or 409), second returns 429.

- [ ] **Step 6: Commit**

```bash
git add server/routes/auth.js
git commit -m "feat: brute-force rate limiting — login 5/15min, signup 1/hr per IP"
```

---

### Task 4: Feedback rate limiting + page_url validation

**Files:**
- Modify: `server/routes/feedback.js`

- [ ] **Step 1: Add imports at the top of feedback.js**

Find:
```javascript
const { requireAuth } = require('../middleware/requireAuth');
const router  = express.Router();
```

Add immediately after the `router` line:
```javascript
const makeRateLimit = require('../middleware/inMemoryRateLimit');
const { assertPageUrl } = require('../middleware/validate');

const feedbackRateLimit = makeRateLimit({ max: 5, windowMs: 60 * 60 * 1000, message: 'Too many feedback submissions. Try again in an hour.' });
```

- [ ] **Step 2: Apply rate limit and page_url check to /submit**

Find:
```javascript
router.post('/submit', async (req, res) => {
  try {
    const { type, title, body, page_url } = req.body;
```

Replace with:
```javascript
router.post('/submit', feedbackRateLimit, async (req, res) => {
  try {
    const { type, title, body, page_url } = req.body;
    const urlErr = assertPageUrl(page_url);
    if (urlErr) return res.status(400).json({ error: urlErr });
```

- [ ] **Step 3: Test rate limit**

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/feedback/submit \
    -H 'Content-Type: application/json' \
    -d '{"type":"bug","title":"test bug report"}'
done
```
Expected: first 5 return 201, 6th returns 429.

- [ ] **Step 4: Test page_url validation**

```bash
curl -s -X POST http://localhost:3000/api/feedback/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"test","page_url":"javascript:alert(1)"}' | jq .
```
Expected: `{"error":"page_url must be a valid http/https URL"}`

- [ ] **Step 5: Commit**

```bash
git add server/routes/feedback.js
git commit -m "feat: rate limit feedback submit (5/hr/IP), validate page_url scheme"
```

---

### Task 5: v1 API rate limit enforcement + input bounds

**Files:**
- Modify: `server/routes/v1.js`

`requireApiKey` currently checks the plan limit to decide whether to allow access at all, but never calls `db.checkRateLimit` to enforce the daily count. Also, `offset` has no upper bound and `q` has no max length.

- [ ] **Step 1: Enforce daily rate limit inside requireApiKey**

Find in `requireApiKey`:
```javascript
  req.apiUser = user;
  req.apiLimit = limit;
  next();
}
```

Replace with:
```javascript
  const { allowed, remaining, used } = await db.checkRateLimit(user.id, user.plan);
  res.set('X-RateLimit-Limit',     limit === -1 ? 'unlimited' : String(limit));
  res.set('X-RateLimit-Remaining', String(remaining));

  if (!allowed) {
    return res.status(429).json({
      error: 'Daily API rate limit exceeded.',
      plan: user.plan,
      limit,
      used,
      upgrade_url: 'https://wavecrest.pro/checkout?plan=pro',
    });
  }

  req.apiUser = user;
  req.apiLimit = limit;
  next();
}
```

- [ ] **Step 2: Add offset upper bound and q max-length to the /trends route**

Find in the `/trends` handler:
```javascript
    const parsedLimit  = Math.max(1, Math.min(parseInt(limit,  10) || 30, 100));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);
```

Replace with:
```javascript
    const parsedLimit  = Math.max(1, Math.min(parseInt(limit,  10) || 30, 100));
    const parsedOffset = Math.max(0, Math.min(parseInt(offset, 10) || 0, 10000));
```

- [ ] **Step 3: Add q max-length to the /trends/search route**

Find in the `/trends/search` handler:
```javascript
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters.' });
```

Replace with:
```javascript
    if (!q || q.trim().length < 2)   return res.status(400).json({ error: 'Query must be at least 2 characters.' });
    if (q.trim().length > 200)        return res.status(400).json({ error: 'Query too long (max 200 characters).' });
```

- [ ] **Step 4: Test rate limit headers appear**

```bash
curl -s -I "http://localhost:3000/api/v1/trends?api_key=INVALID"
```
Expected: 401. Then with a real key:
```bash
curl -s -I "http://localhost:3000/api/v1/trends" -H 'Authorization: Bearer <real-key>'
```
Expected: response includes `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

- [ ] **Step 5: Test offset bound**

```bash
curl -s "http://localhost:3000/api/v1/trends?api_key=<key>&offset=99999" | jq .offset
```
Expected: `10000` (clamped).

- [ ] **Step 6: Test q max-length**

```bash
curl -s "http://localhost:3000/api/v1/trends/search?api_key=<key>&q=$(python3 -c 'print("a"*201)')" | jq .error
```
Expected: `"Query too long (max 200 characters)."`

- [ ] **Step 7: Commit**

```bash
git add server/routes/v1.js
git commit -m "feat: enforce DB rate limit in v1 API, clamp offset ≤10000, q ≤200 chars"
```

---

### Task 6: Correlation ID middleware

**Files:**
- Create: `server/middleware/correlationId.js`
- Modify: `server/index.js`

- [ ] **Step 1: Create the middleware**

```javascript
// server/middleware/correlationId.js
const { randomUUID } = require('crypto');

function correlationId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.correlationId = id;
  res.set('X-Request-ID', id);
  next();
}

module.exports = correlationId;
```

- [ ] **Step 2: Add require in server/index.js**

Find the require block near the top of index.js. After:
```javascript
const { requireAuth } = require('./middleware/requireAuth');
```

Add:
```javascript
const correlationId = require('./middleware/correlationId');
```

- [ ] **Step 3: Mount before routes in server/index.js**

Find:
```javascript
// ── API routes ────────────────────────────────────────
```

Add immediately before it:
```javascript
// ── Correlation ID (must be before routes so req.correlationId is always set) ──
app.use(correlationId);
```

- [ ] **Step 4: Update global error handler to include correlation ID**

Find:
```javascript
app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});
```

Replace with:
```javascript
app.use((err, req, res, _next) => {
  const id = req.correlationId || 'unknown';
  console.error(`[Error] [${id}]`, err.stack || err.message);
  res.status(500).json({ error: 'Internal server error', request_id: id });
});
```

- [ ] **Step 5: Test correlation ID echoed**

Restart server, then:
```bash
curl -s -I http://localhost:3000/api/health
```
Expected: response includes `X-Request-ID: <some-uuid>`.

```bash
curl -s -I http://localhost:3000/api/health -H 'X-Request-ID: my-trace-id-123'
```
Expected: `X-Request-ID: my-trace-id-123` (echoed back).

- [ ] **Step 6: Commit**

```bash
git add server/middleware/correlationId.js server/index.js
git commit -m "feat: X-Request-ID correlation ID middleware, threaded into error handler"
```

---

### Task 7: Stripe webhook idempotency

**Files:**
- Modify: `server/routes/stripe.js`

- [ ] **Step 1: Add event dedup helpers near the top of stripe.js (after the PLANS config)**

Find:
```javascript
// ── POST /api/stripe/create-checkout — start a subscription ──
```

Add before it:
```javascript
// In-memory dedup: Stripe retries up to 3 days; keep IDs for 25 hours.
const processedEvents = new Map();
const EVENT_TTL_MS    = 25 * 60 * 60 * 1000;

function isEventProcessed(eventId) {
  const ts = processedEvents.get(eventId);
  if (!ts) return false;
  if (Date.now() - ts > EVENT_TTL_MS) { processedEvents.delete(eventId); return false; }
  return true;
}

function markEventProcessed(eventId) {
  processedEvents.set(eventId, Date.now());
  if (processedEvents.size > 5000) {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [id, ts] of processedEvents) {
      if (ts < cutoff) processedEvents.delete(id);
    }
  }
}
```

- [ ] **Step 2: Apply dedup check in the webhook handler**

Inside the webhook route, after `event` is constructed and before the `try { switch (event.type)` block, find:
```javascript
  try {
    switch (event.type) {
```

Add immediately before it:
```javascript
    if (isEventProcessed(event.id)) {
      console.log(`[Stripe Webhook] Duplicate event ${event.id} — skipping.`);
      return res.json({ received: true });
    }
    markEventProcessed(event.id);
```

- [ ] **Step 3: Verify dedup logic works standalone**

```bash
node -e "
const processedEvents = new Map();
const EVENT_TTL_MS = 25 * 60 * 60 * 1000;
function isEventProcessed(id) {
  const ts = processedEvents.get(id);
  if (!ts) return false;
  if (Date.now() - ts > EVENT_TTL_MS) { processedEvents.delete(id); return false; }
  return true;
}
function markEventProcessed(id) { processedEvents.set(id, Date.now()); }
markEventProcessed('evt_test_123');
console.log(isEventProcessed('evt_test_123')); // true
console.log(isEventProcessed('evt_test_456')); // false
"
```
Expected: `true` then `false`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat: dedup Stripe webhook events by event ID (25h in-memory TTL)"
```

---

### Task 8: Admin access attempt logging

**Files:**
- Modify: `server/routes/admin.js`

- [ ] **Step 1: Update requireAdmin to log every attempt**

Find:
```javascript
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin access not configured. Set ADMIN_SECRET env var.' });
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}
```

Replace with:
```javascript
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  const ip     = req.ip || req.connection?.remoteAddress || 'unknown';
  const route  = `${req.method} ${req.path}`;

  if (!secret) {
    console.warn(`[Admin] ${route} from ${ip} — ADMIN_SECRET not configured`);
    return res.status(503).json({ error: 'Admin access not configured. Set ADMIN_SECRET env var.' });
  }
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (provided !== secret) {
    console.warn(`[Admin] Unauthorized attempt: ${route} from ${ip}`);
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  console.log(`[Admin] Access granted: ${route} from ${ip}`);
  next();
}
```

- [ ] **Step 2: Test logging**

Restart server, then:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/admin/stats
```
Expected: 503. Server console should print: `[Admin] GET /stats from ::1 — ADMIN_SECRET not configured`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/admin/stats \
  -H 'X-Admin-Secret: wrongvalue'
```
Expected: 401. Server console should print: `[Admin] Unauthorized attempt: GET /stats from ::1`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin.js
git commit -m "feat: log all admin access attempts (IP + route + outcome)"
```

---

### Task 9: Discord retry with exponential backoff

**Files:**
- Modify: `server/routes/dashboard.js`
- Modify: `server/routes/feedback.js`

Both files have a Discord send helper that fails on the first error with no retry.

- [ ] **Step 1: Replace sendDiscordMessage in dashboard.js**

Find:
```javascript
async function sendDiscordMessage(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord error ${res.status}: ${text}`);
  }
}
```

Replace with:
```javascript
async function sendDiscordMessage(webhookUrl, payload) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1)));
    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) return;
      const text = await r.text();
      lastErr = new Error(`Discord error ${r.status}: ${text}`);
      if (r.status === 400 || r.status === 404) break; // Non-retryable
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: Replace sendAdminEmbed in feedback.js**

Find:
```javascript
async function sendAdminEmbed(payload) {
  const url = process.env.DISCORD_ADMIN_WEBHOOK;
  if (!url) return; // No webhook configured — silent skip
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn('[Discord admin webhook]', res.status, await res.text());
  } catch (err) {
    console.warn('[Discord admin webhook] failed:', err.message);
  }
}
```

Replace with:
```javascript
async function sendAdminEmbed(payload) {
  const url = process.env.DISCORD_ADMIN_WEBHOOK;
  if (!url) return;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1)));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) return;
      const text = await r.text();
      lastErr = new Error(`Discord error ${r.status}: ${text}`);
      if (r.status === 400 || r.status === 404) break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) console.warn('[Discord admin webhook] failed after retries:', lastErr.message);
}
```

- [ ] **Step 3: Verify feedback submit still works (Discord is not configured in dev)**

```bash
curl -s -X POST http://localhost:3000/api/feedback/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"feature","title":"test feature idea"}' | jq .message
```
Expected: `"Feedback submitted. Thank you!"`

- [ ] **Step 4: Commit**

```bash
git add server/routes/dashboard.js server/routes/feedback.js
git commit -m "feat: exponential backoff retry (3 attempts, 1s/2s) on all Discord webhook sends"
```

---

### Task 10: Trend and analytics enum + date validation

**Files:**
- Modify: `server/routes/trends.js`
- Modify: `server/routes/analytics.js`

- [ ] **Step 1: Add validate import to trends.js**

Find the top of trends.js (after existing requires). Add:
```javascript
const { assertPlatform, assertScore, assertDate } = require('../middleware/validate');
```

- [ ] **Step 2: Validate in the main GET /api/trends handler**

Find the main trends listing handler. It extracts `{ date, platform, score }` from `req.query`. Add validation immediately after extraction:

```javascript
const platformErr = assertPlatform(platform);
const scoreErr    = assertScore(score);
const dateErr     = assertDate(date);
if (platformErr) return res.status(400).json({ error: platformErr });
if (scoreErr)    return res.status(400).json({ error: scoreErr });
if (dateErr)     return res.status(400).json({ error: dateErr });
```

- [ ] **Step 3: Add validate import to analytics.js**

Find the top of analytics.js. Add:
```javascript
const { assertPlatform } = require('../middleware/validate');
```

- [ ] **Step 4: Validate platform in analytics /velocity and /top-trends**

Both `/velocity` and `/top-trends` accept `req.query.platform` (passed to `db.getTrends`). Add after opening each handler's try block:

```javascript
const platformErr = assertPlatform(req.query.platform);
if (platformErr) return res.status(400).json({ error: platformErr });
```

- [ ] **Step 5: Test enum validation**

```bash
curl -s "http://localhost:3000/api/trends?platform=myspace" | jq .error
```
Expected: `"platform must be one of: youtube, tiktok, instagram, reddit, all"`

```bash
curl -s "http://localhost:3000/api/trends?score=nuclear" | jq .error
```
Expected: `"score must be one of: hot, rising, warm"`

```bash
curl -s "http://localhost:3000/api/trends?date=01-20-2026" | jq .error
```
Expected: `"date must be YYYY-MM-DD"`

- [ ] **Step 6: Commit**

```bash
git add server/routes/trends.js server/routes/analytics.js
git commit -m "feat: validate platform/score enums and date format in trends + analytics routes"
```

---

### Task 11: Dashboard trend_id numeric validation

**Files:**
- Modify: `server/routes/dashboard.js`

The `/saved` POST and `/feedback/vote` use `trend_id` from the request body. If a non-numeric value is passed to db queries expecting integers, Postgres throws. Add a guard.

- [ ] **Step 1: Add validate import to dashboard.js**

Find the top of dashboard.js. Add:
```javascript
const { assertNumericId } = require('../middleware/validate');
```

- [ ] **Step 2: Validate trend_id in POST /saved**

Find:
```javascript
router.post('/saved', requireAuth, async (req, res) => {
  try {
    const { trend_id, topic, platform, score } = req.body;
    if (!trend_id || !topic) {
      return res.status(400).json({ error: 'trend_id and topic required.' });
    }
```

Replace the guard with:
```javascript
router.post('/saved', requireAuth, async (req, res) => {
  try {
    const { trend_id, topic, platform, score } = req.body;
    if (!trend_id || !topic) {
      return res.status(400).json({ error: 'trend_id and topic required.' });
    }
    const idErr = assertNumericId(trend_id, 'trend_id');
    if (idErr) return res.status(400).json({ error: idErr });
```

- [ ] **Step 3: Validate trend_id in POST /feedback/vote (which is in feedback.js)**

In `server/routes/feedback.js`, find the `/vote` handler:
```javascript
router.post('/vote', requireAuth, async (req, res) => {
  try {
    const { trend_id, topic, vote } = req.body;

    if (!trend_id || !vote || !['hot', 'cold'].includes(vote)) {
      return res.status(400).json({ error: 'trend_id and vote (hot|cold) required.' });
    }
```

Add after the existing guard:
```javascript
    const { assertNumericId } = require('../middleware/validate');
    const idErr = assertNumericId(trend_id, 'trend_id');
    if (idErr) return res.status(400).json({ error: idErr });
```

Actually, better to add the require at the top of feedback.js rather than inline. Find the imports at the top of feedback.js:
```javascript
const makeRateLimit = require('../middleware/inMemoryRateLimit');
const { assertPageUrl } = require('../middleware/validate');
```

Change to:
```javascript
const makeRateLimit = require('../middleware/inMemoryRateLimit');
const { assertPageUrl, assertNumericId } = require('../middleware/validate');
```

Then add `assertNumericId` check in the `/vote` handler after the existing guard:
```javascript
    const idErr = assertNumericId(trend_id, 'trend_id');
    if (idErr) return res.status(400).json({ error: idErr });
```

- [ ] **Step 4: Test**

```bash
curl -s -X POST http://localhost:3000/api/dashboard/saved \
  -H 'Content-Type: application/json' \
  --cookie "connect.sid=<valid-session>" \
  -d '{"trend_id":"abc","topic":"test"}' | jq .error
```
Expected: `"trend_id must be a positive integer"`

- [ ] **Step 5: Commit**

```bash
git add server/routes/dashboard.js server/routes/feedback.js
git commit -m "feat: validate trend_id is a positive integer in saved trends and vote endpoints"
```

---

### Task 12: Fix empty startup warning + spurious unsubscribe errors

**Files:**
- Modify: `server/index.js`

**Context:** On startup the server logs `⚠ Startup warning:` with an empty message. This comes from `index.js:223` where `onStartup()` catches `err` from `db.ensureCacheWarmed()` but logs `err.message` which is empty. The `[Auth] Unsubscribe error:` lines appear right after startup but are triggered by actual HTTP requests (likely from open browser tabs), not from initialization code.

- [ ] **Step 1: Fix the startup warning to show the full error**

Find in server/index.js:
```javascript
  } catch (err) {
    console.warn('  ⚠ Startup warning:', err.message);
  }
```

Replace with:
```javascript
  } catch (err) {
    console.warn('  ⚠ Startup warning:', err.message || err);
  }
```

- [ ] **Step 2: Fix unsubscribe error logging to show full error context**

In `server/routes/auth.js`, find:
```javascript
    console.error('[Auth] Unsubscribe error:', err.message);
```

Replace with:
```javascript
    console.error('[Auth] Unsubscribe error:', err.message || err);
```

- [ ] **Step 3: Restart server and verify clean output**

```bash
npm start
```
Expected: startup completes with no `⚠ Startup warning:` (unless `ensureCacheWarmed` genuinely fails — in which case the message will now show *what* failed instead of nothing).

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/routes/auth.js
git commit -m "fix: show full error in startup warning and unsubscribe error logs"
```

---

## Self-Review

**Spec coverage:**
- ✅ `middleware/validate.js` — Task 1
- ✅ `middleware/inMemoryRateLimit.js` — Task 2 (the spec called this `rateLimit.js`; renamed to avoid collision with the existing `rateLimiter.js`)
- ✅ Login brute-force (5/15min/IP) — Task 3
- ✅ Signup spam (1/hr/IP) — Task 3
- ✅ Feedback rate limit (5/hr/IP) + page_url validation — Task 4
- ✅ v1 rate limit enforcement + offset/q bounds — Task 5
- ✅ Correlation IDs (X-Request-ID, error handler) — Task 6
- ✅ Stripe webhook idempotency — Task 7
- ✅ Admin access logging — Task 8
- ✅ Discord retry (both dashboard + feedback) — Task 9
- ✅ Platform/score enums + date format — Task 10
- ✅ trend_id numeric validation — Task 11
- ✅ Startup warning fix — Task 12
- ✅ Discord webhook domain validation — already existed in dashboard.js, no task needed
- ✅ CSV injection protection — already existed in dashboard.js `csvSafe()`, no task needed
- ✅ team_size 1-100 — already clamped in stripe.js, no task needed
- ✅ Analytics days 1-90 — already clamped in analytics.js, no task needed

**No placeholder scan violations found.** All steps contain concrete code.

**Type consistency check:** `assertNumericId`, `assertPlatform`, `assertScore`, `assertDate`, `assertPageUrl` defined in Task 1, used by the same names in Tasks 4, 5, 10, 11. `makeRateLimit` defined in Task 2, used in Tasks 3, 4. All consistent.

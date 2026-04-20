/**
 * Wavecrest Pro — Gatekeeper Middleware
 *
 * Tracks the 5-day beta staircase + post-trial weekly rotation via a
 * signed cookie (handled by cookie-parser). Requires cookieParser(secret)
 * to run before this middleware.
 *
 * Cookie: WavecrestSession  (signed JSON)
 *   { j: joinDate ISO string, u: visitor UUID }
 *
 * Tier schedule
 * ─────────────
 *  Day 1  → free
 *  Day 2  → plus
 *  Day 3  → pro
 *  Day 4  → max
 *  Day 5  → teams
 *  Day 6+ → weekly rotation  (week 1: plus, week 2: pro, week 3: max, repeat)
 *
 * Attaches to req:
 *   req.betaTier         'free' | 'plus' | 'pro' | 'max' | 'teams'
 *   req.betaDay          1-indexed days since first visit
 *   req.betaPhase        'staircase' | 'rotation'
 *   req.betaWeek         rotation week number (1-indexed, null during staircase)
 *   req.betaTrialActive  true during days 1-5
 *   req.betaTrialExpired true on day 6+
 *   req.betaVisitorId    UUID assigned on first visit
 */

const { v4: uuidv4 } = require('uuid');

// ── Plan constants ────────────────────────────────────
const PLAN_ORDER    = ['free', 'plus', 'pro', 'max', 'teams'];
const PLAN_RANK     = Object.fromEntries(PLAN_ORDER.map((p, i) => [p, i]));
const ROTATION      = ['plus', 'pro', 'max']; // weekly cycle after trial ends
const COOKIE_NAME   = 'WavecrestSession';
const COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

// ── Core tier calculation (pure function — easy to test) ──
function getCurrentTier(joinDateStr) {
  const joinMs    = new Date(joinDateStr).getTime();
  if (isNaN(joinMs)) return null;

  const now       = Date.now();
  const daysSince = Math.floor((now - joinMs) / (1000 * 60 * 60 * 24));
  const day       = daysSince + 1; // 1-indexed (same day = day 1)

  if (day <= 5) {
    // Staircase: day 1=free, 2=plus, 3=pro, 4=max, 5=teams
    return {
      tier:         PLAN_ORDER[day - 1],
      day,
      phase:        'staircase',
      week:         null,
      trialActive:  true,
      trialExpired: false,
    };
  }

  // Weekly rotation — starts on day 6
  // daysAfterTrial: 0 = day 6, 7 = day 13, …
  const daysAfterTrial = daysSince - 5;
  const weekIndex      = Math.floor(daysAfterTrial / 7); // 0-indexed
  const tier           = ROTATION[weekIndex % ROTATION.length];

  return {
    tier,
    day,
    phase:        'rotation',
    week:         weekIndex + 1, // 1-indexed
    trialActive:  false,
    trialExpired: true,
  };
}

// ── Main gatekeeper middleware ────────────────────────
function gatekeeper(req, res, next) {
  // cookie-parser populates req.signedCookies when the secret matches
  const raw = req.signedCookies && req.signedCookies[COOKIE_NAME];

  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
      // Basic sanity: must have join date and visitor ID
      if (!payload.j || !payload.u || isNaN(new Date(payload.j).getTime())) {
        payload = null;
      }
    } catch {
      payload = null;
    }
  }

  // First visit — initialize cookie
  if (!payload) {
    payload = {
      j: new Date().toISOString(), // join date
      u: uuidv4(),                 // visitor ID
    };
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, JSON.stringify(payload), {
      signed:   true,
      httpOnly: true,
      secure:   isProd,
      sameSite: 'lax',
      maxAge:   COOKIE_MAX_AGE_MS,
    });
  }

  const tierInfo = getCurrentTier(payload.j);

  // Attach everything to req for downstream use
  req.betaVisitorId    = payload.u;
  req.betaTier         = tierInfo?.tier         ?? 'free';
  req.betaDay          = tierInfo?.day          ?? 1;
  req.betaPhase        = tierInfo?.phase        ?? 'staircase';
  req.betaWeek         = tierInfo?.week         ?? null;
  req.betaTrialActive  = tierInfo?.trialActive  ?? true;
  req.betaTrialExpired = tierInfo?.trialExpired ?? false;

  next();
}

// ── Access-control factory ────────────────────────────
/**
 * requireTier('pro') → middleware that 302s to the user's actual
 * highest accessible route if they try to skip ahead.
 */
function requireTier(minTier) {
  const minRank = PLAN_RANK[minTier] ?? 0;

  return function tierGuard(req, res, next) {
    const currentRank = PLAN_RANK[req.betaTier] ?? 0;
    if (currentRank >= minRank) return next();

    // Redirect to the highest tier they've actually unlocked
    const tier = req.betaTier;
    // 'free' → /dashboard (no dedicated unlock page), others → /tierName
    const dest = (tier === 'free' || !ROTATION.includes(tier) && PLAN_RANK[tier] === 0)
      ? '/dashboard'
      : '/' + tier;
    return res.redirect(302, dest);
  };
}

// ── Tier header (readable by client JS without a fetch) ──
function exposeTierHeader(req, res, next) {
  res.setHeader('X-Wavecrest-Tier',  req.betaTier   ?? 'free');
  res.setHeader('X-Wavecrest-Day',   String(req.betaDay ?? 1));
  res.setHeader('X-Wavecrest-Phase', req.betaPhase  ?? 'staircase');
  next();
}

module.exports = {
  gatekeeper,
  requireTier,
  exposeTierHeader,
  getCurrentTier,   // export for testing / dashboard.js reuse
  PLAN_ORDER,
  PLAN_RANK,
  ROTATION,
};

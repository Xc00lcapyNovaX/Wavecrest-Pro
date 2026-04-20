/**
 * Trend routes — list, search, and daily data
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const rateLimiter = require('../middleware/rateLimiter');
const router = express.Router();

// ── GET /api/trends — list today's trends ──────────
router.get('/', requireAuth, rateLimiter, async (req, res) => {
  try {
    const { date, platform, score, limit = '30', offset = '0' } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 30, 100));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

    let result = await db.getTrends({
      date: targetDate,
      platform: platform || undefined,
      score: score || undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    // Fall back to most recent date if no results for requested date
    if (result.total === 0 && !date && db.trends.length > 0) {
      const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
      if (dates.length > 0) {
        result = await db.getTrends({
          date: dates[0], platform: platform || undefined,
          score: score || undefined, limit: parsedLimit, offset: parsedOffset,
        });
        return res.json({ date: dates[0], ...result, user_plan: req.user.plan });
      }
    }

    res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=60');
    res.json({ date: targetDate, ...result, user_plan: req.user.plan });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/trends/search — niche search (Pro+) ──
router.get('/search', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    const proPlanRequired = ['pro', 'max', 'teams', 'enterprise'];

    if (!proPlanRequired.includes(user.plan)) {
      return res.status(403).json({
        error: 'Niche search requires Pro plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout?plan=pro',
      });
    }

    const { q, platform } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
    }

    await db.logUsage(user.id, '/api/trends/search');
    const results = await db.searchTrends(q.trim(), { platform: platform || undefined });

    res.json({
      query: q.trim(),
      platform: platform || 'all',
      count: results.length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/trends/history — trend history ────────
router.get('/history', requireAuth, rateLimiter, (req, res) => {
  const { topic, days = 7 } = req.query;
  if (!topic) return res.status(400).json({ error: 'Topic parameter required.' });

  const d = Math.min(parseInt(days) || 7, 90);
  const since = new Date();
  since.setDate(since.getDate() - d);
  const sinceStr = since.toISOString().slice(0, 10);

  const q = topic.toLowerCase();
  const results = db.trends
    .filter((t) => t.topic.toLowerCase().includes(q) && t.fetched_at >= sinceStr)
    .sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));

  // Group by date
  const history = {};
  results.forEach((t) => {
    if (!history[t.fetched_at]) history[t.fetched_at] = [];
    history[t.fetched_at].push({ topic: t.topic, score: t.score, platform: t.platform });
  });

  res.json({ topic, days: d, history });
});

// ── GET /api/trends/platforms — platform breakdown ─
router.get('/platforms', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrends = db.trends.filter((t) => t.fetched_at === today);

  const platforms = {};
  todayTrends.forEach((t) => {
    if (!platforms[t.platform]) platforms[t.platform] = { hot: 0, rising: 0, warm: 0, total: 0 };
    platforms[t.platform][t.score] = (platforms[t.platform][t.score] || 0) + 1;
    platforms[t.platform].total++;
  });

  res.json({ date: today, platforms });
});

// ── GET /api/trends/predictions — AI trend predictions (Pro+) ──
router.get('/predictions', requireAuth, rateLimiter, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!['pro', 'max', 'teams', 'enterprise'].includes(user.plan)) {
      return res.status(403).json({
        error: 'Trend predictions require Pro plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout?plan=pro',
        preview: [
          { topic: '██████████', momentum: '???', prediction: 'Upgrade to Pro to unlock AI predictions' },
        ],
      });
    }

    await db.logUsage(user.id, '/api/trends/predictions');

    // Get last 7 days of trends for momentum analysis
    const { rows } = await db.pool.query(`
      SELECT topic, platform, score, fetched_at::text AS fetched_at,
             traffic, COUNT(*) OVER (PARTITION BY LOWER(topic)) AS appearances
      FROM trends
      WHERE fetched_at >= (CURRENT_DATE - INTERVAL '7 days')
      ORDER BY fetched_at DESC
    `);

    // Score each unique topic by momentum
    const topicMap = {};
    rows.forEach(t => {
      const key = t.topic.toLowerCase();
      if (!topicMap[key]) {
        topicMap[key] = {
          topic: t.topic, platforms: new Set(), scores: [], dates: new Set(),
          traffic: 0, appearances: 0, latest_score: t.score,
        };
      }
      topicMap[key].platforms.add(t.platform);
      topicMap[key].scores.push(t.score);
      topicMap[key].dates.add(t.fetched_at);
      topicMap[key].traffic += t.traffic || 0;
      topicMap[key].appearances++;
    });

    const scoreWeights = { hot: 3, rising: 2, warm: 1 };
    const predictions = Object.values(topicMap).map(t => {
      const avgScore = t.scores.reduce((sum, s) => sum + (scoreWeights[s] || 0), 0) / t.scores.length;
      const platformSpread = t.platforms.size;
      const recency = t.dates.has(new Date().toISOString().slice(0, 10)) ? 1.5 : 0.8;
      const consistency = t.dates.size / 7; // what fraction of last 7 days it appeared
      const momentum = Math.round((avgScore * 25 + platformSpread * 15 + consistency * 30 + (t.traffic / 1000)) * recency);

      let prediction, confidence;
      if (momentum >= 80) { prediction = 'EXPLODING — act now'; confidence = 'high'; }
      else if (momentum >= 55) { prediction = 'Rising fast — strong opportunity'; confidence = 'high'; }
      else if (momentum >= 35) { prediction = 'Building momentum — watch closely'; confidence = 'medium'; }
      else if (momentum >= 20) { prediction = 'Early signal — could break out'; confidence = 'low'; }
      else { prediction = 'Cooling down — move on'; confidence = 'low'; }

      return {
        topic: t.topic,
        momentum,
        prediction,
        confidence,
        platforms: [...t.platforms],
        appearances: t.appearances,
        days_trending: t.dates.size,
        latest_score: t.latest_score,
      };
    });

    predictions.sort((a, b) => b.momentum - a.momentum);

    res.json({
      date: new Date().toISOString().slice(0, 10),
      window_days: 7,
      count: predictions.length,
      predictions: predictions.slice(0, 30),
    });
  } catch (err) {
    console.error('[Predictions]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/trends/hooks — AI content hooks (Pro+) ──
router.get('/hooks', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!['pro', 'max', 'teams', 'enterprise'].includes(user.plan)) {
      return res.status(403).json({
        error: 'Content hooks require Pro plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout?plan=pro',
      });
    }

    const { topic, platform } = req.query;
    if (!topic || topic.trim().length < 2) {
      return res.status(400).json({ error: 'Topic parameter required (min 2 chars).' });
    }

    await db.logUsage(user.id, '/api/trends/hooks');
    const t = topic.trim();
    const plat = platform || 'all';

    const hooks = generateContentHooks(t, plat);
    res.json({ topic: t, platform: plat, hooks });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

function generateContentHooks(topic, platform) {
  const hooks = [];
  const t = topic;

  // Platform-specific hooks
  const platformHooks = {
    youtube: [
      { type: 'video_idea', hook: `"I Tried ${t} For 7 Days — Here's What Happened"`, format: 'Challenge/experiment (8-12 min)', why: 'Challenge format drives high watch time and shares' },
      { type: 'video_idea', hook: `"${t} Explained in Under 5 Minutes"`, format: 'Explainer (3-5 min)', why: 'Quick explainers capture search traffic as trend grows' },
      { type: 'video_idea', hook: `"Why Everyone Is Talking About ${t} (And Why You Should Care)"`, format: 'Commentary/take (10-15 min)', why: 'Hot take content rides the wave of curiosity' },
      { type: 'thumbnail_tip', hook: `Use split-screen: "Before ${t}" vs "After ${t}" with shocked face`, format: 'Thumbnail', why: 'Before/after thumbnails get 2-3x higher CTR' },
      { type: 'seo_tip', hook: `Target: "${t} 2026", "${t} explained", "what is ${t}"`, format: 'SEO', why: 'Trending topics have low keyword competition early' },
    ],
    tiktok: [
      { type: 'video_idea', hook: `"POV: You just discovered ${t}"`, format: 'POV skit (15-30s)', why: 'POV format is TikTok-native and highly shareable' },
      { type: 'video_idea', hook: `"${t} but make it ✨aesthetic✨"`, format: 'Aesthetic/visual (15-60s)', why: 'Aesthetic angle makes any trend save-worthy' },
      { type: 'video_idea', hook: `"Things nobody tells you about ${t}"`, format: 'Listicle (30-60s)', why: 'Secret/insider content drives comments and shares' },
      { type: 'sound_tip', hook: `Pair with a trending sound — search "${t}" in TikTok sounds`, format: 'Audio', why: 'Trending sound + trending topic = algorithm boost' },
      { type: 'hashtag_tip', hook: `Use: #${t.replace(/\s+/g, '')} #${t.replace(/\s+/g, '')}tok #trending #fyp`, format: 'Hashtags', why: 'Niche hashtag + broad hashtag combo maximizes reach' },
    ],
    instagram: [
      { type: 'post_idea', hook: `Carousel: "5 Things You Didn't Know About ${t}"`, format: 'Carousel (5-10 slides)', why: 'Carousels get 3x more engagement than single images' },
      { type: 'reel_idea', hook: `"${t} in 30 seconds" — fast cuts with text overlay`, format: 'Reel (15-30s)', why: 'Short reels with text overlay perform best on IG' },
      { type: 'story_idea', hook: `Poll: "Have you tried ${t}?" → Yes / Not yet`, format: 'Story poll', why: 'Interactive stories boost engagement rate for algorithm' },
      { type: 'caption_tip', hook: `Start with a hook line: "Everyone's wrong about ${t}. Here's why ↓"`, format: 'Caption', why: 'Controversial openers increase read-through and comments' },
      { type: 'collab_tip', hook: `Find creators already posting about ${t} — propose a collab reel`, format: 'Strategy', why: 'Collab posts reach both audiences while trend is hot' },
    ],
  };

  // Universal hooks that apply to any platform
  const universalHooks = [
    { type: 'angle', hook: `The contrarian take: "Why ${t} is actually overrated"`, format: 'Any platform', why: 'Contrarian content sparks debate and gets shared by both sides' },
    { type: 'angle', hook: `The early adopter: "I was into ${t} before it was cool — here\'s what I learned"`, format: 'Any platform', why: 'Authority positioning builds trust and followership' },
    { type: 'angle', hook: `The practical guide: "How to actually use ${t} to [benefit]"`, format: 'Any platform', why: 'Practical content gets saved and shared — long shelf life' },
    { type: 'timing', hook: `Post within the next 24-48 hours — trend velocity is peaking`, format: 'Strategy', why: 'First-mover advantage on trending topics is massive' },
  ];

  if (platform !== 'all' && platformHooks[platform]) {
    hooks.push(...platformHooks[platform]);
  } else {
    // Return top hooks from each platform
    Object.entries(platformHooks).forEach(([plat, platHooks]) => {
      hooks.push(...platHooks.slice(0, 3).map(h => ({ ...h, platform: plat })));
    });
  }

  hooks.push(...universalHooks);
  return hooks;
}

// ── GET /api/trends/cross-platform — cross-platform insights (Max) ──
router.get('/cross-platform', requireAuth, rateLimiter, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!['max', 'teams', 'enterprise'].includes(user.plan)) {
      return res.status(403).json({
        error: 'Cross-platform insights require Max plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout?plan=max',
        preview: {
          message: 'See which trends are crossing platforms and where they started',
          sample: { topic: '██████', platforms: ['youtube → tiktok → instagram'], first_seen: '????' },
        },
      });
    }

    await db.logUsage(user.id, '/api/trends/cross-platform');

    // Find trends that appear on multiple platforms
    const { rows } = await db.pool.query(`
      SELECT topic, platform, MIN(fetched_at)::text AS first_seen,
             COUNT(*) AS appearances, MAX(fetched_at)::text AS last_seen
      FROM trends
      WHERE fetched_at >= (CURRENT_DATE - INTERVAL '14 days')
      GROUP BY LOWER(topic), topic, platform
      ORDER BY LOWER(topic), first_seen
    `);

    // Group by topic, track platform timeline
    const topicMap = {};
    rows.forEach(r => {
      const key = r.topic.toLowerCase();
      if (!topicMap[key]) topicMap[key] = { topic: r.topic, platforms: [] };
      topicMap[key].platforms.push({
        platform: r.platform,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        appearances: parseInt(r.appearances),
      });
    });

    // Only keep trends on 2+ platforms
    const crossPlatform = Object.values(topicMap)
      .filter(t => t.platforms.length >= 2)
      .map(t => {
        t.platforms.sort((a, b) => a.first_seen.localeCompare(b.first_seen));
        const origin = t.platforms[0].platform;
        const spread = t.platforms.map(p => p.platform);
        const spreadTime = t.platforms.length > 1
          ? daysBetween(t.platforms[0].first_seen, t.platforms[t.platforms.length - 1].first_seen)
          : 0;

        let insight;
        if (spreadTime === 0) insight = `Trending simultaneously on ${spread.join(' + ')} — massive topic`;
        else if (spreadTime <= 1) insight = `Jumped from ${origin} to ${spread.slice(1).join(', ')} in under 24h — fast spreader`;
        else insight = `Started on ${origin}, spread to ${spread.slice(1).join(', ')} over ${spreadTime} days`;

        return {
          topic: t.topic,
          origin_platform: origin,
          platform_count: t.platforms.length,
          spread_path: spread.join(' → '),
          spread_days: spreadTime,
          insight,
          platforms: t.platforms,
        };
      })
      .sort((a, b) => b.platform_count - a.platform_count || a.spread_days - b.spread_days);

    res.json({
      date: new Date().toISOString().slice(0, 10),
      window_days: 14,
      cross_platform_count: crossPlatform.length,
      trends: crossPlatform,
    });
  } catch (err) {
    console.error('[CrossPlatform]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

// ── GET /api/trends/ideas — AI content ideas via Claude (Pro+) ──────────
router.get('/ideas', requireAuth, rateLimiter, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!['pro', 'max', 'teams', 'enterprise'].includes(user.plan)) {
      return res.status(403).json({
        error: 'Content ideas require Pro plan or higher.',
        upgrade_url: '/checkout?plan=pro',
      });
    }

    const { topic, platform = 'youtube' } = req.query;
    if (!topic || topic.trim().length < 2) {
      return res.status(400).json({ error: 'Topic required (min 2 chars).' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI idea generation is not configured.' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    await db.logUsage(user.id, '/api/trends/ideas');

    const t = topic.trim();
    const platformLabel = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', all: 'any platform' }[platform] || platform;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a viral content strategist. The topic "${t}" is trending on ${platformLabel}.

Generate exactly 5 content ideas. For each idea output ONLY this JSON format, one per line (no markdown, no extra text):
{"title":"...","format":"...","hook":"...","why":"..."}

Rules:
- title: compelling video/post title (under 70 chars)
- format: e.g. "YouTube Short", "TikTok POV", "Instagram Carousel", "Long-form video"
- hook: opening line or visual that grabs attention in the first 3 seconds
- why: one sentence on why this will perform well right now

Output 5 lines of JSON only.`,
      }],
    });

    const raw = message.content[0].text.trim();
    const ideas = raw.split('\n')
      .map(line => { try { return JSON.parse(line.trim()); } catch { return null; } })
      .filter(Boolean)
      .slice(0, 5);

    if (!ideas.length) {
      return res.status(500).json({ error: 'Failed to parse AI response. Try again.' });
    }

    res.json({ topic: t, platform, ideas });
  } catch (err) {
    console.error('[Ideas]', err.message);
    res.status(500).json({ error: 'Server error generating ideas.' });
  }
});

// ── GET /api/trends/dates — all dates that have trend data (with score breakdown) ──
router.get('/dates', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        fetched_at::text AS date,
        COUNT(*)::int                                           AS total,
        SUM(CASE WHEN score='hot'    THEN 1 ELSE 0 END)::int   AS hot,
        SUM(CASE WHEN score='rising' THEN 1 ELSE 0 END)::int   AS rising,
        SUM(CASE WHEN score='warm'   THEN 1 ELSE 0 END)::int   AS warm
      FROM trends
      GROUP BY fetched_at
      ORDER BY fetched_at DESC
    `);
    res.json({ dates: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/trends/seed — called by GitHub Actions after daily update ──
router.post('/seed', async (req, res) => {
  const secret = process.env.SEED_SECRET;
  const provided = req.headers['x-seed-secret'] || req.body?.secret;
  if (secret && provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    await seedTrendsFromFile();
    await db._refreshTrendsCache();
    res.json({ message: 'Seeded successfully.', count: db.trends.length });
  } catch (err) {
    console.error('[Seed webhook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Seed trends from trends.json — call explicitly from index.js ──
async function seedTrendsFromFile() {
  const trendsPath = path.join(__dirname, '..', '..', 'public', 'trends.json');
  try {
    const data = JSON.parse(fs.readFileSync(trendsPath, 'utf-8'));
    if (data && data.trends && data.trends.length) {
      await db.addTrends(data.trends, data.date);
      console.log(`  ✓ Seeded ${data.trends.length} trends from trends.json (${data.date})`);
    }
  } catch (err) {
    console.log('  ⚠ No trends.json found — run update-trends.py to generate');
  }
}

router.seedTrendsFromFile = seedTrendsFromFile;
module.exports = router;

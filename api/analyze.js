// api/analyze.js
// Vercel serverless function — POST /api/analyze
// Body: { url: string } — YouTube channel URL, @handle, or video URL
// Returns: { reportId, channel, videoCount, analysis }
//
// Required env vars:
//   YOUTUBE_API_KEY — from Google Cloud Console (YouTube Data API v3)
//   GROQ_API_KEY    — from https://console.groq.com (free)
//   DB_URL          — Postgres connection string

import pg from 'pg';
const { Pool } = pg;

export const config = { maxDuration: 60 };

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

// Reuse DB pool across warm invocations
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

export default async function handler(req, res) {
  // CORS for same-origin fetch from app.html
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const url = (body?.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'Paste a YouTube channel URL, @handle, or video URL' });
  }

  const { YOUTUBE_API_KEY, GROQ_API_KEY } = process.env;
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    // 1. Resolve URL → channel info
    const channel = await resolveChannel(url, YOUTUBE_API_KEY);

    // 2. Fetch up to 100 recent videos
    const videos = await fetchVideos(channel.uploadsPlaylistId, YOUTUBE_API_KEY, 100);
    if (videos.length < 3) {
      return res.status(422).json({ error: 'Channel has too few public videos to analyze (need at least 3)' });
    }

    // 3. Run 7-dimension AI analysis
    const analysis = await runAnalysis(channel, videos, GROQ_API_KEY);

    // 4. Persist to DB (best-effort — don't fail if DB is down)
    const reportId = await saveReport(channel, videos.length, analysis);

    return res.status(200).json({
      reportId,
      channel: {
        id: channel.id,
        name: channel.name,
        handle: channel.handle,
        subscriberCount: channel.subscriberCount,
        thumbnailUrl: channel.thumbnailUrl,
        publishedAt: channel.publishedAt
      },
      videoCount: videos.length,
      analysis
    });

  } catch (err) {
    console.error('[analyze]', err);
    return res.status(500).json({ error: err.message || 'Analysis failed — try again' });
  }
}

// ─── YouTube helpers ───────────────────────────────────────────────────────────

async function ytFetch(endpoint, apiKey) {
  const r = await fetch(`${YOUTUBE_API}/${endpoint}&key=${apiKey}`);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let msg = `YouTube API error (${r.status})`;
    try {
      const json = JSON.parse(text);
      msg = json.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function resolveChannel(url, apiKey) {
  // Normalise input
  url = url.trim()
    .replace(/^https?:\/\//i, '')   // strip protocol
    .replace(/^www\./i, '')          // strip www.
    .replace(/^m\./i, '');           // strip m. (mobile)

  // Bare handle (no dots or slashes) → treat as @handle
  if (!/[./]/.test(url)) {
    url = '@' + url.replace(/^@/, '');
  }

  // Detect URL type
  const handleMatch = url.match(/(?:youtube\.com\/)?@([\w.-]+)/);
  const channelIdMatch = url.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  const videoMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  const legacyUserMatch = url.match(/youtube\.com\/(?:user|c)\/([\w.-]+)/);

  if (channelIdMatch) {
    const r = await ytFetch(
      `channels?part=snippet,statistics,contentDetails&id=${channelIdMatch[1]}`,
      apiKey
    );
    if (!r.items?.length) throw new Error('Channel not found');
    return extractChannelInfo(r.items[0]);
  }

  if (handleMatch) {
    const r = await ytFetch(
      `channels?part=snippet,statistics,contentDetails&forHandle=@${handleMatch[1]}`,
      apiKey
    );
    if (!r.items?.length) throw new Error(`No channel found for @${handleMatch[1]}`);
    return extractChannelInfo(r.items[0]);
  }

  if (videoMatch) {
    const vr = await ytFetch(`videos?part=snippet&id=${videoMatch[1]}`, apiKey);
    if (!vr.items?.length) throw new Error('Video not found');
    const channelId = vr.items[0].snippet.channelId;
    const cr = await ytFetch(
      `channels?part=snippet,statistics,contentDetails&id=${channelId}`,
      apiKey
    );
    if (!cr.items?.length) throw new Error('Channel not found');
    return extractChannelInfo(cr.items[0]);
  }

  if (legacyUserMatch) {
    const r = await ytFetch(
      `channels?part=snippet,statistics,contentDetails&forUsername=${legacyUserMatch[1]}`,
      apiKey
    );
    if (r.items?.length) return extractChannelInfo(r.items[0]);
  }

  throw new Error(
    'Could not parse that URL. Try: youtube.com/@channelname, youtube.com/channel/UC..., or a video URL'
  );
}

function extractChannelInfo(item) {
  return {
    id: item.id,
    name: item.snippet?.title || '',
    handle: item.snippet?.customUrl || '',
    description: (item.snippet?.description || '').slice(0, 500),
    subscriberCount: parseInt(item.statistics?.subscriberCount || 0),
    videoCountTotal: parseInt(item.statistics?.videoCount || 0),
    viewCountTotal: parseInt(item.statistics?.viewCount || 0),
    thumbnailUrl:
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.default?.url || '',
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || '',
    publishedAt: item.snippet?.publishedAt || ''
  };
}

async function fetchVideos(playlistId, apiKey, maxVideos = 100) {
  if (!playlistId) throw new Error('Could not find channel uploads playlist');

  const videoIds = [];
  let pageToken = '';

  while (videoIds.length < maxVideos) {
    const perPage = Math.min(50, maxVideos - videoIds.length);
    let endpoint = `playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${perPage}`;
    if (pageToken) endpoint += `&pageToken=${pageToken}`;

    const r = await ytFetch(endpoint, apiKey);
    if (!r.items?.length) break;

    for (const item of r.items) {
      const vid = item.snippet?.resourceId?.videoId;
      if (vid) videoIds.push(vid);
    }

    pageToken = r.nextPageToken || '';
    if (!pageToken || videoIds.length >= maxVideos) break;
  }

  // Batch-fetch video details (max 50 per request)
  const videos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(',');
    const r = await ytFetch(
      `videos?part=snippet,statistics,contentDetails&id=${ids}`,
      apiKey
    );
    if (r.items) videos.push(...r.items);
  }

  return videos.map(v => ({
    id: v.id,
    title: v.snippet?.title || '',
    description: (v.snippet?.description || '').slice(0, 400),
    publishedAt: v.snippet?.publishedAt || '',
    viewCount: parseInt(v.statistics?.viewCount || 0),
    likeCount: parseInt(v.statistics?.likeCount || 0),
    commentCount: parseInt(v.statistics?.commentCount || 0),
    duration: parseDuration(v.contentDetails?.duration || 'PT0S'),
    thumbnailUrl:
      v.snippet?.thumbnails?.maxres?.url ||
      v.snippet?.thumbnails?.high?.url || ''
  }));
}

function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// ─── Analysis ──────────────────────────────────────────────────────────────────

function computeCadence(videos) {
  if (videos.length < 2) return {};

  const dates = videos
    .map(v => new Date(v.publishedAt))
    .filter(d => !isNaN(d))
    .sort((a, b) => a - b);

  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / 86400000); // ms → days
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayCount = new Array(7).fill(0);
  dates.slice(-60).forEach(d => dayCount[d.getDay()]++);
  const peakDay = dayNames[dayCount.indexOf(Math.max(...dayCount))];

  const hourCount = new Array(24).fill(0);
  dates.slice(-60).forEach(d => hourCount[d.getUTCHours()]++);
  const peakHourUTC = hourCount.indexOf(Math.max(...hourCount));

  const durations = videos.map(v => v.duration).filter(d => d > 0);
  const avgDurationSec = durations.reduce((a, b) => a + b, 0) / (durations.length || 1);

  return {
    avgDaysBetweenVideos: Math.round(avgGap * 10) / 10,
    videosPerMonth: Math.round((30 / avgGap) * 10) / 10,
    peakDay,
    peakHourUTC,
    avgDurationMinutes: Math.round(avgDurationSec / 60 * 10) / 10,
    shortestMinutes: Math.round(Math.min(...durations) / 60 * 10) / 10,
    longestMinutes: Math.round(Math.max(...durations) / 60 * 10) / 10
  };
}

async function runAnalysis(channel, videos, groqKey) {
  const cadence = computeCadence(videos);

  const byViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
  const top20 = byViews.slice(0, 20);
  const recent = videos.slice(0, 30);

  const videoList = (arr, includeStats = true) =>
    arr.map((v, i) => {
      const stats = includeStats
        ? ` | ${fmtNum(v.viewCount)} views | ${Math.round(v.duration / 60)}min`
        : ` | ${v.publishedAt.slice(0, 10)}`;
      return `${i + 1}. "${v.title}"${stats}`;
    }).join('\n');

  // Build a view-count context for the top videos
  const topViewsAvg = top20.reduce((a, v) => a + v.viewCount, 0) / top20.length;
  const allViewsAvg = videos.reduce((a, v) => a + v.viewCount, 0) / videos.length;
  const outperformers = top20.filter(v => v.viewCount > topViewsAvg * 1.5);

  // Estimated monthly views for earnings calc
  const channelAgeMonths = channel.publishedAt
    ? Math.max(1, (Date.now() - new Date(channel.publishedAt)) / (1000 * 60 * 60 * 24 * 30))
    : 12;
  const estimatedMonthlyViews = Math.round(cadence.videosPerMonth * allViewsAvg) ||
    Math.round(channel.viewCountTotal / channelAgeMonths);

  const prompt = `You are a creator intelligence analyst. Study the video titles and stats below. Return ONLY a JSON object — no other text.

CRITICAL RULES — violating these makes the output useless:
1. CITE SPECIFIC TITLES. Every insight must reference actual titles from the numbered list (e.g. "video #3", "the top performer"). Never make generic statements.
2. GAPS must be topics that appear ZERO times in the title list. Scan every title. Do not suggest "collaborations" or "analytics" or other universal advice — find what THIS creator specifically never touches.
3. MONETIZATION SIGNALS must be exact observations from the titles/descriptions ("video #7 ends with a brand name", "8 of top 20 titles contain [Sponsored]") — not category-level guesses.
4. HOOK PATTERNS must include verbatim word structures lifted from actual titles, not descriptions of them.
5. Never say things a casual viewer would already know from the channel name alone.

CHANNEL: ${channel.name}${channel.handle ? ' (' + channel.handle + ')' : ''}
Subscribers: ${fmtNum(channel.subscriberCount)} | Total views: ${fmtNum(channel.viewCountTotal)}
Channel avg views: ${fmtNum(Math.round(allViewsAvg))} | Top 20 avg: ${fmtNum(Math.round(topViewsAvg))}
Description: ${channel.description}

TOP 20 VIDEOS BY VIEWS:
${videoList(top20)}

OUTPERFORMERS (>${fmtNum(Math.round(topViewsAvg * 1.5))} views — these are the signal):
${outperformers.map(v => `"${v.title}" | ${fmtNum(v.viewCount)} views`).join('\n') || 'None significantly above average'}

RECENT 30 VIDEOS:
${videoList(recent, false)}

CADENCE DATA:
- Avg ${cadence.avgDaysBetweenVideos} days between uploads (~${cadence.videosPerMonth}/month)
- Peak day: ${cadence.peakDay} | Avg duration: ${cadence.avgDurationMinutes}min (range: ${cadence.shortestMinutes}–${cadence.longestMinutes}min)
- Estimated monthly views: ~${fmtNum(estimatedMonthlyViews)}

Return JSON with exactly these keys:

hooks: {
  primaryPattern: "Verbatim structural formula extracted from actual titles — e.g. 'I [past-tense verb] [specific thing] for [time period] and [unexpected result]' — not a description, the actual pattern",
  examples: ["Copy 3 real titles from the numbered list that prove this pattern"],
  frequency: "How many of the top 20 use this pattern (count them)",
  secondaryPatterns: ["Second real pattern with example words", "Third real pattern"]
}

thumbnails: {
  formula: "What the title patterns and channel topic reveal about their thumbnail approach — be specific about what emotion or contrast they create",
  characteristics: ["3 specific visual elements inferred from the content type and top performers"],
  textOverlayStyle: "What text style/placement the top performers likely use based on the content"
}

cadence: {
  schedule: "Specific posting pattern with exact numbers from the cadence data",
  consistency: "Observation about variance — are they erratic or clockwork? Use the day gap data",
  durationStrategy: "What the ${cadence.shortestMinutes}–${cadence.longestMinutes}min range reveals about content strategy",
  peakPerformanceWindow: "Are the outperformers from a specific time period? What changed?"
}

audience: {
  primaryProfile: "Specific psychographic: what exact problem or desire brings this viewer here, backed by what the top-performing titles promise",
  estimatedAge: "Age range based on content type and tone",
  viewerIntent: "One sentence — what does the viewer want to accomplish or feel after watching",
  loyaltySignal: "Something specific from the data (comment count, like ratio, video length engagement) that shows audience quality"
}

pillars: [3 objects: {
  name: "Short specific sub-niche label",
  percentage: number (sum to 100),
  description: "Which numbered videos fall here and how they perform vs channel average"
}]

monetization: {
  primaryApproach: "Revenue model IF there is clear evidence in the titles/descriptions. If there is no evidence, say 'No clear monetization signals in the title data — likely AdSense or unlisted sponsors'",
  signals: ["Only include signals with actual evidence from the numbered titles. If a signal has no evidence, omit it rather than guessing. E.g. 'video #4 title ends with brand name', 'description of #1 says sponsored by X', 'none of the titles contain sponsor mentions'"],
  brandAffinities: "Brand categories that would logically fit based on the specific content topics — be honest if this is inference not evidence"
}

gaps: [3 objects: {
  opportunity: "A specific topic/format that appears ZERO times across all the titles above",
  rationale: "Evidence: cite which video numbers prove the audience would want this, and confirm none of the titles cover it"
}]

earningsEstimate: {
  monthlyViewsEstimate: ${estimatedMonthlyViews},
  cpmRange: "Low and high CPM in USD based on this niche (e.g. gaming=$1-3, tech=$4-8, finance=$8-15, lifestyle=$2-5) — be specific about why this niche gets this CPM",
  estimatedMonthlyAdRevenue: "Dollar range (low–high) = monthlyViews × (cpmLow/1000) to monthlyViews × (cpmHigh/1000). Show the math.",
  otherRevenue: "Other likely income streams beyond AdSense based on what you can actually infer from the channel — be specific or say 'unclear from data'",
  totalEstimate: "Monthly total range combining ad revenue + realistic other revenue, expressed as a range e.g. '$X,000–$Y,000/month'"
}

videoIdeas: [5 objects: {
  title: "A complete ready-to-publish title written in this creator's exact hook style, using their proven formula",
  rationale: "Why this specific title would outperform their average — cite which top performers it's modeled on and what gap/pattern it exploits",
  estimatedPerformance: "Whether this would likely hit above or below their ${fmtNum(Math.round(allViewsAvg))} view average, and why"
}]`;

  const r = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${groqKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are a creator intelligence analyst. Always respond with valid JSON only — no markdown, no explanation, just the JSON object.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' }
    })
  });

  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`AI analysis failed (${r.status}): ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI returned an empty response — try again');

  // response_format: json_object guarantees valid JSON
  const aiAnalysis = JSON.parse(text);

  return {
    ...aiAnalysis,
    cadence: {
      ...aiAnalysis.cadence,
      avgDaysBetweenVideos: cadence.avgDaysBetweenVideos,
      videosPerMonth: cadence.videosPerMonth,
      peakDay: cadence.peakDay,
      avgDurationMinutes: cadence.avgDurationMinutes
    }
  };
}

// ─── DB ────────────────────────────────────────────────────────────────────────

async function saveReport(channel, videoCount, analysis) {
  try {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id  text NOT NULL,
        channel_name text NOT NULL,
        channel_handle text,
        channel_thumbnail text,
        subscriber_count bigint,
        video_count int,
        analysis    jsonb NOT NULL,
        created_at  timestamptz DEFAULT now()
      )
    `);

    const result = await db.query(
      `INSERT INTO reports
         (channel_id, channel_name, channel_handle, channel_thumbnail, subscriber_count, video_count, analysis)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        channel.id,
        channel.name,
        channel.handle,
        channel.thumbnailUrl,
        channel.subscriberCount,
        videoCount,
        JSON.stringify(analysis)
      ]
    );

    return result.rows[0].id;
  } catch (err) {
    console.error('[saveReport]', err.message);
    return null;
  }
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

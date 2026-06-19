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

  const prompt = `You are a brutal, specific creator intelligence analyst. Your job is to surface NON-OBVIOUS insights that a viewer who casually watches this channel would NOT already know.

RULES:
- Never say anything that is obvious from the channel topic (e.g. "food channel posts food content")
- Every insight must be specific and data-backed from the video titles/stats provided
- Gaps must be topics this creator has NOT covered based on the title data — not generic suggestions
- Hook patterns must include the EXACT formula with specific words/structures from the titles
- Percentages must be estimated from the actual data, not made up

CHANNEL: ${channel.name}${channel.handle ? ' (' + channel.handle + ')' : ''}
Subscribers: ${fmtNum(channel.subscriberCount)} | Total views: ${fmtNum(channel.viewCountTotal)}
Channel avg views: ${fmtNum(Math.round(allViewsAvg))} | Top 20 avg: ${fmtNum(Math.round(topViewsAvg))}
Description: ${channel.description}

TOP 20 VIDEOS BY VIEWS (these are the outliers — what's the pattern that makes them outperform?):
${videoList(top20)}

OUTPERFORMERS (${fmtNum(Math.round(topViewsAvg * 1.5))}+ views):
${outperformers.map(v => `"${v.title}" | ${fmtNum(v.viewCount)} views`).join('\n') || 'None significantly above average'}

RECENT 30 VIDEOS (chronological — what is this creator doing NOW vs before?):
${videoList(recent, false)}

CADENCE:
- Avg ${cadence.avgDaysBetweenVideos} days between uploads (~${cadence.videosPerMonth}/month)
- Peak upload day: ${cadence.peakDay} | Avg duration: ${cadence.avgDurationMinutes}min
- Range: ${cadence.shortestMinutes}–${cadence.longestMinutes}min

Return a JSON object with exactly these keys:
- hooks: { primaryPattern: "the EXACT title formula with specific words/structure e.g. '[adjective] [food] that [unexpected outcome]'", examples: ["3 real titles from the data"], frequency: "X of top 20 videos use this", secondaryPatterns: ["second specific pattern", "third specific pattern"] }
- thumbnails: { formula: "specific visual formula inferred from title patterns and channel style — be precise", characteristics: ["3 specific visual elements"], textOverlayStyle: "specific font/style/placement if inferrable" }
- cadence: { schedule: "specific posting pattern with days/times", consistency: "specific observation about variance in their schedule", durationStrategy: "what the duration range reveals about their strategy", peakPerformanceWindow: "when their best-performing videos were published" }
- audience: { primaryProfile: "specific psychographic description — who exactly watches this and why, not just demographics", estimatedAge: "age range", viewerIntent: "specific intent — what problem/desire brings them here", loyaltySignal: "specific observation about engagement quality from the data" }
- pillars: array of 3 objects: { name: "specific sub-niche name", percentage: number (sum to 100), description: "what specific videos fall here and why they perform" }
- monetization: { primaryApproach: "specific monetization model with evidence from titles/descriptions", signals: ["3 specific title/description signals that reveal this"], brandAffinities: "specific brand categories with examples of likely sponsors" }
- gaps: array of 3 objects: { opportunity: "specific topic/format NOT in the title data", rationale: "specific evidence from what IS in the data that proves this is an open lane" }`;

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
      max_tokens: 2048,
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

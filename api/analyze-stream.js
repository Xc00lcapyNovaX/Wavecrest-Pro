import { resolveChannel, fetchVideos, looksLikeYouTubeInput } from '../lib/youtube.js';
import { runAnalysis } from '../lib/analysis.js';
import { saveReport } from '../lib/db.js';
import { getUser, getUserByApiKey } from '../lib/auth.js';
import { checkUsage } from '../lib/plans.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url', code: 'INVALID_INPUT' });
  if (!looksLikeYouTubeInput(url)) {
    return res.status(400).json({ error: 'That doesn’t look like a YouTube channel, handle, or video URL', code: 'INVALID_INPUT' });
  }

  const { YOUTUBE_API_KEY, GROQ_API_KEY } = process.env;
  if (!YOUTUBE_API_KEY || !GROQ_API_KEY) {
    console.error('[analyze-stream] missing YOUTUBE_API_KEY or GROQ_API_KEY');
    return res.status(500).json({ error: 'Server isn’t configured yet', code: 'SERVER_MISCONFIGURED' });
  }

  // Identify the caller: API key (Bearer) wins, then session cookie, else anonymous.
  // Anonymous stays allowed — the edge middleware IP-limits it to 5/hour.
  let user = null;
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ')) {
    user = await getUserByApiKey(authz.slice(7)).catch(() => null);
    if (!user) return res.status(401).json({ error: 'Invalid or revoked API key', code: 'BAD_API_KEY' });
  } else {
    user = await getUser(req).catch(() => null);
  }

  if (user) {
    const usage = await checkUsage(user).catch(() => ({ allowed: true }));
    if (!usage.allowed) {
      return res.status(429).json({
        error: `Monthly limit reached (${usage.used}/${usage.limit} analyses on the ${user.plan} plan)`,
        code: 'PLAN_LIMIT',
        used: usage.used,
        limit: usage.limit
      });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let channel = null;
  try {
    send('progress', { step: 1, label: 'Fetching channel info' });
    channel = await resolveChannel(url, YOUTUBE_API_KEY);

    send('progress', { step: 2, label: `Found ${channel.name} · fetching videos` });
    const videos = await fetchVideos(channel.uploadsPlaylistId, YOUTUBE_API_KEY, 100);
    if (videos.length < 3) { send('error', { message: 'Too few public videos (need 3+)', code: 'TOO_FEW_VIDEOS' }); res.end(); return; }

    send('progress', { step: 3, label: `${videos.length} videos loaded · running AI analysis` });
    const analysis = await runAnalysis(channel, videos, GROQ_API_KEY);

    send('progress', { step: 4, label: 'Saving report' });
    // A failed save shouldn't discard the analysis — report just won't be shareable.
    const reportId = await saveReport(channel, videos.length, analysis, user?.id ?? null);

    send('done', {
      reportId,
      channel: { id: channel.id, name: channel.name, handle: channel.handle, subscriberCount: channel.subscriberCount, thumbnailUrl: channel.thumbnailUrl, publishedAt: channel.publishedAt },
      videoCount: videos.length,
      analysis
    });
  } catch (err) {
    console.error('[analyze-stream]', err.message, {
      inputUrl: url,
      channelId: channel?.id,
      channelName: channel?.name,
      uploadsPlaylistId: channel?.uploadsPlaylistId,
      ytStatus: err.status,
      ytReason: err.reason,
      ytEndpoint: err.endpoint
    });
    send('error', { message: err.message || 'Analysis failed — try again', code: 'ANALYSIS_FAILED' });
  }

  res.end();
}

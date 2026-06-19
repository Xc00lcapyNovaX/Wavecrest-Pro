import { resolveChannel, fetchVideos } from '../lib/youtube.js';
import { runAnalysis } from '../lib/analysis.js';
import { saveReport } from '../lib/db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const url = (req.query.url || '').trim();
  if (!url) { res.status(400).end('Missing url'); return; }

  const { YOUTUBE_API_KEY, GROQ_API_KEY } = process.env;
  if (!YOUTUBE_API_KEY || !GROQ_API_KEY) { res.status(500).end('Missing env vars'); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send('progress', { step: 1, label: 'Fetching channel info' });
    const channel = await resolveChannel(url, YOUTUBE_API_KEY);

    send('progress', { step: 2, label: `Found ${channel.name} · fetching videos` });
    const videos = await fetchVideos(channel.uploadsPlaylistId, YOUTUBE_API_KEY, 100);
    if (videos.length < 3) { send('error', { message: 'Too few public videos (need 3+)' }); res.end(); return; }

    send('progress', { step: 3, label: `${videos.length} videos loaded · running AI analysis` });
    const analysis = await runAnalysis(channel, videos, GROQ_API_KEY);

    send('progress', { step: 4, label: 'Saving report' });
    const reportId = await saveReport(channel, videos.length, analysis);

    send('done', {
      reportId,
      channel: { id: channel.id, name: channel.name, handle: channel.handle, subscriberCount: channel.subscriberCount, thumbnailUrl: channel.thumbnailUrl, publishedAt: channel.publishedAt },
      videoCount: videos.length,
      analysis
    });
  } catch (err) {
    console.error('[analyze-stream]', err);
    send('error', { message: err.message || 'Analysis failed — try again' });
  }

  res.end();
}

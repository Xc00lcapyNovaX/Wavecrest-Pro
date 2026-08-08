const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

// Cheap pre-flight check before any API call: a YouTube URL in any supported
// form, or a bare handle. Rejects garbage early without burning quota.
export function looksLikeYouTubeInput(input) {
  if (typeof input !== 'string') return false;
  const s = input.trim();
  if (!s || s.length > 200) return false;
  if (/^@?[\w.-]{3,30}$/.test(s)) return true; // bare handle
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/\S+/i.test(s);
}

export async function ytFetch(endpoint, apiKey) {
  const r = await fetch(`${YOUTUBE_API}/${endpoint}&key=${apiKey}`);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let msg = `YouTube API error (${r.status})`;
    let reason = null;
    try {
      const json = JSON.parse(text);
      msg = json.error?.message || msg;
      reason = json.error?.errors?.[0]?.reason || null;
    } catch {}
    const err = new Error(msg);
    err.status = r.status;
    err.reason = reason;
    err.endpoint = endpoint.split('?')[0];
    throw err;
  }
  return r.json();
}

export async function resolveChannel(url, apiKey) {
  url = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^m\./i, '');
  if (!/[./]/.test(url)) url = '@' + url.replace(/^@/, '');

  const handleMatch    = url.match(/(?:youtube\.com\/)?@([\w.-]+)/);
  const channelIdMatch = url.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  const videoMatch     = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  const legacyMatch    = url.match(/youtube\.com\/(?:user|c)\/([\w.-]+)/);

  if (channelIdMatch) {
    const r = await ytFetch(`channels?part=snippet,statistics,contentDetails&id=${channelIdMatch[1]}`, apiKey);
    if (!r.items?.length) throw new Error('Channel not found');
    return extractChannelInfo(r.items[0]);
  }
  if (handleMatch) {
    const r = await ytFetch(`channels?part=snippet,statistics,contentDetails&forHandle=@${handleMatch[1]}`, apiKey);
    if (!r.items?.length) throw new Error(`No channel found for @${handleMatch[1]}`);
    return extractChannelInfo(r.items[0]);
  }
  if (videoMatch) {
    const vr = await ytFetch(`videos?part=snippet&id=${videoMatch[1]}`, apiKey);
    if (!vr.items?.length) throw new Error('Video not found');
    const cr = await ytFetch(`channels?part=snippet,statistics,contentDetails&id=${vr.items[0].snippet.channelId}`, apiKey);
    if (!cr.items?.length) throw new Error('Channel not found');
    return extractChannelInfo(cr.items[0]);
  }
  if (legacyMatch) {
    const r = await ytFetch(`channels?part=snippet,statistics,contentDetails&forUsername=${legacyMatch[1]}`, apiKey);
    if (r.items?.length) return extractChannelInfo(r.items[0]);
  }
  throw new Error('Could not parse that URL. Try: youtube.com/@handle or a video URL');
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
    thumbnailUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || '',
    publishedAt: item.snippet?.publishedAt || ''
  };
}

export async function fetchVideos(playlistId, apiKey, maxVideos = 100, onProgress = () => {}) {
  if (!playlistId) throw new Error('Could not find channel uploads playlist');
  const videoIds = [];
  let pageToken = '';
  while (videoIds.length < maxVideos) {
    const perPage = Math.min(50, maxVideos - videoIds.length);
    let ep = `playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${perPage}`;
    if (pageToken) ep += `&pageToken=${pageToken}`;
    const r = await ytFetch(ep, apiKey);
    if (!r.items?.length) break;
    for (const item of r.items) { const vid = item.snippet?.resourceId?.videoId; if (vid) videoIds.push(vid); }
    onProgress({ phase: 'listing', count: videoIds.length });
    pageToken = r.nextPageToken || '';
    if (!pageToken || videoIds.length >= maxVideos) break;
  }
  const videos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(',');
    const r = await ytFetch(`videos?part=snippet,statistics,contentDetails&id=${ids}`, apiKey);
    if (r.items) videos.push(...r.items);
    onProgress({ phase: 'stats', count: videos.length, total: videoIds.length });
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
    thumbnailUrl: v.snippet?.thumbnails?.maxres?.url || v.snippet?.thumbnails?.high?.url || ''
  }));
}

function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

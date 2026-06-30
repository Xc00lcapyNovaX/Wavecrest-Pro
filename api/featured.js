import { getPool } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = getPool();
    const result = await db.query(
      `SELECT id, channel_name, channel_handle, channel_thumbnail, subscriber_count, video_count, analysis
       FROM reports ORDER BY created_at DESC LIMIT 1`
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No reports yet' });
    const row = result.rows[0];
    return res.status(200).json({
      reportId: row.id,
      channel: { name: row.channel_name, handle: row.channel_handle, thumbnailUrl: row.channel_thumbnail, subscriberCount: parseInt(row.subscriber_count || 0) },
      videoCount: row.video_count,
      analysis: row.analysis
    });
  } catch (err) {
    console.error('[featured]', err.message);
    return res.status(500).json({ error: 'DB error' });
  }
}

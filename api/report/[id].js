// api/report/[id].js
// GET /api/report/:id — fetch a saved analysis report

import pg from 'pg';
const { Pool } = pg;

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
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id } = req.query;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid report ID' });
  }

  try {
    const db = getPool();
    const result = await db.query(
      `SELECT id, channel_id, channel_name, channel_handle, channel_thumbnail,
              subscriber_count, video_count, analysis, created_at
       FROM reports WHERE id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const row = result.rows[0];
    return res.status(200).json({
      reportId: row.id,
      channel: {
        id: row.channel_id,
        name: row.channel_name,
        handle: row.channel_handle,
        thumbnailUrl: row.channel_thumbnail,
        subscriberCount: parseInt(row.subscriber_count || 0)
      },
      videoCount: row.video_count,
      analysis: row.analysis,
      createdAt: row.created_at
    });
  } catch (err) {
    console.error('[report/id]', err.message);
    return res.status(500).json({ error: 'Failed to fetch report' });
  }
}

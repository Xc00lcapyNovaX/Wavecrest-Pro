import pg from 'pg';
const { Pool } = pg;

let pool;
export function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id       text NOT NULL,
      channel_name     text NOT NULL,
      channel_handle   text,
      channel_thumbnail text,
      subscriber_count bigint,
      video_count      int,
      analysis         jsonb NOT NULL,
      created_at       timestamptz DEFAULT now()
    )
  `);
  tableReady = true;
}

export async function saveReport(channel, videoCount, analysis) {
  try {
    const db = getPool();
    await ensureTable(db);
    const result = await db.query(
      `INSERT INTO reports (channel_id, channel_name, channel_handle, channel_thumbnail, subscriber_count, video_count, analysis)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [channel.id, channel.name, channel.handle, channel.thumbnailUrl, channel.subscriberCount, videoCount, JSON.stringify(analysis)]
    );
    return result.rows[0].id;
  } catch (err) {
    console.error('[saveReport]', err.message);
    return null;
  }
}

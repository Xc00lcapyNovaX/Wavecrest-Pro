import pg from 'pg';
const { Pool } = pg;

let pool;
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DB_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('No DB_URL or DATABASE_URL set');
    pool = new Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: true }
    });
  }
  return pool;
}

// Safety net only — canonical schema lives in migrations/ (npm run migrate).
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
      user_id          uuid,
      created_at       timestamptz DEFAULT now()
    )
  `);
  await db.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id uuid`);
  tableReady = true;
}

export async function saveReport(channel, videoCount, analysis, userId = null) {
  try {
    const db = getPool();
    await ensureTable(db);
    const result = await db.query(
      `INSERT INTO reports (channel_id, channel_name, channel_handle, channel_thumbnail, subscriber_count, video_count, analysis, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [channel.id, channel.name, channel.handle, channel.thumbnailUrl, channel.subscriberCount, videoCount, JSON.stringify(analysis), userId]
    );
    return result.rows[0].id;
  } catch (err) {
    console.error('[saveReport]', err);
    return null;
  }
}

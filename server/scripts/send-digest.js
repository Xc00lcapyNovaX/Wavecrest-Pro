#!/usr/bin/env node
/**
 * Wavecrest Pro — Daily trend digest sender
 * Run with: node server/scripts/send-digest.js
 * Called by GitHub Actions after update-trends.py seeds the DB.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { sendDailyDigest } = require('../email');

const BASE_URL = process.env.BASE_URL || 'https://wavecrest.pro';
const DRY_RUN  = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] DATABASE_URL is required');
  process.exit(1);
}

if (!process.env.RESEND_API_KEY && !DRY_RUN) {
  console.warn('[WARN] RESEND_API_KEY not set — emails will be logged only');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wavecrest',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const crypto = require('crypto');

async function ensureDigestToken(client, userId) {
  const { rows } = await client.query(`SELECT digest_token FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.digest_token) return rows[0].digest_token;
  const token = crypto.randomBytes(20).toString('hex');
  await client.query(`UPDATE users SET digest_token = $1 WHERE id = $2`, [token, userId]);
  return token;
}

async function getTodaysTrends(client) {
  // Try today first, fall back to most recent date with data
  const today = new Date().toISOString().slice(0, 10);

  let { rows } = await client.query(
    `SELECT topic, score, platform FROM trends WHERE fetched_at = $1 ORDER BY id DESC LIMIT 30`,
    [today]
  );

  let date = today;
  if (!rows.length) {
    const { rows: latest } = await client.query(
      `SELECT fetched_at FROM trends ORDER BY fetched_at DESC LIMIT 1`
    );
    if (!latest.length) return { trends: [], date: today };
    date = latest[0].fetched_at instanceof Date
      ? latest[0].fetched_at.toISOString().slice(0, 10)
      : String(latest[0].fetched_at);
    ({ rows } = await client.query(
      `SELECT topic, score, platform FROM trends WHERE fetched_at = $1 ORDER BY id DESC LIMIT 30`,
      [date]
    ));
  }

  // Sort: hot first, then rising, then warm
  const order = { hot: 0, rising: 1, warm: 2 };
  rows.sort((a, b) => (order[a.score] ?? 3) - (order[b.score] ?? 3));

  return { trends: rows.slice(0, 10), date };
}

async function getSubscribers(client) {
  const { rows } = await client.query(
    `SELECT id, email, name FROM users
     WHERE digest_enabled = true AND email IS NOT NULL
     ORDER BY created_at ASC`
  );
  return rows;
}

async function run() {
  console.log(`\n🌊 Wavecrest Pro — Daily Digest Sender`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Base URL: ${BASE_URL}\n`);

  const client = await pool.connect();
  try {
    const { trends, date } = await getTodaysTrends(client);

    if (!trends.length) {
      console.log('  ⚠ No trends found for today — skipping digest.');
      return;
    }

    console.log(`  ✓ Got ${trends.length} trends for ${date}`);
    console.log(`    Hot: ${trends.filter(t => t.score === 'hot').length} | Rising: ${trends.filter(t => t.score === 'rising').length} | Warm: ${trends.filter(t => t.score === 'warm').length}\n`);

    const subscribers = await getSubscribers(client);
    console.log(`  ✓ ${subscribers.length} digest subscribers\n`);

    if (!subscribers.length) {
      console.log('  No subscribers — nothing to send.');
      return;
    }

    let sent = 0, failed = 0, skipped = 0;

    for (const user of subscribers) {
      try {
        const token = await ensureDigestToken(client, user.id);

        if (DRY_RUN) {
          console.log(`  [DRY] Would email: ${user.email}`);
          skipped++;
          continue;
        }

        await sendDailyDigest({
          to: user.email,
          name: user.name || user.email.split('@')[0],
          trends,
          date,
          baseUrl: BASE_URL,
          unsubscribeToken: token,
        });

        console.log(`  ✓ Sent to ${user.email}`);
        sent++;

        // Small delay to avoid rate limiting (Resend: ~10 req/s on free tier)
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error(`  ✗ Failed for ${user.email}: ${err.message}`);
        failed++;
      }
    }

    console.log(`\n  📧 Digest complete: ${sent} sent, ${failed} failed, ${skipped} skipped`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('[FATAL] Digest script crashed:', err.message);
  process.exit(1);
});

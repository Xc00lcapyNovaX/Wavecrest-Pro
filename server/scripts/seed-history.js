#!/usr/bin/env node
/**
 * Seed 30 days of historical trend data into PostgreSQL.
 * Uses today's trends.json as a base and creates realistic variations
 * for past dates so analytics/predictions actually work.
 *
 * Run once: NODE_ENV=production node scripts/seed-history.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wavecrest',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const TRENDS_FILE = path.join(__dirname, '..', '..', 'public', 'trends.json');
const DAYS = 30;

// Realistic topic pools per platform for variation
const TOPIC_POOLS = {
  youtube: [
    '▶️ GRWM morning routines', '▶️ Minimalist apartment tours', '▶️ AI music generation tools',
    '▶️ Speed coding challenges', '▶️ DIY room makeover timelapse', '▶️ Retro gaming nostalgia',
    '▶️ Budget travel hacks', '▶️ Car detailing ASMR', '▶️ Tiny house living tours',
    '▶️ 3D printing oddities', '▶️ Micro-adventure weekends', '▶️ Coding tutorial series',
    '▶️ Lo-fi study setups', '▶️ Meal prep for the week', '▶️ Gym transformation videos',
    '▶️ Language learning 30 day challenge', '▶️ van life full tour', '▶️ tech setup upgrades 2026',
  ],
  tiktok: [
    '♪ #BookTok dark academia', '♪ Silent vlog trend', '♪ POV acting skits',
    '♪ Thrift flip challenges', '♪ Skincare routine layers', '♪ #CleanTok deep cleaning',
    '♪ #NailTok chrome art', '♪ Analog photography revival', '♪ #HairTok curtain bangs',
    '♪ Storytime animated shorts', '♪ #FitnessTok home workouts', '♪ Clean girl aesthetic',
    '♪ Cottage core cooking', '♪ Night routine GRWM', '♪ That girl morning routine',
    '♪ Romanticize your life', '♪ Situationship advice', '♪ Ick list trend',
  ],
  instagram: [
    '📸 Street style lookbooks', '📸 Golden hour photography', '📸 Coffee shop aesthetic reels',
    '📸 Meal prep aesthetic reels', '📸 Sunset drone cinematography', '📸 #OOTD street fashion',
    '📸 Studio apartment hacks', '📸 Pet rescue stories', '📸 Cafe hopping vlogs',
    '📸 Vintage fashion hauls', '📸 Cottagecore baking reels', '📸 #PlantTok propagation tips',
    '📸 Pilates body journey', '📸 Linen fashion aesthetic', '📸 Coastal grandmother style',
    '📸 Gallery wall inspo', '📸 Apartment decor on a budget', '📸 Europe travel dumps',
  ],
  general: [
    '🔥 AI coding assistants', '🔥 Longevity supplements trend', '🔥 Ozempic for weight loss',
    '🔥 Gen Z work culture debate', '🔥 Quiet luxury fashion', '🔥 Deinfluencing movement',
    '🔥 Digital nomad visas', '🔥 AI image detection tools', '🔥 Soft life aesthetic',
    '🔥 Dopamine dressing', '🔥 Brain rot humor', '🔥 NPC streaming trend',
    '🔥 Rage baiting content', '🔥 Eras tour impact', '🔥 Dupe culture',
  ],
};

const ALL_TOPICS = Object.entries(TOPIC_POOLS).flatMap(([platform, topics]) =>
  topics.map(topic => ({ topic, platform }))
);

function pickScore(dayIndex, topicIndex) {
  // Create some "trending arcs" — topics rise and fall
  const combined = (dayIndex + topicIndex * 7) % 30;
  if (combined < 6) return 'hot';
  if (combined < 16) return 'rising';
  return 'warm';
}

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function seedHistoricalData() {
  const client = await pool.connect();
  try {
    // Load today's real trends as anchor
    let todayTrends = [];
    try {
      const data = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf-8'));
      todayTrends = data.trends || [];
      console.log(`📄 Loaded ${todayTrends.length} real trends from trends.json`);
    } catch {
      console.log('⚠️  Could not load trends.json — using topic pools only');
    }

    let totalInserted = 0;

    for (let daysAgo = DAYS; daysAgo >= 1; daysAgo--) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      const dateStr = d.toISOString().slice(0, 10);

      // Check if this date already has data
      const { rows: existing } = await client.query(
        'SELECT COUNT(*) AS cnt FROM trends WHERE fetched_at = $1', [dateStr]
      );
      if (parseInt(existing[0].cnt, 10) > 0) {
        console.log(`  ↳ ${dateStr} — already has data, skipping`);
        continue;
      }

      // Shuffle topics with a date-based seed for consistency
      const seed = parseInt(dateStr.replace(/-/g, ''), 10);
      const shuffled = seededShuffle(ALL_TOPICS, seed);

      // Pick 25-35 topics for this day
      const count = 25 + (seed % 11);
      const dayTopics = shuffled.slice(0, count);

      // Mix in some of today's real trends (with variation)
      const realSample = seededShuffle(todayTrends, seed + 1).slice(0, 10);

      await client.query('BEGIN');
      let inserted = 0;

      for (let i = 0; i < dayTopics.length; i++) {
        const { topic, platform } = dayTopics[i];
        const score = pickScore(daysAgo, i);
        await client.query(
          `INSERT INTO trends (topic, score, platform, traffic, fetched_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [topic, score, platform, 0, dateStr]
        );
        inserted++;
      }

      // Add real trend samples for this past day
      for (let i = 0; i < realSample.length; i++) {
        const t = realSample[i];
        const score = pickScore(daysAgo, dayTopics.length + i);
        try {
          await client.query(
            `INSERT INTO trends (topic, score, platform, traffic, fetched_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [t.topic, score, t.platform || 'general', 0, dateStr]
          );
          inserted++;
        } catch { /* skip dups */ }
      }

      await client.query('COMMIT');
      totalInserted += inserted;
      console.log(`  ✓ ${dateStr} — inserted ${inserted} trends`);
    }

    console.log(`\n✅ Historical seed complete — ${totalInserted} trends across ${DAYS} days`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ Historical seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedHistoricalData();

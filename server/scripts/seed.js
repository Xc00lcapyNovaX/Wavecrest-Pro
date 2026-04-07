#!/usr/bin/env node
/**
 * Seed script — loads trends from trends.json into PostgreSQL.
 * Run with: npm run seed
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const trendsRouter = require('../routes/trends');

(async () => {
  try {
    console.log('🌱 Seeding trends from trends.json...');
    await trendsRouter.seedTrendsFromFile();
    console.log('✓ Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('✗ Seeding failed:', err.message);
    process.exit(1);
  }
})();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCadence, fmtNum } from '../lib/analysis.js';

const vid = (publishedAt, duration = 600) => ({ publishedAt, duration });

test('computeCadence returns empty object for fewer than 2 videos', () => {
  assert.deepEqual(computeCadence([]), {});
  assert.deepEqual(computeCadence([vid('2026-01-01T12:00:00Z')]), {});
});

test('computeCadence computes weekly cadence', () => {
  const videos = [
    vid('2026-01-05T12:00:00Z'),  // Mondays, 7 days apart
    vid('2026-01-12T12:00:00Z'),
    vid('2026-01-19T12:00:00Z'),
    vid('2026-01-26T12:00:00Z')
  ];
  const c = computeCadence(videos);
  assert.equal(c.avgDaysBetweenVideos, 7);
  assert.equal(c.videosPerMonth, 4.3);
  assert.equal(c.peakDay, 'Mon');
});

test('computeCadence duration stats in minutes', () => {
  const videos = [
    vid('2026-01-01T00:00:00Z', 300),   // 5 min
    vid('2026-01-03T00:00:00Z', 900)    // 15 min
  ];
  const c = computeCadence(videos);
  assert.equal(c.avgDurationMinutes, 10);
  assert.equal(c.shortestMinutes, 5);
  assert.equal(c.longestMinutes, 15);
});

test('computeCadence ignores invalid dates and zero durations', () => {
  const videos = [
    vid('2026-01-01T00:00:00Z', 0),
    vid('not-a-date', 600),
    vid('2026-01-08T00:00:00Z', 600)
  ];
  const c = computeCadence(videos);
  assert.equal(c.avgDaysBetweenVideos, 7);
  assert.equal(c.avgDurationMinutes, 10);
});

test('fmtNum formats counts', () => {
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(21_000_000), '21.0M');
  assert.equal(fmtNum(4_500), '5K');
});

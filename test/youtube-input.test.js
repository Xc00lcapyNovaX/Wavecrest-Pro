import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeYouTubeInput } from '../lib/youtube.js';

test('accepts all supported YouTube URL shapes', () => {
  for (const input of [
    'https://www.youtube.com/@mkbhd',
    'youtube.com/@mkbhd',
    'm.youtube.com/@mkbhd',
    'https://youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'youtube.com/user/somelegacyname',
    'youtube.com/c/somelegacyname',
    '@mkbhd',
    'mkbhd'
  ]) {
    assert.equal(looksLikeYouTubeInput(input), true, `should accept: ${input}`);
  }
});

test('rejects garbage and non-YouTube URLs', () => {
  for (const input of [
    '',
    '   ',
    'https://vimeo.com/12345',
    'https://example.com/@mkbhd',
    'javascript:alert(1)',
    'a'.repeat(201),
    'two words here',
    null,
    undefined,
    42
  ]) {
    assert.equal(looksLikeYouTubeInput(input), false, `should reject: ${String(input).slice(0, 40)}`);
  }
});

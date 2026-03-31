import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('wander service: 云游故事幕数窗口应为 5 到 15 幕', () => {
  const source = readFileSync(
    new URL('../wander/service.ts', import.meta.url),
    'utf-8',
  );

  assert.match(source, /const WANDER_MAX_EPISODE_INDEX = 15;/u);
  assert.match(source, /const WANDER_MIN_ENDING_EPISODE_INDEX = 5;/u);
});

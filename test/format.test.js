import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clamp,
  escapeBlessed,
  formatCountdown,
  formatRelativeTime,
  formatTokens,
  maskKey,
  padStart,
  padVisible,
  stripBlessedTags,
} from '../lib/format.js';

test('formatTokens compacts magnitudes', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_400_000), '2.4M');
  assert.equal(formatTokens(1_200_000_000), '1.2B');
  assert.equal(formatTokens(NaN), '0');
});

test('maskKey hides the middle of long keys', () => {
  assert.equal(maskKey('sk-ant-oat01-abcdefgh'), 'sk-ant...efgh');
  assert.equal(maskKey('short'), 'sho...');
});

test('stripBlessedTags removes tags including bare closers', () => {
  assert.equal(stripBlessedTags('{green-fg}ok{/green-fg} {bold}x{/bold} {/}'), 'ok x ');
});

test('escapeBlessed removes braces', () => {
  assert.equal(escapeBlessed('{evil} data'), 'evil data');
});

test('formatRelativeTime renders both directions', () => {
  assert.equal(formatRelativeTime(new Date(Date.now() + 90 * 1000)), 'in 1m');
  assert.equal(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000 - 5 * 60 * 1000)), '2h 5m ago');
  assert.equal(formatRelativeTime(new Date(Date.now() + 500)), 'now');
  assert.equal(formatRelativeTime(new Date('bogus')), 'unknown');
});

test('formatCountdown shows seconds under an hour and stays coarse above', () => {
  const now = Date.parse('2026-07-14T00:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;

  try {
    assert.equal(formatCountdown(new Date(now + 45 * 60 * 1000 + 12 * 1000)), 'in 45m 12s');
    assert.equal(formatCountdown(new Date(now + 9 * 1000)), 'in 9s');
    assert.equal(formatCountdown(new Date(now - 3 * 60 * 1000 - 5 * 1000)), '3m 5s ago');
    assert.equal(formatCountdown(new Date(now + 2 * 60 * 60 * 1000)), 'in 2h'); // >= 1h stays coarse
    assert.equal(formatCountdown(new Date(now + 500)), 'now');
    assert.equal(formatCountdown(new Date('bogus')), 'unknown');
  } finally {
    Date.now = realNow;
  }
});

test('padVisible truncates with ellipsis and pads', () => {
  assert.equal(padVisible('abc', 5), 'abc  ');
  assert.equal(padVisible('abcdefgh', 5), 'abcd…');
  assert.equal(padStart('7', 3), '  7');
});

test('clamp bounds values and rejects NaN', () => {
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(NaN, 0, 100), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellWidth,
  clamp,
  escapeBlessed,
  formatCountdown,
  formatRelativeTime,
  formatTokens,
  maskKey,
  padStart,
  padVisible,
  sanitizeTerminalText,
  stripBlessedTags,
  stripBlessedColorTags,
  truncateTagged,
  truncateVisible,
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
  assert.equal(escapeBlessed('\x1b[31mred\x1b[0m\nnext'), 'red next');
  assert.equal(sanitizeTerminalText('safe\u202Etxt\u202C'), 'safetxt');
});

test('cell-aware formatting preserves graphemes and aligns wide characters', () => {
  assert.equal(cellWidth('中文'), 4);
  assert.equal(cellWidth('e\u0301'), 1);
  assert.equal(padVisible('中文', 6), '中文  ');
  assert.equal(cellWidth(padVisible('中文', 6)), 6);
  assert.equal(truncateVisible('中文測試', 5), '中文…');
  assert.equal(truncateVisible('Ae\u0301B', 2), 'A…');

  const tagged = truncateTagged('{203-fg}{bold}中文測試{/bold}{/203-fg}', 5);
  assert.equal(stripBlessedTags(tagged), '中文…');
  assert.equal(cellWidth(tagged), 5);
  assert.match(tagged, /\{\/bold\}\{\/203-fg\}$/);
  assert.equal(stripBlessedColorTags('{203-fg}red{/203-fg} {bold}bold{/bold}'), 'red {bold}bold{/bold}');
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
  assert.equal(padVisible('abcde', 5), 'abcde');
  assert.equal(padVisible('abcdefgh', 5), 'abcd…');
  assert.equal(padStart('7', 3), '  7');
});

test('clamp bounds values and rejects NaN', () => {
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(NaN, 0, 100), 0);
});

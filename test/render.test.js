import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripBlessedTags } from '../lib/format.js';
import { formatUsageItem, formatUsageItemCompact, solidProgressBar, usageTone } from '../lib/render.js';

const HOUR = 60 * 60 * 1000;

function item(overrides = {}) {
  return {
    kind: 'usage',
    key: 'a:x',
    label: 'Session',
    value: '25%',
    percent: 25,
    elapsedPercent: 60,
    paceDelta: -35,
    projectedPercent: 60,
    forecastMethod: 'rate',
    severity: '',
    active: false,
    resetAt: new Date(Date.now() + HOUR),
    depletesAt: null,
    details: [],
    ...overrides,
  };
}

test('usageTone respects severity over percent', () => {
  assert.equal(usageTone(10), 'green');
  assert.equal(usageTone(75), 'yellow');
  assert.equal(usageTone(95), 'red');
  assert.equal(usageTone(10, 'warning'), 'yellow');
  assert.equal(usageTone(10, 'exceeded'), 'red');
});

test('solidProgressBar extends a forecast ghost tail past the fill', () => {
  // ghost tail from used level to the projected level
  assert.equal(stripBlessedTags(solidProgressBar(25, 60, 20, 'green')), '[█████░░░░░░░        ]');
  assert.match(solidProgressBar(25, 60, 20, 'green'), /\{green-fg\}█+░+\{\/green-fg\}/);
  // tail is colored by where the projection lands
  assert.match(solidProgressBar(50, 95, 20, 'green'), /\{red-fg\}░+\{\/red-fg\}/);
  // projection behind the fill collapses into it
  assert.equal(stripBlessedTags(solidProgressBar(50, 40, 20, 'green')), '[██████████          ]');
  // no projection: plain fill
  assert.equal(stripBlessedTags(solidProgressBar(50, NaN, 20, 'green')), '[██████████          ]');
});

test('bar ghost tail comes only from a live projection', () => {
  const projected = stripBlessedTags(formatUsageItemCompact(item({
    percent: 40,
    elapsedPercent: 50,
    projectedPercent: 90,
  }), 100));
  assert.ok(projected.includes('░'), 'projection draws the ghost tail');
  // no projection: plain fill, elapsed time is not drawn on the bar
  const baseline = stripBlessedTags(formatUsageItemCompact(item({
    percent: 50,
    elapsedPercent: 100,
    projectedPercent: NaN,
  }), 100));
  assert.ok(!baseline.includes('░'), 'no tail without a measured projection');
});

test('compact item renders one line with percent, pace, projection, reset', () => {
  const line = stripBlessedTags(formatUsageItemCompact(item(), 100));
  assert.ok(!line.includes('\n'));
  assert.match(line, /Session/);
  assert.match(line, /25%/);
  assert.match(line, /✓ pace/); // behind pace → ok
  assert.match(line, /→60%/);
  assert.match(line, /reset /);
  assert.ok(!line.includes('dry'), 'no dry warning without depletesAt');
});

test('compact item shows ahead-of-pace and dry warning', () => {
  const line = stripBlessedTags(formatUsageItemCompact(item({
    percent: 80,
    paceDelta: 20,
    depletesAt: new Date(Date.now() + HOUR / 2),
  }), 100));
  assert.match(line, /▲\+20%/);
  assert.match(line, /⚠ dry/);
});

test('compact item folds count values inline and puts details on their own line', () => {
  const text = stripBlessedTags(formatUsageItemCompact(item({
    value: '35/1,000 3%',
    percent: 3,
    projectedPercent: 4,
    details: [{ label: 'search-prime', value: '2' }, { label: 'web-reader', value: '33' }],
  }), 100));
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /35\/1,000/);
  assert.ok(!lines[0].includes('search-prime'), 'details should not be on the main line');
  assert.match(lines[1], /^\s+search-prime 2 · web-reader 33$/);
  assert.ok(!/35\/1,000 3%/.test(text), 'percent should be stripped from the folded value');
});

test('detailed item renders multi-line with bar and pace meta', () => {
  const text = stripBlessedTags(formatUsageItem(item(), 96));
  const lines = text.split('\n');
  assert.ok(lines.length >= 3);
  assert.match(lines[1], /\[/);
  assert.match(text, /pace 25% used vs 60% elapsed/);
  assert.ok(!text.includes('run dry'));

  const warning = stripBlessedTags(formatUsageItem(item({ depletesAt: new Date(Date.now() + HOUR) }), 96));
  assert.match(warning, /run dry/);
});

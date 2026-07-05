import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildUsageItem,
  elapsedPercent,
  toDate,
} from '../lib/forecast.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('toDate handles ISO strings, epoch ms, and garbage', () => {
  assert.equal(toDate('2026-07-03T00:00:00Z')?.getTime(), Date.parse('2026-07-03T00:00:00Z'));
  assert.equal(toDate(1720000000000)?.getTime(), 1720000000000);
  assert.equal(toDate('not a date'), null);
  assert.equal(toDate(undefined), null);
  assert.equal(toDate(NaN), null);
});

test('elapsedPercent measures window progress', () => {
  const now = Date.parse('2026-07-03T02:00:00Z');
  const resetAt = new Date(Date.parse('2026-07-03T05:00:00Z')); // 5h window, 2h elapsed
  assert.equal(Math.round(elapsedPercent({ resetAt, periodMs: 5 * HOUR, now })), 40);
  assert.equal(elapsedPercent({ resetAt: null, periodMs: 5 * HOUR, now }), null);
});

test('linear projection extrapolates the window so far to reset', () => {
  const now = Date.parse('2026-07-03T02:00:00Z');
  const resetAt = new Date(now + 3 * HOUR); // 5h window, 40% elapsed

  const item = buildUsageItem({ key: 's', label: 'Session', percent: 20, resetAt, periodMs: 5 * HOUR, now });
  assert.equal(item.forecastMethod, 'linear');
  assert.equal(Math.round(item.projectedPercent), 50); // 20% in 40% of the window
  assert.equal(item.depletesAt, null); // lands under 100%

  // Weekly windows use the same model.
  const weekly = buildUsageItem({ key: 'w', label: 'Weekly', percent: 26, resetAt: new Date(now + 4.2 * DAY), periodMs: 7 * DAY, now });
  assert.equal(Math.round(weekly.projectedPercent), 65); // 26% in 40% of the week
});

test('projection hides at the very start of a window and at zero usage', () => {
  const now = Date.parse('2026-07-03T00:00:00Z');

  const fresh = buildUsageItem({
    key: 'f', label: 'S', percent: 5,
    resetAt: new Date(now + 5 * HOUR - 3000), // 3s into the window
    periodMs: 5 * HOUR,
    now,
  });
  assert.equal(fresh.projectedPercent, null);

  const idle = buildUsageItem({ key: 'i', label: 'S', percent: 0, resetAt: new Date(now + HOUR), periodMs: 5 * HOUR, now });
  assert.equal(idle.projectedPercent, null);
});

test('pace delta compares used% with elapsed%', () => {
  const now = Date.parse('2026-07-03T00:00:00Z');
  const resetAt = new Date(now + 3.5 * DAY); // half the week elapsed

  const behind = buildUsageItem({ key: 'a', label: 'W', percent: 30, resetAt, periodMs: 7 * DAY, now });
  assert.equal(Math.round(behind.paceDelta), -20);

  const ahead = buildUsageItem({ key: 'b', label: 'W', percent: 80, resetAt, periodMs: 7 * DAY, now });
  assert.equal(Math.round(ahead.paceDelta), 30);
});

test('depletion time is where the linear pace crosses 100% before reset', () => {
  const now = Date.parse('2026-07-03T00:00:00Z');
  const resetAt = new Date(now + 2 * DAY); // 5 of 7 days elapsed

  // 80% used in ~71% of the window → crosses 100% at day 6.25, before reset.
  const warning = buildUsageItem({ key: 'w1', label: 'W', percent: 80, resetAt, periodMs: 7 * DAY, now });
  assert.ok(warning.depletesAt instanceof Date);
  assert.equal(warning.depletesAt.getTime(), now - 5 * DAY + 6.25 * DAY);

  // Behind pace → projection stays under 100% → no depletion time.
  const behind = buildUsageItem({ key: 'w2', label: 'W', percent: 50, resetAt, periodMs: 7 * DAY, now });
  assert.equal(behind.depletesAt, null);

  // Fully exhausted → dry now.
  const dry = buildUsageItem({ key: 'w3', label: 'W', percent: 100, resetAt, periodMs: 7 * DAY, now });
  assert.equal(dry.depletesAt.getTime(), now);
});

test('buildUsageItem keeps the standard shape', () => {
  const item = buildUsageItem({
    key: 'a:x',
    label: 'Session',
    percent: 25,
    resetAt: new Date(Date.now() + HOUR),
    periodMs: 5 * HOUR,
  });
  assert.equal(item.kind, 'usage');
  assert.equal(item.value, '25%');
  assert.ok(Number.isFinite(item.projectedPercent));
  assert.ok(Number.isFinite(item.elapsedPercent));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnexpectedQuotaReset } from '../lib/reset-detection.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.parse('2026-07-17T08:00:00Z');

function observation(percent, {
  observedAt = NOW - 5 * MINUTE_MS,
  resetAt = new Date(NOW + 4 * HOUR_MS),
} = {}) {
  return { percent, observedAt, resetAt };
}

test('detects a quota returning to fresh before its advertised reset', () => {
  assert.equal(
    isUnexpectedQuotaReset(observation(82), observation(0), { now: NOW }),
    true,
  );
  assert.equal(
    isUnexpectedQuotaReset(observation(90), observation(20), { now: NOW }),
    true,
  );
});

test('detects an unexpected full reset when a provider has no reset timestamp', () => {
  assert.equal(
    isUnexpectedQuotaReset(observation(35, { resetAt: null }), observation(0), { now: NOW }),
    true,
  );
});

test('does not celebrate a normal countdown reset or a stale comparison', () => {
  assert.equal(
    isUnexpectedQuotaReset(
      observation(82, { resetAt: new Date(NOW + MINUTE_MS) }),
      observation(0),
      { now: NOW },
    ),
    false,
  );
  assert.equal(
    isUnexpectedQuotaReset(
      observation(82, { observedAt: NOW - 20 * MINUTE_MS }),
      observation(0),
      { now: NOW },
    ),
    false,
  );
});

test('ignores ordinary usage corrections and first observations', () => {
  assert.equal(
    isUnexpectedQuotaReset(observation(52), observation(47), { now: NOW }),
    false,
  );
  assert.equal(isUnexpectedQuotaReset(null, observation(0), { now: NOW }), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRetryAfterDate } from '../lib/http.js';

test('parseRetryAfterDate handles delay-seconds relative to a stable clock', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  assert.equal(parseRetryAfterDate('90', now).getTime(), now + 90_000);
  assert.equal(parseRetryAfterDate('0', now).getTime(), now);
});

test('parseRetryAfterDate accepts HTTP dates and rejects invalid values', () => {
  assert.equal(
    parseRetryAfterDate('Wed, 15 Jul 2026 06:00:00 GMT').toISOString(),
    '2026-07-15T06:00:00.000Z',
  );
  assert.equal(parseRetryAfterDate('not-a-retry-time'), null);
  assert.equal(parseRetryAfterDate(null), null);
});

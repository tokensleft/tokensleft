import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  antigravityStateDbPath,
  buildAntigravityItems,
  readProtoFields,
  unwrapOAuthEnvelope,
} from '../providers/antigravity.js';
import { buildCopilotItems } from '../providers/copilot.js';
import { buildGrokItems, pickGrokToken } from '../providers/grok.js';
import { anchoredMonthBounds, buildOpencodeItems, startOfUtcWeek, sumCostRange } from '../providers/opencode.js';

// --- copilot --------------------------------------------------------------------

test('buildCopilotItems maps paid quota snapshots', () => {
  const items = buildCopilotItems({
    copilot_plan: 'individual',
    quota_reset_date: '2026-08-01',
    quota_snapshots: {
      premium_interactions: { percent_remaining: 40 },
      chat: { unlimited: true, percent_remaining: 100 },
    },
  });
  assert.deepEqual(items.map((item) => item.label), ['Premium']);
  assert.equal(items[0].percent, 60);
  assert.ok(items[0].resetAt instanceof Date);
});

test('buildCopilotItems maps free-tier counted quotas', () => {
  const items = buildCopilotItems({
    limited_user_quotas: { chat: 30, completions: 1000 },
    monthly_quotas: { chat: 50, completions: 2000 },
    limited_user_reset_date: '2026-08-01',
  });
  assert.deepEqual(items.map((item) => item.label), ['Chat', 'Completions']);
  assert.equal(items[0].percent, 40);
  assert.equal(items[1].percent, 50);
});

// --- grok ----------------------------------------------------------------------

test('pickGrokToken picks the first non-expired key and reports expiry', () => {
  const now = Date.now();
  const future = new Date(now + 3600_000).toISOString();
  const past = new Date(now - 3600_000).toISOString();

  assert.equal(pickGrokToken({ a: { key: 'k1', expires_at: future } }, now).token, 'k1');
  assert.equal(pickGrokToken({ a: { key: 'k1', expires_at: past }, b: { key: 'k2' } }, now).token, 'k2');
  assert.match(pickGrokToken({ a: { key: 'k1', expires_at: past } }, now).error, /expired/);
  assert.match(pickGrokToken({}, now).error, /invalid/);
  assert.equal(pickGrokToken(null, now, ' manual ').token, 'manual');
});

test('buildGrokItems maps billing config to a credits item', () => {
  const items = buildGrokItems({
    config: {
      used: { val: 25 },
      monthlyLimit: { val: 100 },
      onDemandCap: { val: 0 },
      billingPeriodEnd: new Date(Date.now() + 86400_000).toISOString(),
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].percent, 25);
  assert.deepEqual(items[0].details, [{ label: 'pay-as-you-go', value: 'disabled' }]);
  assert.deepEqual(buildGrokItems({ config: {} }), []);
});

// --- antigravity ------------------------------------------------------------------

function varint(value) {
  const bytes = [];

  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);

    if (value > 0) {
      byte |= 0x80;
    }

    bytes.push(byte);
  } while (value > 0);

  return Buffer.from(bytes);
}

function lengthDelimited(fieldNum, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([varint(fieldNum * 8 + 2), varint(data.length), data]);
}

function varintField(fieldNum, value) {
  return Buffer.concat([varint(fieldNum * 8), varint(value)]);
}

test('unwrapOAuthEnvelope decodes the double-base64 protobuf envelope', () => {
  const inner = Buffer.concat([
    lengthDelimited(1, 'access-token-x'),
    lengthDelimited(3, 'refresh-token-y'),
    lengthDelimited(4, varintField(1, 1776967024)),
  ]);
  const payload = lengthDelimited(1, inner.toString('base64'));
  const wrapper = Buffer.concat([
    lengthDelimited(1, 'oauthTokenInfoSentinelKey'),
    lengthDelimited(2, payload),
  ]);
  const outer = lengthDelimited(1, wrapper).toString('base64');

  const tokens = unwrapOAuthEnvelope(outer);
  assert.equal(tokens.accessToken, 'access-token-x');
  assert.equal(tokens.refreshToken, 'refresh-token-y');
  assert.equal(tokens.expirySeconds, 1776967024);

  assert.equal(unwrapOAuthEnvelope('not base64 proto'), null);
});

test('readProtoFields handles varint and length-delimited fields', () => {
  const buf = Buffer.concat([varintField(2, 300), lengthDelimited(5, 'hello')]);
  const fields = readProtoFields(buf);
  assert.equal(fields[2].value, 300);
  assert.equal(fields[5].data.toString('utf8'), 'hello');
});

test('buildAntigravityItems pools models and keeps the tightest quota', () => {
  const resetTime = new Date(Date.now() + 3600_000).toISOString();
  const items = buildAntigravityItems({
    models: {
      a: { model: 'M1', displayName: 'Gemini 3 Pro (High)', quotaInfo: { remainingFraction: 0.5, resetTime } },
      b: { model: 'M2', displayName: 'Gemini 3 Pro (Low)', quotaInfo: { remainingFraction: 0.9, resetTime } },
      c: { model: 'M3', displayName: 'Claude Sonnet 4.5', quotaInfo: { remainingFraction: 1 } },
      d: { model: 'MODEL_PLACEHOLDER_M9', displayName: 'Hidden', quotaInfo: { remainingFraction: 0 } },
      e: { model: 'M5', displayName: 'Internal', isInternal: true },
    },
  });
  assert.deepEqual(items.map((item) => item.label), ['Gemini Pro', 'Claude']);
  assert.equal(items[0].percent, 50); // lowest remaining fraction wins the pool
  assert.equal(items[1].percent, 0);
});

test('antigravityStateDbPath honors the env override', () => {
  assert.equal(antigravityStateDbPath({ ANTIGRAVITY_STATE_DB: 'X:/db.vscdb' }), 'X:/db.vscdb');
});

// --- opencode ----------------------------------------------------------------------

test('opencode window math: utc week, anchored month, range sums', () => {
  const now = Date.parse('2026-07-03T12:00:00Z'); // Friday
  assert.equal(startOfUtcWeek(now), Date.parse('2026-06-29T00:00:00Z')); // Monday

  const anchor = Date.parse('2026-05-15T08:30:00Z');
  const bounds = anchoredMonthBounds(now, anchor);
  assert.equal(bounds.startMs, Date.parse('2026-06-15T08:30:00Z'));
  assert.equal(bounds.endMs, Date.parse('2026-07-15T08:30:00Z'));

  const calendar = anchoredMonthBounds(now, NaN);
  assert.equal(calendar.startMs, Date.parse('2026-07-01T00:00:00Z'));

  const rows = [
    { createdMs: now - 1000, cost: 1.5 },
    { createdMs: now - 10 * 60 * 60 * 1000, cost: 2 },
  ];
  assert.equal(sumCostRange(rows, now - 5 * 60 * 60 * 1000, now), 1.5);
});

test('buildOpencodeItems produces session/weekly/monthly dollar windows', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const rows = [
    { createdMs: now - 60_000, cost: 6 },
    { createdMs: now - 2 * 24 * 60 * 60 * 1000, cost: 9 },
  ];
  const items = buildOpencodeItems(rows, { now });
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly', 'Monthly']);
  assert.equal(items[0].percent, 50);   // $6 of $12 session
  assert.equal(items[1].percent, 50);   // $15 of $30 week
  assert.equal(items[2].percent, 25);   // $15 of $60 month
  assert.match(items[0].value, /\$6\.00\/\$12/);

  const fractional = buildOpencodeItems([{ createdMs: now - 60_000, cost: 6.55 }], { now })[0];
  assert.equal(Math.round(fractional.percent), 55);
  assert.match(fractional.value, /^55% /);
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { discoverClaudeSettingsKeys, matchesHost } from '../lib/claude-settings.js';
import { tokenNeedsRefresh } from '../providers/claude.js';
import { buildCodexItems } from '../providers/codex.js';
import {
  buildGeminiItems,
  collectQuotaBuckets,
  credsNeedRefresh,
  mapTierToPlan,
  parseOauthClientCreds,
  readFirstStringDeep,
} from '../providers/gemini.js';

test('discoverClaudeSettingsKeys finds tokens in settings profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-keys-'));
  after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'x' }));
  await writeFile(join(dir, 'settings.zlm.json'), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: 'zai-key-123', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
  }));
  await writeFile(join(dir, 'settings.big.json'), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: 'big-key-456', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' },
  }));
  await writeFile(join(dir, 'other.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'ignored' } }));

  const found = await discoverClaudeSettingsKeys(dir);
  assert.equal(found.length, 2);

  const zai = found.find((entry) => entry.name === 'zlm');
  assert.equal(zai.key, 'zai-key-123');
  assert.ok(matchesHost(zai.baseUrl, 'z.ai'));
  assert.ok(!matchesHost(zai.baseUrl, 'bigmodel.cn'));

  const big = found.find((entry) => entry.name === 'big');
  assert.ok(matchesHost(big.baseUrl, 'bigmodel.cn'));
});

test('discoverClaudeSettingsKeys handles missing dir', async () => {
  assert.deepEqual(await discoverClaudeSettingsKeys(join(tmpdir(), 'tokensleft-nope')), []);
});

test('tokenNeedsRefresh triggers within the 5-minute buffer', () => {
  const now = Date.now();
  assert.equal(tokenNeedsRefresh(now + 10 * 60 * 1000, now), false);
  assert.equal(tokenNeedsRefresh(now + 2 * 60 * 1000, now), true);
  assert.equal(tokenNeedsRefresh(now - 1000, now), true);
  assert.equal(tokenNeedsRefresh(null, now), false);
});

test('buildCodexItems maps windows, extras, reviews, credits', () => {
  const now = Date.now();
  const data = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 12, reset_after_seconds: 3600, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 40, reset_at: Math.floor(now / 1000) + 86400 },
    },
    additional_rate_limits: [
      { limit_name: 'GPT-5.2-Codex-Mini', rate_limit: { primary_window: { used_percent: 5 } } },
    ],
    code_review_rate_limit: { primary_window: { used_percent: 66 } },
    credits: { balance: 250 },
  };
  const items = buildCodexItems(data, {}, { now });
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly', 'Mini', 'Reviews', 'Credits']);
  assert.equal(items[0].percent, 12);
  assert.equal(items[1].percent, 40);
  assert.equal(items[4].value, '250 left');
  assert.equal(Math.round(items[4].percent), 75);
});

test('buildCodexItems prefers header percents and hides zero credits', () => {
  const items = buildCodexItems(
    { rate_limit: { primary_window: { used_percent: 12 } }, credits: { balance: 0 } },
    { 'x-codex-primary-used-percent': '55' },
  );
  assert.equal(items[0].percent, 55);
  assert.ok(!items.some((item) => item.label === 'Credits'));
});

test('parseOauthClientCreds extracts constants from oauth2.js source', () => {
  const source = 'const OAUTH_CLIENT_ID =\n  "abc.apps.googleusercontent.com";\nconst OAUTH_CLIENT_SECRET = \'GOCSPX-xyz\';';
  assert.deepEqual(parseOauthClientCreds(source), { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-xyz' });
  assert.equal(parseOauthClientCreds('nothing here'), null);
});

test('gemini quota buckets collect deeply and pick the lowest per family', () => {
  const now = Date.now();
  const quota = {
    userQuota: [
      { modelId: 'gemini-3-pro', remainingFraction: 0.8, resetTime: new Date(now + 3600_000).toISOString() },
      { nested: { modelId: 'gemini-3-pro-preview', remainingFraction: 0.25, resetTime: new Date(now + 3600_000).toISOString() } },
      { modelId: 'gemini-3-flash', remainingFraction: 1 },
    ],
  };
  assert.equal(collectQuotaBuckets(quota).length, 3);

  const items = buildGeminiItems(quota, { now });
  assert.deepEqual(items.map((item) => item.label), ['Pro', 'Flash']);
  assert.equal(items[0].percent, 75); // lowest remaining pro bucket wins
  assert.equal(items[1].percent, 0);
});

test('buildGeminiItems drops epoch-zero reset times', () => {
  const items = buildGeminiItems({ q: [{ modelId: 'gemini-3-pro', remainingFraction: 0, resetTime: '1970-01-01T00:00:00Z' }] });
  assert.equal(items[0].percent, 100);
  assert.equal(items[0].resetAt, null);
});

test('gemini helpers: tier mapping, deep string search, creds expiry', () => {
  assert.equal(mapTierToPlan('standard-tier'), 'Paid');
  assert.equal(mapTierToPlan('free-tier', { hd: 'corp.com' }), 'Workspace');
  assert.equal(mapTierToPlan('free-tier', {}), 'Free');
  assert.equal(readFirstStringDeep({ a: { currentTier: { id: 'free-tier' } } }, ['id']), 'free-tier');

  const now = Date.now();
  assert.equal(credsNeedRefresh({ access_token: 'x', expiry_date: now + 60 * 60 * 1000 }, now), false);
  assert.equal(credsNeedRefresh({ access_token: 'x', expiry_date: now + 60 * 1000 }, now), true);
  assert.equal(credsNeedRefresh({ refresh_token: 'r' }, now), true);
});

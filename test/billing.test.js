import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { googleAccountStatus, googleCreditItems, readGoogleOverageSettings } from '../lib/google-billing.js';
import { collectExpiryAlerts } from '../lib/expiry-alerts.js';
import { buildCopilotItems } from '../providers/copilot.js';
import { buildOpencodeQuotaItems, createOpencodeProvider } from '../providers/opencode.js';
import { buildAntigravityItems, createAntigravityProvider } from '../providers/antigravity.js';
import { loadNodeSqlite } from '../lib/runtime.js';

const sqlite = await loadNodeSqlite();

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-billing-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

function mockFetch(t, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = run;
  t.after(() => { globalThis.fetch = previous; });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('Google tier parsing distinguishes Starter, paid access, unavailable and blocked accounts', () => {
  const free = googleAccountStatus({ currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier', name: 'Antigravity Starter Quota' } });
  assert.equal(free.plan, 'Free / Starter');
  assert.equal(free.free, true);
  assert.equal(free.blocked, false);
  const paid = googleAccountStatus({ currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] });
  assert.equal(paid.plan, 'Google AI Pro');
  assert.equal(paid.blocked, false, 'a rejected alternative tier must not revoke the current tier');
  assert.equal(googleAccountStatus({ ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] }).blocked, true);
  assert.equal(googleAccountStatus(null).plan, 'Unknown plan');
});

test('Antigravity Starter does not advertise paid model access or call GPT-OSS Claude', () => {
  const data = { models: {
    flash: { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 1 } },
    claude: { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 1 } },
    oss: { displayName: 'GPT-OSS 120B', quotaInfo: { remainingFraction: 1 } },
    disabled: { displayName: 'Gemini Pro', isAvailable: false, quotaInfo: { remainingFraction: 1 } },
  } };
  const free = buildAntigravityItems(data, { account: { free: true } });
  assert.deepEqual(free.map((item) => item.label), ['Gemini Flash']);
  assert.equal(free[0].elapsedPercent, null, 'an unknown quota period must not create a false pace forecast');
  assert.ok(buildAntigravityItems(data).some((item) => item.label === 'GPT-OSS 120B'));
});

test('Antigravity fetch verifies the actual tier separately from the model catalog', { skip: !sqlite }, async (t) => {
  const dir = await tempDir(t);
  const dbPath = join(dir, 'state.vscdb');
  const varint = (value) => {
    const bytes = [];
    do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
  };
  const field = (number, value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  };
  const inner = Buffer.concat([field(1, 'account-token'), field(3, 'account-refresh')]);
  const envelope = field(1, Buffer.concat([
    field(1, 'oauthTokenInfoSentinelKey'), field(2, field(1, inner.toString('base64'))),
  ])).toString('base64');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('antigravityUnifiedStateSync.oauthToken', envelope);
  db.close();
  let account = { currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier' } };
  mockFetch(t, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer account-token');
    assert.doesNotMatch(String(url), /generateContent|oauth2/);
    if (String(url).includes(':loadCodeAssist')) {
      assert.deepEqual(JSON.parse(options.body), { metadata: { ideType: 'ANTIGRAVITY' } });
      return json(account);
    }
    return json({ models: {
      flash: { displayName: 'Gemini Flash', quotaInfo: { remainingFraction: 1 } },
      claude: { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 1 } },
    } });
  });
  const provider = await createAntigravityProvider({ ANTIGRAVITY_STATE_DB: dbPath, TOKENSLEFT_READ_ONLY: '1' });
  let snapshot = await provider.fetch();
  assert.equal(snapshot.plan, 'Free / Starter');
  assert.ok(!snapshot.items.some((item) => item.label === 'Claude'));
  account = { ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] };
  snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'INELIGIBLE');
  assert.deepEqual(snapshot.items, []);
  account = { currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '100' }] } };
  snapshot = await provider.fetch();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'Google AI Pro');
  assert.equal(snapshot.items.find((item) => item.key === 'antigravity:ai-credits').value, '100 left');
});

test('Google credit balances preserve unknown values and explicit zero, and read overage preferences', async (t) => {
  const entries = [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '10' }, { creditType: 'GOOGLE_ONE_AI', creditAmount: '20' }, { creditType: 'OTHER', creditAmount: '999' }];
  assert.equal(googleCreditItems({ paidTier: { availableCredits: entries } }, { prefix: 'g' })[0].value, '30 left');
  assert.equal(googleCreditItems({ paidTier: { availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '0' }] } }, { prefix: 'g' })[0].value, '0 left');
  for (const amount of ['-1', 'invalid', '', null]) {
    assert.equal(googleCreditItems({ paidTier: { availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: amount }] } }, { prefix: 'g' })[0].value, 'unavailable');
  }
  assert.equal(googleCreditItems({}, { prefix: 'g' })[0].value, 'unavailable');
  const dir = await tempDir(t);
  const path = join(dir, 'settings.json');
  assert.equal(await readGoogleOverageSettings(path), 'unknown');
  await writeFile(path, JSON.stringify({ billing: { overageStrategy: 'always' } }));
  assert.equal(await readGoogleOverageSettings(path), 'always');
  await writeFile(path, JSON.stringify({ useG1Credits: false }));
  assert.equal(await readGoogleOverageSettings(path, { antigravity: true }), 'never');
});

test('Copilot AI credit billing uses fractional counters and does not relabel unavailable credits as legacy requests', () => {
  const items = buildCopilotItems({ token_based_billing: true, quota_snapshots: { premium_interactions: {
    entitlement: 200, quota_remaining: 72.6, remaining: 72, credits_used: 127,
    percent_remaining: 36.3, overage_permitted: false, has_quota: false,
  } } });
  assert.equal(items[0].label, 'AI credits');
  assert.equal(items[0].value, '127.4 / 200 used');
  assert.equal(items[0].percent, 63.7);
  assert.equal(items[0].severity, 'critical');
  assert.equal(items[1].value, 'not permitted');
  const unknown = buildCopilotItems({ token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, unlimited: true } } });
  assert.equal(unknown[0].kind, 'info');
  assert.match(unknown[0].value, /unavailable/);
  assert.ok(!unknown.some((item) => item.label === 'Premium'));
});

test('OpenCode uses server quota for every tier and avoids fabricated dollar limits', async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  mockFetch(t, async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer test-go-key');
    if (String(url).includes('/inference/')) return json({}, 404);
    return json({ useBalance: true, usage: {
      rolling: { percent: 90, status: 'ok', resetsAt: '2099-01-01T00:00:00Z' },
      weekly: { percent: 75 }, monthly: { percent: 20 },
    } });
  });
  const provider = await createOpencodeProvider({ OPENCODE_DATA_DIR: dir, OPENCODE_GO_API_KEY: 'test-go-key' });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(snapshot.items[0].percent, 90);
  assert.equal(snapshot.items.at(-1).value, 'enabled');
  assert.doesNotMatch(provider.render(snapshot, 100, 'detail'), /\$12|\$30|\$60/);
  assert.deepEqual(buildOpencodeQuotaItems({ usage: { rolling: { percent: null }, weekly: { percent: 120 }, monthly: { percent: '5' } } }), []);
});

test('OpenCode quota failure keeps local usage and never substitutes guessed quota', async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  mockFetch(t, async (url) => { calls.push(String(url)); return json({}, 429); });
  const provider = await createOpencodeProvider({ OPENCODE_DATA_DIR: dir, OPENCODE_GO_API_KEY: 'key' });
  const snapshot = await provider.fetch();
  assert.equal(calls.length, 1, 'rate limits must not trigger a fallback retry');
  assert.equal(snapshot.items[0].kind, 'empty');
  assert.match(snapshot.items[0].message, /429/);
});

test('Expiry reminders fire once at each threshold and ignore expired, empty, paused or future grants', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const endsAt = new Date(now + 12 * 3600_000);
  const snapshot = { results: [{ name: 'work', ok: true, items: [], resetCredits: { grants: [
    { remaining: 1, paused: false, endsAt },
    { remaining: 0, endsAt }, { remaining: 1, paused: true, endsAt },
    { remaining: 1, startsAt: new Date(now + 24 * 3600_000), endsAt },
    { remaining: 1, endsAt: 'invalid' },
  ] } }] };
  const seen = new Map();
  const options = { providerId: 'claude', providerTitle: 'Claude', now };
  assert.equal(collectExpiryAlerts(snapshot, seen, options).length, 1);
  assert.equal(collectExpiryAlerts(snapshot, seen, options).length, 0);
  assert.match(collectExpiryAlerts(snapshot, seen, { ...options, now: now + 11.5 * 3600_000 })[0].text, /within 1h/);
  assert.equal(collectExpiryAlerts(snapshot, seen, { ...options, now: endsAt.getTime() }).length, 0);
  assert.equal(collectExpiryAlerts({ ok: true, items: [{ kind: 'info', expiresAt: endsAt, remaining: 0 }] }, new Map(), options).length, 0);
});

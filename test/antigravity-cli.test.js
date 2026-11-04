import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyringCommand, parseAntigravityCliCredential, readAntigravityCliCredential } from '../lib/antigravity-auth.js';
import { buildAntigravityQuotaItems, createAntigravityProvider } from '../providers/antigravity.js';

const profile = (overrides = {}) => JSON.stringify({
  auth_method: 'consumer',
  token: { access_token: 'cli-access', refresh_token: 'cli-refresh', expiry: '2099-01-01T00:00:00Z' },
  ...overrides,
});
const tokens = () => parseAntigravityCliCredential(profile());
const quotaSummary = { groups: [
  { displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2099-01-07T00:00:00Z' },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2099-01-01T05:00:00Z' },
  ] },
  { displayName: 'Claude and GPT models', buckets: [
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2099-01-07T00:00:00Z' },
    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.6, resetTime: '2099-01-01T05:00:00Z' },
  ] },
] };

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('agy keyring parser reads Go OAuth expiry and macOS go-keyring encodings', () => {
  const raw = profile();
  const expected = { accessToken: 'cli-access', refreshToken: 'cli-refresh', expirySeconds: Date.parse('2099-01-01T00:00:00Z') / 1000 };
  for (const text of [raw, '\uFEFF' + raw, 'go-keyring-base64:' + Buffer.from(raw).toString('base64'), 'go-keyring-encoded:' + Buffer.from(raw).toString('hex')]) {
    assert.deepEqual(parseAntigravityCliCredential(text), expected);
  }
  assert.equal(parseAntigravityCliCredential(''), null);
  for (const text of ['null', 'not json', profile({ token: {} }), profile({ token: { access_token: {} } }), profile({ token: { access_token: 'x', expiry: 'bad' } })]) {
    assert.throws(() => parseAntigravityCliCredential(text), /Invalid|No OAuth/);
  }
  assert.throws(() => parseAntigravityCliCredential(profile({ auth_method: 'enterprise' })), /enterprise/);
});

test('keyring adapters request only the agy entry and distinguish missing credentials from access errors', async () => {
  assert.deepEqual(keyringCommand('darwin').args, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
  assert.deepEqual(keyringCommand('linux').args, ['lookup', 'service', 'gemini', 'username', 'antigravity']);
  assert.equal(keyringCommand('win32').file, 'powershell.exe');
  for (const osPlatform of ['win32', 'darwin', 'linux']) {
    const result = await readAntigravityCliCredential({ osPlatform, run(file, args, options, done) {
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout > 0);
      done(null, profile(), '');
    } });
    assert.equal(result.accessToken, 'cli-access');
    await assert.rejects(readAntigravityCliCredential({ osPlatform, run(file, args, options, done) {
      done(Object.assign(new Error('SECRET MUST NOT LEAK'), { code: 5 }), 'SECRET MUST NOT LEAK', 'SECRET MUST NOT LEAK');
    } }), (error) => /Cannot read/.test(error.message) && !/SECRET/.test(error.message));
  }
  for (const [osPlatform, code] of [['darwin', 44], ['linux', 1]]) {
    assert.equal(await readAntigravityCliCredential({ osPlatform, run(file, args, options, done) {
      done({ code }, '', '');
    } }), null);
  }
  await assert.rejects(readAntigravityCliCredential({ osPlatform: 'linux', run(file, args, options, done) {
    done({ code: 'ENOENT' }, '', '');
  } }), /install secret-tool/);
});

test('auto detection prefers agy keyring without an IDE DB and rereads account changes', async (t) => {
  const cliHome = await mkdtemp(join(tmpdir(), 'tokensleft-agy-'));
  t.after(() => rm(cliHome, { recursive: true, force: true }));
  let active = tokens();
  const seen = [];
  mockFetch(t, async (url, options) => {
    seen.push(options.headers.Authorization);
    assert.doesNotMatch(String(url), /oauth2|generateContent/);
    assert.match(options.headers['User-Agent'], /^antigravity\/cli\//);
    if (String(url).includes(':loadCodeAssist')) return json({ cloudaicompanionProject: 'test-cli-project', paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } });
    assert.match(String(url), /:retrieveUserQuotaSummary$/);
    assert.deepEqual(JSON.parse(options.body), { project: 'test-cli-project' });
    return json(quotaSummary);
  });
  const provider = await createAntigravityProvider({ ANTIGRAVITY_CLI_HOME: cliHome, ANTIGRAVITY_AUTH_SOURCE: 'auto', ANTIGRAVITY_STATE_DB: join(cliHome, 'missing.db'), TOKENSLEFT_READ_ONLY: '1' }, { readCliCredential: async () => active });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'Google AI Ultra 20x');
  assert.equal(snapshot.planId, 'g1-ultra-tier');
  assert.equal(snapshot.planMultiplier, 20);
  assert.equal(snapshot.items.find((item) => item.label === 'Claude/GPT 5h').percent, 40);
  assert.equal(snapshot.items.find((item) => item.label === 'Claude/GPT weekly').percent, 25);
  assert.equal(snapshot.items.filter((item) => item.kind === 'usage').length, 4);
  assert.ok(!snapshot.items.some((item) => ['unknown', 'unavailable'].includes(item.value)));
  assert.match(snapshot.items.find((item) => item.label === 'Credentials').value, /agy CLI/);
  assert.equal(snapshot.items.find((item) => item.label === 'Credentials').detailOnly, true);
  const compact = provider.render(snapshot, 98, 'compact');
  assert.match(compact, /Gemini weekly/);
  assert.match(compact, /Claude\/GPT weekly/);
  assert.doesNotMatch(compact, /unknown|unavailable|Credentials/);
  active = { ...tokens(), accessToken: 'new-account' };
  await provider.fetch();
  assert.deepEqual(seen, ['Bearer cli-access', 'Bearer cli-access', 'Bearer new-account', 'Bearer new-account']);
});

test('quota summary preserves independent 5h and weekly windows, reset dates and alert keys', () => {
  const items = buildAntigravityQuotaItems(quotaSummary, { now: Date.parse('2099-01-01T01:00:00Z') });
  assert.deepEqual(items.map((item) => item.label), ['Gemini 5h', 'Gemini weekly', 'Claude/GPT 5h', 'Claude/GPT weekly']);
  assert.deepEqual(items.map((item) => Math.round(item.percent)), [10, 20, 40, 25]);
  assert.equal(items[0].resetAt.toISOString(), '2099-01-01T05:00:00.000Z');
  assert.equal(items[1].resetAt.toISOString(), '2099-01-07T00:00:00.000Z');
  assert.equal(items[0].elapsedPercent, 20);
  assert.equal(new Set(items.map((item) => item.key)).size, 4);
  assert.equal(buildAntigravityQuotaItems(quotaSummary, { account: { free: true } }).length, 2);
  assert.deepEqual(buildAntigravityQuotaItems({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly' }] }] }), []);
  assert.deepEqual(buildAntigravityQuotaItems({ models: {} }), []);
});

test('quota API failures stay failures and never fall back to incomplete model catalog usage', async (t) => {
  const calls = [];
  mockFetch(t, async (url) => {
    calls.push(String(url));
    if (String(url).endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'project', paidTier: { id: 'g1-ultra-tier' } });
    return json({}, 503);
  });
  const provider = await createAntigravityProvider({ ANTIGRAVITY_AUTH_SOURCE: 'cli', TOKENSLEFT_READ_ONLY: '1' }, { readCliCredential: async () => tokens() });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.status, 503);
  assert.deepEqual(snapshot.items, []);
  assert.ok(calls.every((url) => !url.includes('fetchAvailableModels') && !url.includes('oauth2')));
});

test('inaccessible agy keyring surfaces an error without querying the IDE account', async (t) => {
  const cliHome = await mkdtemp(join(tmpdir(), 'tokensleft-agy-locked-'));
  t.after(() => rm(cliHome, { recursive: true, force: true }));
  mockFetch(t, () => { throw new Error('must not query another account'); });
  const provider = await createAntigravityProvider({ ANTIGRAVITY_CLI_HOME: cliHome }, {
    readCliCredential: async () => { throw new Error('Cannot read agy CLI system keyring.'); },
  });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'CRED');
  assert.match(snapshot.error, /keyring/);
});

test('explicit IDE override never reads the CLI keyring', async () => {
  const provider = await createAntigravityProvider({ ANTIGRAVITY_STATE_DB: join(tmpdir(), 'tokensleft-missing-ide.db') }, {
    readCliCredential: async () => { assert.fail('explicit IDE override must not read keyring'); },
  });
  assert.equal(provider, null);
});

test('agy read-only mode never refreshes expired or rejected CLI credentials', async (t) => {
  const calls = [];
  mockFetch(t, async (url) => { calls.push(String(url)); return json({}, 401); });
  let active = { ...tokens(), expirySeconds: 1 };
  const provider = await createAntigravityProvider({ ANTIGRAVITY_AUTH_SOURCE: 'cli', TOKENSLEFT_READ_ONLY: '1' }, { readCliCredential: async () => active });
  assert.equal((await provider.fetch()).status, 'EXPIRED');
  assert.equal(calls.length, 0);
  active = tokens();
  assert.equal((await provider.fetch()).status, 'EXPIRED');
  assert.ok(calls.length > 0);
  assert.ok(calls.every((url) => !url.includes('oauth2.googleapis.com')));
});

test('agy expired token refresh uses the Antigravity OAuth client and reports rejected grants', async (t) => {
  mockFetch(t, async (url, options) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('client_id'), '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
    assert.equal(form.get('refresh_token'), 'cli-refresh');
    return json({ error: 'invalid_grant' }, 400);
  });
  const provider = await createAntigravityProvider({ ANTIGRAVITY_AUTH_SOURCE: 'cli' }, { readCliCredential: async () => ({ ...tokens(), expirySeconds: 1 }) });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'EXPIRED');
  assert.match(snapshot.error, /invalid_grant/);
});

test('logged out agy session does not fall back to a different IDE account', async () => {
  let active = tokens();
  const provider = await createAntigravityProvider({ ANTIGRAVITY_AUTH_SOURCE: 'cli' }, { readCliCredential: async () => active });
  active = null;
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'CRED');
  assert.match(snapshot.error, /Run agy/);
});

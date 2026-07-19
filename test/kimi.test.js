import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildKimiItems,
  createKimiSessionScanner,
  createKimiProvider,
  findKimiCredential,
  kimiCodeHome,
  kimiCredentialPaths,
  kimiTokenExpired,
  kimiTokenNeedsRefresh,
  parseKimiWireChunk,
  parseKimiModelsPayload,
  parseKimiUsagePayload,
  readKimiKeyAccounts,
} from '../providers/kimi.js';

const FIXED_NOW = Date.parse('2026-07-17T00:00:00Z');

async function kimiHome(t, credentials) {
  const home = await mkdtemp(join(tmpdir(), 'tokensleft-kimi-'));
  const dir = join(home, 'credentials');
  const path = join(dir, 'kimi-code.json');
  await mkdir(dir, { recursive: true });
  const raw = JSON.stringify(credentials, null, 2);
  await writeFile(path, raw);
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true }));
  });
  return { home, path, raw };
}

function mockFetch(t, handler, { models = [] } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).endsWith('/models')) {
      return typeof models === 'function'
        ? models(url, options)
        : Promise.resolve(new Response(JSON.stringify({ data: models }), { status: 200 }));
    }

    return handler(url, options);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('Kimi credential candidates prefer the current CLI and retain legacy compatibility', () => {
  assert.deepEqual(kimiCredentialPaths({}, 'C:/Users/demo'), [
    join('C:/Users/demo', '.kimi-code', 'credentials', 'kimi-code.json'),
    join('C:/Users/demo', '.kimi', 'credentials', 'kimi-code.json'),
  ]);
  assert.deepEqual(kimiCredentialPaths({ KIMI_CODE_HOME: 'D:/kimi-home' }, 'ignored'), [
    join('D:/kimi-home', 'credentials', 'kimi-code.json'),
  ]);
  assert.deepEqual(kimiCredentialPaths({ KIMI_AUTH_PATH: 'D:/custom.json' }, 'ignored'), ['D:/custom.json']);
  assert.equal(kimiCodeHome({}, 'C:/Users/demo'), join('C:/Users/demo', '.kimi-code'));
  assert.equal(kimiCodeHome({ KIMI_CODE_HOME: 'D:/kimi-home' }, 'ignored'), 'D:/kimi-home');
  assert.equal(
    kimiCodeHome({ KIMI_AUTH_PATH: join('D:/portable-kimi', 'credentials', 'kimi-code.json') }, 'ignored'),
    join('D:/portable-kimi'),
  );
});

function kimiWireRecord({
  t = FIXED_NOW,
  model = 'kimi-code/k3',
  input = 10,
  cached = 20,
  cacheCreation = 30,
  output = 40,
  scope = 'turn',
} = {}) {
  return JSON.stringify({
    type: 'usage.record',
    time: t,
    model,
    usageScope: scope,
    usage: {
      inputOther: input,
      inputCacheRead: cached,
      inputCacheCreation: cacheCreation,
      output,
    },
  });
}

test('parseKimiWireChunk reads turn usage without touching conversation events', () => {
  const partial = '{"type":"usage.record"';
  const { events, remainder } = parseKimiWireChunk([
    JSON.stringify({ type: 'message', content: 'ignored' }),
    kimiWireRecord(),
  ].join('\n') + `\n${partial}`);

  assert.equal(remainder, partial);
  assert.deepEqual(events, [{
    t: FIXED_NOW,
    model: 'kimi-code/k3',
    input: 10,
    cacheRead: 20,
    cacheWrite: 30,
    output: 40,
  }]);
  assert.equal(parseKimiWireChunk(`${kimiWireRecord({ scope: 'session' })}\n`).events.length, 0);
});

test('Kimi session scanner aggregates main and subagent wire logs incrementally', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tokensleft-kimi-sessions-'));
  const mainDir = join(home, 'sessions', 'workdir', 'session-1', 'agents', 'main');
  const subagentDir = join(home, 'sessions', 'workdir', 'session-1', 'agents', 'researcher');
  const mainWire = join(mainDir, 'wire.jsonl');
  await mkdir(mainDir, { recursive: true });
  await mkdir(subagentDir, { recursive: true });
  await writeFile(mainWire, `${kimiWireRecord({ t: FIXED_NOW + 1000 })}\n`);
  await writeFile(
    join(subagentDir, 'wire.jsonl'),
    `${kimiWireRecord({ t: FIXED_NOW + 2000, input: 1, cached: 2, cacheCreation: 3, output: 4 })}\n`,
  );
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true }));
  });

  const scanner = createKimiSessionScanner(home);
  let result = await scanner.scan(FIXED_NOW + 60_000);
  assert.equal(result.ok, true);
  assert.equal(result.files, 2);
  assert.equal(result.models[0].today.messages, 2);
  assert.equal(result.models[0].today.input, 11);
  assert.equal(result.models[0].today.cacheRead, 22);
  assert.equal(result.models[0].today.cacheWrite, 33);
  assert.equal(result.models[0].today.output, 44);
  assert.equal(result.models[0].today.hasCost, true);
  assert.equal(result.models[0].today.hasUnknownCost, false);
  assert.ok(result.models[0].today.cost > 0);

  await appendFile(mainWire, `${kimiWireRecord({ t: FIXED_NOW + 3000, output: 5 })}\n`);
  result = await scanner.scan(FIXED_NOW + 60_000);
  assert.equal(result.models[0].today.messages, 3);
  assert.equal(result.models[0].today.output, 49);

  result = await scanner.scan(FIXED_NOW + 60_000);
  assert.equal(result.models[0].today.messages, 3);
});

test('Kimi session scanner reports a missing sessions directory', async () => {
  const scanner = createKimiSessionScanner(join(tmpdir(), 'tokensleft-kimi-missing'));
  const result = await scanner.scan();
  assert.equal(result.ok, false);
  assert.match(result.error, /no session logs/);
});

test('Kimi key accounts support numbered, single, and comma-separated forms', () => {
  const numbered = readKimiKeyAccounts({
    KIMI_CODE_API_KEY_1: '  first-key  ',
    KIMI_CODE_NAME_1: 'work',
    KIMI_CODE_API_KEY_2: 'second-key',
    KIMI_CODE_NAME_2: 'personal',
    KIMI_CODE_API_KEY: 'ignored-fallback',
  });
  assert.deepEqual(numbered.map((account) => ({
    id: account.id,
    name: account.name,
    token: account.credential.token,
    source: account.credential.source,
  })), [
    { id: 'key_1', name: 'work', token: 'first-key', source: 'KIMI_CODE_API_KEY_1' },
    { id: 'key_2', name: 'personal', token: 'second-key', source: 'KIMI_CODE_API_KEY_2' },
  ]);

  assert.equal(readKimiKeyAccounts({ KIMI_CODE_API_KEY: 'single-key' })[0].name, '');
  assert.deepEqual(
    readKimiKeyAccounts({ KIMI_CODE_API_KEYS: 'first, second, third' }).map((account) => [account.name, account.credential.token]),
    [['Account 1', 'first'], ['Account 2', 'second'], ['Account 3', 'third']],
  );
  assert.deepEqual(
    readKimiKeyAccounts({
      KIMI_CODE_API_KEY_1: 'first',
      KIMI_CODE_API_KEY_2: 'second',
      KIMI_CODE_NAME_2: 'personal',
    }).map((account) => account.name),
    ['Account 1', 'personal'],
  );
  assert.deepEqual(readKimiKeyAccounts({}), []);
});

test('Kimi token timing follows the official dynamic refresh threshold', () => {
  const nowSeconds = FIXED_NOW / 1000;
  const fresh = { access_token: 'token', expires_at: nowSeconds + 2000, expires_in: 3600 };
  const nearExpiry = { ...fresh, expires_at: nowSeconds + 1700 };

  assert.equal(kimiTokenNeedsRefresh(fresh, FIXED_NOW), false);
  assert.equal(kimiTokenNeedsRefresh(nearExpiry, FIXED_NOW), true);
  assert.equal(kimiTokenExpired(nearExpiry, FIXED_NOW), false);
  assert.equal(kimiTokenExpired({ ...fresh, expires_at: nowSeconds - 1 }, FIXED_NOW), true);
  assert.equal(kimiTokenExpired({ refresh_token: 'refresh-only' }, FIXED_NOW), true);
  assert.equal(kimiTokenNeedsRefresh({ access_token: 'no-expiry' }, FIXED_NOW), false);
});

test('parseKimiUsagePayload accepts current and drifted usage window fields', () => {
  const parsed = parseKimiUsagePayload({
    usage: {
      remaining: '600',
      limit: '1000',
      reset_at: '2026-07-24T00:00:00Z',
    },
    limits: [
      {
        detail: { used: 25, limit: 100, resetIn: 3600 },
        window: { duration: 300, timeUnit: 'MINUTE' },
      },
      {
        title: 'Daily cap',
        used: 2,
        limit: 20,
        resetTime: 1784336400,
        duration: 24,
        timeUnit: 'HOUR',
      },
    ],
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: '20000000000', amountLeft: '10000000000' },
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimit: { currency: 'USD', priceInCents: '20000' },
      monthlyUsed: { currency: 'USD', priceInCents: '5000' },
    },
    user: { userId: 'private-id', membership: { level: 'LEVEL_INTERMEDIATE' } },
    subType: 'TYPE_PURCHASE',
    totalQuota: { limit: '100', remaining: '75' },
    parallel: { limit: '20', details: ['request-a', 'request-b'] },
    authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
  }, { now: FIXED_NOW });

  assert.equal(parsed.summary.label, 'Weekly limit');
  assert.equal(parsed.summary.used, 400);
  assert.equal(parsed.summary.limit, 1000);
  assert.equal(parsed.summary.periodMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(parsed.summary.resetAt.toISOString(), '2026-07-24T00:00:00.000Z');
  assert.deepEqual(parsed.limits.map((row) => row.label), ['5h limit', 'Daily cap']);
  assert.equal(parsed.limits[0].periodMs, 5 * 60 * 60 * 1000);
  assert.equal(parsed.limits[0].resetAt.getTime(), FIXED_NOW + 3600_000);
  assert.equal(parsed.limits[1].periodMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(parsed.extraUsage, {
    balanceCents: 10000,
    totalCents: 20000,
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimitCents: 20000,
    monthlyUsedCents: 5000,
    currency: 'USD',
  });
  assert.deepEqual(parsed.membership, { level: 'Allegretto', type: 'Purchase', paid: true });
  assert.deepEqual(parsed.sharedQuota, { limit: 100, remaining: 75 });
  assert.deepEqual(parsed.parallel, { limit: 20, active: 2 });
  assert.deepEqual(parsed.authentication, { method: 'API Key', scope: 'Coding' });
});

test('parseKimiModelsPayload keeps public model capabilities and context sizes', () => {
  const models = parseKimiModelsPayload({ data: [
    {
      id: 'k3',
      display_name: 'K3',
      context_length: 1048576,
      supports_reasoning: true,
      supports_image_in: true,
      supports_video_in: true,
      supports_thinking_type: 'only',
    },
    { id: 'kimi-fast', display_name: 'K2.7 Coding Highspeed', context_length: 262144 },
    { display_name: 'missing id' },
  ] });

  assert.deepEqual(models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    contextLength: model.contextLength,
    supportsThinking: model.supportsThinking,
  })), [
    { id: 'k3', displayName: 'K3', contextLength: 1048576, supportsThinking: true },
    { id: 'kimi-fast', displayName: 'K2.7 Coding HighSpeed', contextLength: 262144, supportsThinking: false },
  ]);
  assert.deepEqual(parseKimiModelsPayload(null), []);
});

test('buildKimiItems renders plan limits and keeps Extra Usage informational', () => {
  const items = buildKimiItems({
    usage: { name: 'Weekly limit', used: 40, limit: 1000, resetAt: '2026-07-24T00:00:00Z' },
    limits: [
      {
        detail: { name: '5h limit', used: 150, limit: 100, ttl: 1800 },
        window: { duration: 5, timeUnit: 'HOUR' },
      },
      { detail: { name: 'Unavailable', used: 1, limit: 0 } },
    ],
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: 40000000000, amountLeft: 18208000000 },
      monthlyChargeLimitEnabled: false,
      monthlyUsed: { currency: 'CNY', priceInCents: 21792 },
    },
    totalQuota: { limit: 100, remaining: 82 },
    parallel: { limit: 20, details: ['one', 'two', 'three'] },
  }, {
    now: FIXED_NOW,
    models: [{
      id: 'k3',
      displayName: 'K3',
      contextLength: 1048576,
      supportsThinking: true,
      supportsImage: true,
      supportsVideo: true,
      supportsTools: true,
    }],
  });

  assert.deepEqual(items.map((item) => item.label), [
    'Weekly limit',
    '5h limit',
    'Shared quota',
    'Parallel',
    'Extra Usage',
    'Models',
  ]);
  assert.equal(items[0].percent, 4);
  assert.equal(items[0].value, '4%');
  assert.equal(items[1].percent, 100);
  assert.equal(items[1].value, '100%');
  assert.equal(items[2].value, '82/100 left');
  assert.equal(items[2].detailOnly, true);
  assert.equal(items[3].value, '3/20 active');
  assert.equal(items[3].detailOnly, true);
  assert.equal(items[4].kind, 'info');
  assert.equal(items[4].value, '¥182.08 left');
  assert.match(items[4].note, /¥217\.92/);
  assert.match(items[4].details.join('\n'), /Unlimited/);
  assert.equal(items[5].value, 'K3 1M');
  assert.equal(items[5].detailOnly, true);
  assert.match(items[5].details[0], /thinking.*image.*video.*tools/);
  assert.deepEqual(buildKimiItems(null), []);
});

test('findKimiCredential detects OAuth state and lets an explicit membership key win', async (t) => {
  const { home } = await kimiHome(t, { access_token: 'oauth-access', refresh_token: 'oauth-refresh' });
  const oauth = await findKimiCredential({ KIMI_CODE_HOME: home });
  assert.equal(oauth.kind, 'oauth');
  assert.equal(oauth.credentials.access_token, 'oauth-access');

  const manual = await findKimiCredential({ KIMI_CODE_HOME: home, KIMI_CODE_API_KEY: '  key-123  ' });
  assert.deepEqual(manual, { kind: 'api-key', token: 'key-123', source: 'KIMI_CODE_API_KEY' });
  assert.equal(await findKimiCredential({ KIMI_AUTH_PATH: join(home, 'missing.json') }), null);
});

test('Kimi provider reads a valid CLI token and maps /usages into reset-aware alerts', async (t) => {
  const { home } = await kimiHome(t, {
    access_token: 'current-access',
    refresh_token: 'current-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    expires_in: 3600,
  });
  const agentDir = join(home, 'sessions', 'workdir', 'session-1', 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'wire.jsonl'), `${kimiWireRecord({ t: Date.now() })}\n`);
  const calls = [];
  mockFetch(t, async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      usage: { used: 20, limit: 100, resetAt: new Date(Date.now() + 86400_000).toISOString() },
      limits: [{ detail: { name: '5h limit', used: 5, limit: 100, reset_in: 3600 }, window: { duration: 300, timeUnit: 'MINUTE' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const provider = await createKimiProvider({ KIMI_CODE_HOME: home });
  const snapshot = await provider.fetch();

  assert.equal(provider.id, 'kimi');
  assert.equal(provider.title, 'Kimi Code');
  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(snapshot.results[0].items.map((item) => item.percent), [20, 5]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer current-access');
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['Accept', 'Authorization']);
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.label), ['Weekly limit', '5h limit']);
  assert.equal(provider.headerStatus(snapshot).text, '1/1 OK');
  assert.match(provider.render(snapshot, 96, 'compact'), /Weekly limit/);
  assert.doesNotMatch(provider.render(snapshot, 96, 'compact'), /Local usage by model/);
  assert.equal(snapshot.local.ok, true);
  assert.match(provider.render(snapshot, 96, 'detail'), /Local usage by model/);
  assert.match(provider.render(snapshot, 96, 'detail'), /k3/);
});

test('Kimi provider refreshes an expired OAuth token and atomically persists the rotation', async (t) => {
  const { home, path } = await kimiHome(t, {
    access_token: 'expired-access',
    refresh_token: 'old-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 60,
    expires_in: 3600,
  });
  const calls = [];
  mockFetch(t, async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/api/oauth/token')) {
      assert.match(String(options.body), /grant_type=refresh_token/);
      assert.match(String(options.body), /refresh_token=old-refresh/);
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        token_type: 'Bearer',
        scope: 'openid',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return new Response(JSON.stringify({ usage: { used: 1, limit: 10 } }), { status: 200 });
  });

  const provider = await createKimiProvider({
    KIMI_CODE_HOME: home,
    KIMI_CODE_OAUTH_HOST: 'https://auth.example.test/',
  });
  const snapshot = await provider.fetch();
  const saved = JSON.parse(await readFile(path, 'utf8'));

  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://auth.example.test/api/oauth/token',
    'https://api.kimi.com/coding/v1/usages',
  ]);
  assert.equal(saved.access_token, 'new-access');
  assert.equal(saved.refresh_token, 'new-refresh');
  assert.equal(saved.expires_in, 7200);
  assert.ok(saved.expires_at > Date.now() / 1000);
});

test('Kimi provider force-refreshes OAuth once when /usages rejects a cached token', async (t) => {
  const { home } = await kimiHome(t, {
    access_token: 'rejected-access',
    refresh_token: 'refresh-after-401',
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    expires_in: 3600,
  });
  const calls = [];
  mockFetch(t, async (url, options) => {
    calls.push(String(url));

    if (String(url).endsWith('/api/oauth/token')) {
      return new Response(JSON.stringify({
        access_token: 'accepted-access',
        refresh_token: 'rotated-after-401',
        expires_in: 3600,
      }), { status: 200 });
    }

    if (options.headers.Authorization === 'Bearer rejected-access') {
      return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
    }

    assert.equal(options.headers.Authorization, 'Bearer accepted-access');
    return new Response(JSON.stringify({ usage: { used: 3, limit: 10 } }), { status: 200 });
  });

  const provider = await createKimiProvider({ KIMI_CODE_HOME: home });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.equal(snapshot.results[0].items[0].percent, 30);
  assert.deepEqual(calls, [
    'https://api.kimi.com/coding/v1/usages',
    'https://auth.kimi.com/api/oauth/token',
    'https://api.kimi.com/coding/v1/usages',
  ]);
});

test('Kimi read-only mode never refreshes or rewrites an expired credential', async (t) => {
  const { home, path, raw } = await kimiHome(t, {
    access_token: 'expired-access',
    refresh_token: 'must-not-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 60,
    expires_in: 3600,
  });
  const calls = [];
  mockFetch(t, async (url) => {
    calls.push(String(url));
    throw new Error('read-only Kimi must not make a request with an expired token');
  });

  const provider = await createKimiProvider({ KIMI_CODE_HOME: home, TOKENSLEFT_READ_ONLY: '1' });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].status, 'EXPIRED');
  assert.match(snapshot.results[0].error, /read-only mode/i);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('Kimi OAuth provider supports a custom managed endpoint', async (t) => {
  const { home } = await kimiHome(t, {
    access_token: 'managed-access',
    refresh_token: 'managed-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    expires_in: 3600,
  });
  mockFetch(t, async (url, options) => {
    assert.equal(String(url), 'https://gateway.example/coding/v1/usages');
    assert.equal(options.headers.Authorization, 'Bearer managed-access');
    return new Response(JSON.stringify({ boosterWallet: {
      balance: { type: 'BOOSTER', amount: '1000000', amountLeft: '500000' },
    } }), { status: 200 });
  });

  const provider = await createKimiProvider({
    KIMI_CODE_HOME: home,
    KIMI_CODE_BASE_URL: 'https://gateway.example/coding/v1/',
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.equal(snapshot.results[0].items[0].kind, 'info');
  assert.equal(snapshot.results[0].items[0].value, '$0.01 left');
  assert.deepEqual(provider.alertItems(snapshot), []);
});

test('Kimi provider accepts a manual Kimi Code membership key', async (t) => {
  mockFetch(t, async (url, options) => {
    assert.equal(String(url), 'https://api.kimi.com/coding/v1/usages');
    assert.equal(options.headers.Authorization, 'Bearer membership-key');
    return new Response(JSON.stringify({ usage: { used: 2, limit: 10 } }), { status: 200 });
  });

  const provider = await createKimiProvider({ KIMI_CODE_API_KEY: 'membership-key' });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.equal(snapshot.results[0].items[0].percent, 20);
  assert.doesNotMatch(provider.render(snapshot, 120, 'compact'), /key_1|Account 1/);
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.label), ['Weekly limit']);
});

test('Kimi provider shows membership metadata and caches the model catalog', async (t) => {
  let usageCalls = 0;
  let modelCalls = 0;
  mockFetch(t, async (url, options) => {
    usageCalls += 1;
    assert.equal(String(url), 'https://api.kimi.com/coding/v1/usages');
    assert.equal(options.headers.Authorization, 'Bearer metadata-key');
    return new Response(JSON.stringify({
      usage: { used: 12, limit: 100 },
      user: { userId: 'never-render-this', membership: { level: 'LEVEL_INTERMEDIATE' } },
      subType: 'TYPE_PURCHASE',
      totalQuota: { limit: 100, remaining: 88 },
      parallel: { limit: 20, details: ['opaque-request-id'] },
      authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
    }), { status: 200 });
  }, {
    models: async (url, options) => {
      modelCalls += 1;
      assert.equal(String(url), 'https://api.kimi.com/coding/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer metadata-key');
      return new Response(JSON.stringify({ data: [{
        id: 'k3',
        display_name: 'K3',
        context_length: 1048576,
        supports_reasoning: true,
        supports_image_in: true,
        supports_video_in: true,
      }] }), { status: 200 });
    },
  });

  const provider = await createKimiProvider({ KIMI_CODE_API_KEY: 'metadata-key' });
  const first = await provider.fetch();
  const second = await provider.fetch();
  const result = first.results[0];

  assert.equal(usageCalls, 2);
  assert.equal(modelCalls, 1);
  assert.equal(result.plan, 'Allegretto');
  assert.equal(result.auth, 'API Key');
  assert.equal(result.scope, 'Coding');
  assert.deepEqual(result.items.map((item) => item.label), [
    'Weekly limit',
    'Shared quota',
    'Parallel',
    'Models',
  ]);
  assert.equal(result.items[0].value, '12%');
  assert.doesNotMatch(provider.render(first, 120, 'detail'), /\(12\/100\)/);
  assert.match(provider.render(first, 120, 'detail'), /Allegretto[\s\S]*API Key/);
  assert.match(provider.render(first, 120, 'detail'), /Shared quota[\s\S]*88\/100 left/);
  const compact = provider.render(first, 120, 'compact');
  assert.match(compact, /Allegretto/);
  assert.doesNotMatch(compact, /Shared quota|Parallel|Models/);
  assert.match(compact, /Weekly limit/);
  assert.deepEqual(second.results[0].items.at(-1).details, result.items.at(-1).details);
});

test('Kimi model metadata is optional when the catalog request fails', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({
    usage: { used: 1, limit: 10 },
  }), { status: 200 }), {
    models: async () => new Response('unavailable', { status: 503 }),
  });

  const provider = await createKimiProvider({ KIMI_CODE_API_KEY: 'membership-key' });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(snapshot.results[0].items.map((item) => item.label), ['Weekly limit']);
});

test('Kimi provider fetches and renders multiple named membership keys independently', async (t) => {
  const calls = [];
  mockFetch(t, async (_url, options) => {
    const token = options.headers.Authorization.replace(/^Bearer /, '');
    calls.push(token);
    const used = token === 'work-key' ? 2 : 7;
    return new Response(JSON.stringify({ usage: { used, limit: 10 } }), { status: 200 });
  });

  const provider = await createKimiProvider({
    KIMI_CODE_API_KEY_1: 'work-key',
    KIMI_CODE_NAME_1: 'work',
    KIMI_CODE_API_KEY_2: 'personal-key',
    KIMI_CODE_NAME_2: 'personal',
  });
  const snapshot = await provider.fetch();

  assert.deepEqual(calls.sort(), ['personal-key', 'work-key']);
  assert.deepEqual(snapshot.results.map((result) => result.name), ['work', 'personal']);
  assert.deepEqual(snapshot.results.map((result) => result.items[0].percent), [20, 70]);
  assert.notEqual(snapshot.results[0].items[0].key, snapshot.results[1].items[0].key);
  assert.equal(provider.headerStatus(snapshot).text, '2/2 OK');
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.label), [
    'work Weekly limit',
    'personal Weekly limit',
  ]);
  assert.match(provider.render(snapshot, 96, 'compact'), /work[\s\S]*personal/);
});

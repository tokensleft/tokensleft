import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexProvider } from '../providers/codex.js';
import { createCopilotProvider, parseGhHostsToken } from '../providers/copilot.js';
import { createGeminiProvider } from '../providers/gemini.js';
import { createGrokProvider } from '../providers/grok.js';

// Live request paths of the single-account providers, driven through a mocked
// global fetch: success mapping, rejected tokens, transport failures, and the
// Gemini refresh flow. Item mapping itself is covered in providers2.test.js.

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    return handler(call, calls.length);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- copilot --------------------------------------------------------------------

test('Copilot fetches the internal user endpoint with the discovered token', async (t) => {
  const calls = mockFetch(t, () => jsonResponse({
    copilot_plan: 'individual',
    quota_reset_date: new Date(Date.now() + 86400_000).toISOString(),
    quota_snapshots: {
      premium_interactions: { percent_remaining: 40 },
      chat: { unlimited: true, percent_remaining: 100 },
    },
  }));
  const provider = await createCopilotProvider({ COPILOT_TOKEN: ' gho_token ' });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'individual');
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Premium']);
  assert.equal(snapshot.items[0].percent, 60);
  assert.match(calls[0].url, /copilot_internal\/user$/);
  assert.equal(calls[0].options.headers.Authorization, 'token gho_token');
  assert.deepEqual(provider.headerStatus(snapshot), { ok: true, text: 'OK' });
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.key), ['copilot:premium']);
  assert.match(provider.render(snapshot, 100, 'compact'), /Premium/);
});

test('Copilot reports rejected tokens with their source and survives transport errors', async (t) => {
  let mode = 'unauthorized';
  mockFetch(t, () => {
    if (mode === 'unauthorized') {
      return new Response('{}', { status: 401 });
    }

    if (mode === 'gateway') {
      return new Response('<html>bad gateway</html>', { status: 502 });
    }

    throw new Error('socket hang up');
  });
  const provider = await createCopilotProvider({ GH_TOKEN: 'gho_x' });

  let snapshot = await provider.fetch();
  assert.equal(snapshot.status, 401);
  assert.match(snapshot.error, /GH_TOKEN/);
  assert.deepEqual(provider.headerStatus(snapshot), { ok: false, text: '401' });
  assert.deepEqual(provider.alertItems(snapshot), []);

  mode = 'gateway';
  snapshot = await provider.fetch();
  assert.equal(snapshot.status, 502);
  assert.equal(snapshot.error, 'HTTP 502');
  assert.match(snapshot.body, /bad gateway/);

  mode = 'transport';
  snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'ERR');
  assert.match(snapshot.error, /socket hang up/);
});

test('parseGhHostsToken only takes a token from the github.com block', () => {
  const legacy = [
    'ghe.example.com:',
    '    oauth_token: ghe-token',
    '    user: someone',
    'github.com:',
    '    oauth_token: "github-token"',
    '    git_protocol: https',
    '',
  ].join('\n');
  const nested = [
    'github.com:',
    '    users:',
    '        octocat:',
    '            oauth_token: nested-token',
    '    git_protocol: ssh',
    '    user: octocat',
    'ghe.example.com:',
    '    oauth_token: ghe-token',
  ].join('\n');

  assert.equal(parseGhHostsToken(legacy), 'github-token');
  assert.equal(parseGhHostsToken(nested), 'nested-token');
  assert.equal(parseGhHostsToken('ghe.example.com:\n    oauth_token: ghe-token\n'), '');
  assert.equal(parseGhHostsToken(''), '');
});

// --- grok -----------------------------------------------------------------------

function grokEnv(dir, extra = {}) {
  return { GROK_AUTH_PATH: join(dir, 'auth.json'), ...extra };
}

test('Grok maps billing and settings responses into a credits bar with the plan name', async (t) => {
  const dir = await tempDir(t, 'tokensleft-grok-');
  const calls = mockFetch(t, ({ url }) => (url.endsWith('/billing')
    ? jsonResponse({
      config: {
        used: { val: 1426 },
        monthlyLimit: { val: 4000 },
        onDemandCap: { val: 0 },
        billingPeriodEnd: new Date(Date.now() + 86400_000).toISOString(),
      },
    })
    : jsonResponse({ subscription_tier_display: 'SuperGrok' })));
  const provider = await createGrokProvider(grokEnv(dir, { GROK_TOKEN: 'grok-token' }));
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'SuperGrok');
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Credits']);
  assert.equal(Math.round(snapshot.items[0].percent), 36);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer grok-token');
  assert.equal(calls[0].options.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.key), ['grok:credits']);
});

test('Grok keeps the usage bar when the optional settings request fails', async (t) => {
  const dir = await tempDir(t, 'tokensleft-grok-settings-');
  mockFetch(t, ({ url }) => {
    if (url.endsWith('/billing')) {
      return jsonResponse({ config: { used: { val: 1 }, monthlyLimit: { val: 10 }, billingPeriodEnd: null } });
    }

    throw new Error('settings offline');
  });
  const provider = await createGrokProvider(grokEnv(dir, { GROK_TOKEN: 'grok-token' }));
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, '');
  assert.equal(snapshot.items[0].percent, 10);
});

test('Grok surfaces expired logins, rejected tokens, and unexpected payloads', async (t) => {
  const dir = await tempDir(t, 'tokensleft-grok-errors-');
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    default: { key: 'old', expires_at: new Date(Date.now() - 60_000).toISOString() },
  }));
  let mode = 'expired-file';
  const calls = mockFetch(t, () => {
    if (mode === 'unauthorized') {
      return new Response('{}', { status: 401 });
    }

    return jsonResponse({ unexpected: true });
  });

  const fromFile = await createGrokProvider(grokEnv(dir));
  let snapshot = await fromFile.fetch();
  assert.equal(snapshot.status, 'CRED');
  assert.match(snapshot.error, /expired/);
  assert.equal(calls.length, 0, 'an expired key is never sent');

  const withToken = await createGrokProvider(grokEnv(dir, { GROK_TOKEN: 'fresh' }));
  mode = 'unauthorized';
  snapshot = await withToken.fetch();
  assert.equal(snapshot.status, 401);
  assert.match(snapshot.error, /grok login/);

  mode = 'shape';
  snapshot = await withToken.fetch();
  assert.equal(snapshot.status, 'ERR');
  assert.match(snapshot.error, /shape changed/);
});

test('Grok is undetected without an auth file or manual token', async (t) => {
  const dir = await tempDir(t, 'tokensleft-grok-none-');
  assert.equal(await createGrokProvider(grokEnv(dir)), null);
});

// --- gemini ---------------------------------------------------------------------

function idToken(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function geminiCreds(overrides = {}) {
  return {
    access_token: 'live-token',
    refresh_token: 'refresh-token',
    expiry_date: Date.now() + 3600_000,
    id_token: idToken({ email: 'dev@example.com', hd: 'example.com' }),
    ...overrides,
  };
}

function geminiQuota() {
  return {
    buckets: [
      { modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.25, resetTime: new Date(Date.now() + 3600_000).toISOString() },
      { modelId: 'gemini-3-flash-preview', remainingFraction: 1, resetTime: new Date(Date.now() + 3600_000).toISOString() },
    ],
  };
}

function geminiHandler({ refresh = null, quotaStatus = 200 } = {}) {
  return ({ url }) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return refresh ? jsonResponse(refresh.body, refresh.status) : jsonResponse({}, 500);
    }

    if (url.includes(':loadCodeAssist')) {
      return jsonResponse({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'proj-1' });
    }

    if (url.includes(':retrieveUserQuota')) {
      return jsonResponse(geminiQuota(), quotaStatus);
    }

    return jsonResponse({}, 404);
  };
}

test('Gemini resolves tier, project, and quota buckets from the Cloud Code endpoints', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-fetch-');
  await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify(geminiCreds()));
  const calls = mockFetch(t, geminiHandler());
  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'Workspace');
  assert.equal(snapshot.email, 'dev@example.com');
  assert.deepEqual(snapshot.items.map((item) => [item.label, item.percent]), [['Pro', 75], ['Flash', 0]]);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer live-token'));
  assert.ok(!calls.some((call) => call.url.includes('cloudresourcemanager')), 'the assist project skips project discovery');
  const quotaCall = calls.find((call) => call.url.includes(':retrieveUserQuota'));
  assert.deepEqual(JSON.parse(quotaCall.options.body), { project: 'proj-1' });
  assert.match(provider.render(snapshot, 100, 'detail'), /dev@example\.com/);
  assert.doesNotMatch(provider.render(snapshot, 100, 'compact'), /dev@example\.com/);
});

test('Gemini refreshes an expiring token and writes it back before requesting quota', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-refresh-');
  const credsPath = join(dir, 'oauth_creds.json');
  await writeFile(credsPath, JSON.stringify(geminiCreds({ expiry_date: Date.now() - 1000 })));
  const calls = mockFetch(t, geminiHandler({
    refresh: { status: 200, body: { access_token: 'fresh-token', expires_in: 3600 } },
  }));
  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.match(calls[0].url, /oauth2\.googleapis\.com\/token/);
  assert.match(calls[0].options.body, /grant_type=refresh_token/);
  assert.match(calls[0].options.body, /refresh_token=refresh-token/);
  assert.ok(calls.slice(1).every((call) => call.options.headers.Authorization === 'Bearer fresh-token'));
  const stored = JSON.parse(await readFile(credsPath, 'utf8'));
  assert.equal(stored.access_token, 'fresh-token');
  assert.equal(stored.refresh_token, 'refresh-token');
  assert.ok(stored.expiry_date > Date.now());
});

test('Gemini asks for a new sign-in when the refresh grant is rejected', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-rejected-');
  const credsPath = join(dir, 'oauth_creds.json');
  const raw = JSON.stringify(geminiCreds({ expiry_date: Date.now() - 1000 }));
  await writeFile(credsPath, raw);
  const calls = mockFetch(t, geminiHandler({ refresh: { status: 400, body: { error: 'invalid_grant' } } }));
  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.status, 'EXPIRED');
  assert.match(snapshot.error, /invalid_grant.*sign in again/);
  assert.equal(calls.length, 1, 'no quota request is made with a dead login');
  assert.equal(await readFile(credsPath, 'utf8'), raw);
});

test('Gemini reports a rejected session and a failed quota request distinctly', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-status-');
  await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify(geminiCreds()));
  let mode = 'unauthorized';
  mockFetch(t, (call) => {
    if (mode === 'unauthorized' && call.url.includes(':loadCodeAssist')) {
      return new Response('{}', { status: 403 });
    }

    if (mode === 'unauthorized' && call.url.includes('oauth2.googleapis.com/token')) {
      return jsonResponse({}, 500);
    }

    return geminiHandler({ quotaStatus: 503 })(call);
  });
  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir });

  let snapshot = await provider.fetch();
  assert.equal(snapshot.status, 403);
  assert.match(snapshot.error, /sign in again/);

  mode = 'quota-down';
  snapshot = await provider.fetch();
  assert.equal(snapshot.status, 503);
  assert.match(snapshot.error, /quota request failed/);
});

test('Gemini refuses non-OAuth auth types before touching the network', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-authtype-');
  await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify(geminiCreds()));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
  const calls = mockFetch(t, () => {
    throw new Error('must not be called');
  });
  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.status, 'AUTH');
  assert.match(snapshot.error, /gemini-api-key/);
  assert.equal(calls.length, 0);
});

// --- codex ----------------------------------------------------------------------

function codexAuth(overrides = {}) {
  return {
    tokens: { access_token: 'stale-access', refresh_token: 'refresh-1', account_id: 'acct-1' },
    last_refresh: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function codexUsage(usedPercent = 12) {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  };
}

const noForecast = { resetForecastFetcher: async () => null };

test('Codex refreshes a stale login before requesting usage and stores the rotated tokens', async (t) => {
  const dir = await tempDir(t, 'tokensleft-codex-refresh-');
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify(codexAuth(), null, 2));
  const calls = mockFetch(t, ({ url, options }) => {
    if (url.includes('auth.openai.com/oauth/token')) {
      assert.match(options.body, /grant_type=refresh_token/);
      assert.match(options.body, /refresh_token=refresh-1/);
      return jsonResponse({ access_token: 'fresh-access', refresh_token: 'refresh-2', id_token: 'id-2' });
    }

    if (url.includes('/wham/usage')) {
      return jsonResponse(codexUsage());
    }

    return jsonResponse({}, 404);
  });
  const provider = await createCodexProvider({ CODEX_HOME: dir }, noForecast);
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'plus');
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Session']);
  assert.equal(snapshot.items[0].percent, 12);
  const usageCall = calls.find((call) => call.url.includes('/wham/usage'));
  assert.equal(usageCall.options.headers.Authorization, 'Bearer fresh-access');
  assert.equal(usageCall.options.headers['ChatGPT-Account-Id'], 'acct-1');
  const stored = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(stored.tokens.access_token, 'fresh-access');
  assert.equal(stored.tokens.refresh_token, 'refresh-2');
  assert.equal(stored.tokens.id_token, 'id-2');
  assert.ok(Date.parse(stored.last_refresh) > Date.now() - 60_000);
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.key), ['codex:session']);
});

test('Codex asks for a new login only when the refresh grant is rejected', async (t) => {
  const dir = await tempDir(t, 'tokensleft-codex-rejected-');
  const authPath = join(dir, 'auth.json');
  const raw = JSON.stringify(codexAuth(), null, 2);
  await writeFile(authPath, raw);
  let tokenEndpoint = 'rejected';
  const calls = mockFetch(t, ({ url }) => {
    if (url.includes('auth.openai.com/oauth/token')) {
      return tokenEndpoint === 'rejected'
        ? jsonResponse({ error: { code: 'invalid_grant' } }, 400)
        : jsonResponse({ error: 'server_error' }, 500);
    }

    return jsonResponse(codexUsage(5));
  });
  const provider = await createCodexProvider({ CODEX_HOME: dir }, noForecast);

  let snapshot = await provider.fetch();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.status, 'EXPIRED');
  assert.match(snapshot.error, /invalid_grant.*log in again/);
  assert.equal(calls.length, 1, 'no usage request is made with a dead login');
  assert.equal(await readFile(authPath, 'utf8'), raw);

  tokenEndpoint = 'down';
  snapshot = await provider.fetch();
  assert.equal(snapshot.ok, true, 'a token endpoint outage is soft: the stored token is still tried');
  assert.equal(snapshot.items[0].percent, 5);
  assert.equal(await readFile(authPath, 'utf8'), raw);
});

test('Codex reports API-key logins as unsupported and includes the unofficial reset forecast', async (t) => {
  const dir = await tempDir(t, 'tokensleft-codex-apikey-');
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
  const calls = mockFetch(t, () => jsonResponse(codexUsage()));

  const apiKeyProvider = await createCodexProvider({ CODEX_HOME: dir }, noForecast);
  const apiKeySnapshot = await apiKeyProvider.fetch();
  assert.equal(apiKeySnapshot.status, 'APIKEY');
  assert.match(apiKeySnapshot.error, /log in with ChatGPT/);
  assert.equal(calls.length, 0);

  await writeFile(authPath, JSON.stringify(codexAuth({ last_refresh: new Date().toISOString() })));
  const provider = await createCodexProvider({ CODEX_HOME: dir }, {
    resetForecastFetcher: async () => ({ score: 68 }),
  });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Session', 'Reset chance (48h)']);
  assert.equal(calls.length, 1, 'a fresh login is not refreshed');
  assert.deepEqual(provider.alertItems(snapshot).map((item) => item.key), ['codex:session']);
});

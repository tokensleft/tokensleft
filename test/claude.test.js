import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  buildClaudeLimitItems,
  createClaudeProvider,
  createTranscriptScanner,
  isZaiModel,
  keychainCredentials,
  keychainLookups,
  keychainServiceCandidates,
  keychainWriteArgs,
  parseKeychainCredentials,
  parseTranscriptChunk,
  readClaudeAccounts,
  renderClaudeSnapshot,
  resolveRetryAfterAt,
} from '../providers/claude.js';
import { stripBlessedTags } from '../lib/format.js';

const SAMPLE_USAGE = {
  five_hour: { utilization: 3, resets_at: '2026-07-03T12:10:00Z' },
  seven_day: { utilization: 17, resets_at: '2026-07-07T19:00:00Z' },
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: '2026-07-03T12:10:00Z', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 17, severity: 'normal', resets_at: '2026-07-07T19:00:00Z', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 33, severity: 'warning', resets_at: '2026-07-07T19:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  spend: { enabled: false },
};

test('buildClaudeLimitItems maps limits[] including model-scoped (Fable)', () => {
  const items = buildClaudeLimitItems(SAMPLE_USAGE, { prefix: 'sys' });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly all', 'Wk Fable']);
  assert.equal(items[0].active, true);
  assert.equal(items[2].percent, 33);
  assert.equal(items[2].severity, 'warning');
  assert.ok(items.every((item) => item.key.startsWith('sys:')));
});

test('buildClaudeLimitItems falls back to five_hour/seven_day', () => {
  const items = buildClaudeLimitItems({ five_hour: SAMPLE_USAGE.five_hour, seven_day: SAMPLE_USAGE.seven_day }, { prefix: 'sys' });
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly all']);
});

test('429 retry time honors the server delay with a ten-minute minimum backoff', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  assert.equal(resolveRetryAfterAt('0', { now }).getTime(), now + 10 * 60 * 1000);
  assert.equal(resolveRetryAfterAt(null, { now }).getTime(), now + 10 * 60 * 1000);
  assert.equal(resolveRetryAfterAt('3600', { now }).getTime(), now + 60 * 60 * 1000);
});

test('429 UI shows a countdown instead of a misleading time-of-day', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;

  try {
    const retryAfterAt = new Date(now + 24 * 60 * 60 * 1000);
    const result = {
      name: 'personal',
      ok: false,
      status: 429,
      error: 'HTTP 429',
      plan: 'max',
      ms: 10,
      retryAfterAt,
      items: [],
    };
    const compact = stripBlessedTags(renderClaudeSnapshot({ results: [result] }, 100, 'compact'));
    const detail = stripBlessedTags(renderClaudeSnapshot({
      results: [result],
      local: { ok: true, models: [] },
    }, 100, 'detail'));

    assert.match(compact, /retry in 1d/);
    assert.ok(!compact.includes('retry after'));
    assert.match(detail, /retry in 1d · at /);
  } finally {
    Date.now = realNow;
  }
});

function transcriptLine({ id, model = 'claude-fable-5', t, output = 100 }) {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(t).toISOString(),
    message: {
      id,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 200 },
      },
    },
  })}\n`;
}

test('parseTranscriptChunk parses complete lines and keeps the remainder', () => {
  const full = transcriptLine({ id: 'msg_1', t: Date.now() });
  const partial = '{"type":"assistant","message":{"usage"';
  const { events, remainder } = parseTranscriptChunk(full + partial);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'msg_1');
  assert.equal(events[0].cache5m, 50);
  assert.equal(events[0].cache1h, 200);
  assert.equal(remainder, partial);
});

test('parseTranscriptChunk skips non-assistant and synthetic models', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { usage: {}, model: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm', model: '<synthetic>', usage: { output_tokens: 5 } } }),
  ].join('\n') + '\n';
  assert.equal(parseTranscriptChunk(lines).events.length, 0);
});

test('isZaiModel recognizes GLM model ids without claiming unrelated models', () => {
  assert.equal(isZaiModel('glm-4.7'), true);
  assert.equal(isZaiModel('zai/glm-4.6'), true);
  assert.equal(isZaiModel('z-ai/GLM-4.5-Air'), true);
  assert.equal(isZaiModel('models/zhipuai/glm_4'), true);
  assert.equal(isZaiModel('claude-sonnet-4-20250514'), false);
  assert.equal(isZaiModel('acme/not-glm-4'), false);
});

test('transcript scanner aggregates incrementally and dedupes by message id', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'tokensleft-test-'));
  after(() => rm(configDir, { recursive: true, force: true }));

  const projectDir = join(configDir, 'projects', 'proj-a');
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, 'session.jsonl');
  const now = Date.now();

  await writeFile(filePath, transcriptLine({ id: 'msg_1', t: now - 1000 }) + transcriptLine({ id: 'msg_1', t: now - 1000 }));

  const scanner = createTranscriptScanner(configDir);
  let result = await scanner.scan(now);
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].week.messages, 1); // duplicate id counted once
  assert.equal(result.models[0].week.output, 100);
  assert.equal(result.models[0].week.cacheWrite, 250);
  assert.ok(result.models[0].week.cost > 0);

  // Append a new message — the incremental pass must pick up only the tail.
  await appendFile(filePath, transcriptLine({ id: 'msg_2', t: now, output: 900 }));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
  assert.equal(result.models[0].week.output, 1000);

  // Unchanged file: aggregation is stable.
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
});

test('transcript scanners partition z.ai models from other Claude Code sessions', async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), 'tokensleft-model-routing-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));

  const projectDir = join(configDir, 'projects', 'proj-a');
  await mkdir(projectDir, { recursive: true });
  const now = Date.now();
  await writeFile(join(projectDir, 'session.jsonl'), [
    transcriptLine({ id: 'glm-message', model: 'glm-4.7', t: now }),
    transcriptLine({ id: 'claude-message', model: 'claude-sonnet-4-20250514', t: now }),
  ].join(''));

  const [zai, claude] = await Promise.all([
    createTranscriptScanner(configDir, { includeModel: isZaiModel }).scan(now),
    createTranscriptScanner(configDir, { includeModel: (model) => !isZaiModel(model) }).scan(now),
  ]);

  assert.deepEqual(zai.models.map((entry) => entry.model), ['glm-4.7']);
  assert.deepEqual(claude.models.map((entry) => entry.model), ['claude-sonnet-4-20250514']);
  assert.equal(zai.models[0].week.messages, 1);
  assert.equal(claude.models[0].week.messages, 1);
});

test('transcript scanner reports missing projects dir', async () => {
  const scanner = createTranscriptScanner(join(tmpdir(), 'tokensleft-definitely-missing'));
  const result = await scanner.scan();
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, []);
});

// --- credential discovery ---------------------------------------------------------

// Stands in for the `security` calls: `secret` is what the item holds (null
// for "no such item"), `calls` records probe/read plus the exact argv so tests
// can assert the account-scoped lookup runs first.
function keychainStub(secret, calls = [], { onWrite } = {}) {
  const item = { value: secret };

  return {
    find: async (lookups, { secret: wantSecret = false } = {}) => {
      calls.push([wantSecret ? 'read' : 'probe', lookups.map((lookup) => lookup.args.join(' '))]);

      return item.value === null
        ? { found: false }
        : { found: true, value: wantSecret ? item.value : '', lookup: lookups[0] };
    },
    write: async (lookup, value) => {
      calls.push(['write', lookup, value]);

      if (onWrite) {
        await onWrite();
      }

      item.value = value;
    },
    item,
  };
}

// Mocks both endpoints the refresh path touches: the OAuth token exchange and
// the usage call, recording every bearer token the usage call was given.
function mockRefreshAndUsage(t, { refresh = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 28800 }, refreshStatus = 200 } = {}) {
  const originalFetch = globalThis.fetch;
  const bearers = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify(refresh), { status: refreshStatus, headers: { 'content-type': 'application/json' } });
    }

    bearers.push(options?.headers?.Authorization);
    return new Response(JSON.stringify(SAMPLE_USAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return bearers;
}

function keychainSecret(overrides = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'keychain-access-token',
      refreshToken: 'keychain-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'default_max_20x',
      ...overrides,
    },
  });
}

async function emptyConfigDir(t, prefix) {
  const configDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  return configDir;
}

test('macOS reads credentials from the Keychain when .credentials.json is absent', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-');
  const calls = [];
  const accounts = await readClaudeAccounts({ CLAUDE_CONFIG_DIR: configDir, USER: 'ada' }, {
    osPlatform: 'darwin',
    keychain: keychainStub(keychainSecret(), calls),
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].storage, 'keychain');
  assert.deepEqual(accounts[0].sources.map((source) => source.kind), ['keychain']);
  // Detection must not touch the secret — reading it is what prompts on macOS.
  assert.deepEqual(calls.map(([kind]) => kind), ['probe']);
});

test('the account-scoped Keychain lookup runs before the service-only one', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-account-');
  const calls = [];
  await readClaudeAccounts({ CLAUDE_CONFIG_DIR: configDir, USER: 'ada' }, {
    osPlatform: 'darwin',
    keychain: keychainStub(keychainSecret(), calls),
  });

  // A bare `-s` match returns whichever item comes first, which can be a stale
  // login from another account; `-a $USER` pins it to Claude Code's own item.
  const [hashed, plain] = keychainServiceCandidates({ CLAUDE_CONFIG_DIR: configDir });
  const [, argv] = calls[0];
  assert.deepEqual(argv, [
    `find-generic-password -a ada -s ${hashed}`,
    `find-generic-password -s ${hashed}`,
    `find-generic-password -a ada -s ${plain}`,
    `find-generic-password -s ${plain}`,
  ]);
});

test('the real security lookup resolves instead of throwing on any platform', async () => {
  // Exercises the un-stubbed `/usr/bin/security` path: exit 44 on a Mac with no
  // Claude Code login, ENOENT where the binary does not exist. Both are "no
  // item", never an exception and never a hang.
  const result = await keychainCredentials.find(keychainLookups({ CLAUDE_KEYCHAIN_SERVICE: 'tokensleft-test-absent-item' }));

  assert.equal(result.found, false);
  assert.equal(typeof result.error, 'string');
});

test('a custom config dir gets its own hashed Keychain item, then the plain one', () => {
  assert.deepEqual(keychainServiceCandidates({}), ['Claude Code-credentials']);
  assert.deepEqual(
    keychainServiceCandidates({ CLAUDE_KEYCHAIN_SERVICE: 'Custom-credentials' }),
    ['Custom-credentials'],
  );

  const [hashed, plain] = keychainServiceCandidates({ CLAUDE_CONFIG_DIR: '/Users/ada/.claude' });
  assert.match(hashed, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(plain, 'Claude Code-credentials');
});

test('Keychain lookup is skipped off macOS and when disabled', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-skip-');
  const keychain = keychainStub(keychainSecret());
  const read = (env, osPlatform = 'darwin') => readClaudeAccounts(
    { CLAUDE_CONFIG_DIR: configDir, ...env },
    { osPlatform, keychain },
  );

  assert.deepEqual(await read({}, 'win32'), []);
  assert.deepEqual(await read({}, 'linux'), []);
  assert.deepEqual(await read({ CLAUDE_DISABLE_KEYCHAIN: '1' }), []);
  assert.deepEqual(await read({ CLAUDE_DISABLE_SYSTEM_KEY: '1' }), []);
});

test('the Keychain outranks a stale .credentials.json, which stays as a fallback', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-order-');
  await writeFile(join(configDir, '.credentials.json'), keychainSecret({
    accessToken: 'file-token',
    // A later expiry must not promote the file above the live Keychain.
    expiresAt: Date.now() + 10 * 60 * 60 * 1000,
  }));

  const [account] = await readClaudeAccounts({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(keychainSecret()),
  });

  assert.deepEqual(account.sources.map((source) => source.kind), ['keychain', 'file']);
  assert.equal(account.storage, 'keychain');
});

test('Keychain credentials authenticate the usage request', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-fetch-');
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options?.headers?.Authorization });
    return new Response(JSON.stringify(SAMPLE_USAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(keychainSecret()),
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.equal(snapshot.results[0].plan, 'max / max_20x');
  assert.equal(snapshot.results[0].items.length, 3);
  assert.deepEqual(requests, [{
    url: 'https://api.anthropic.com/api/oauth/usage',
    authorization: 'Bearer keychain-access-token',
  }]);
});

test('the write mirrors how the item was found, and always updates in place', () => {
  assert.deepEqual(
    keychainWriteArgs({ service: 'Claude Code-credentials', account: 'ada' }, '{"a":1}'),
    ['add-generic-password', '-U', '-a', 'ada', '-s', 'Claude Code-credentials', '-w', '{"a":1}'],
  );

  // An item found without `-a` must be written back without it: adding the
  // account would create a second entry instead of updating Claude Code's.
  assert.deepEqual(
    keychainWriteArgs({ service: 'Claude Code-credentials', account: '' }, '{"a":1}'),
    ['add-generic-password', '-U', '-s', 'Claude Code-credentials', '-w', '{"a":1}'],
  );
});

test('an expiring Keychain token is refreshed and written back to the same item', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-writeback-');
  const calls = [];
  const keychain = keychainStub(keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 }), calls);
  const bearers = mockRefreshAndUsage(t);

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir, USER: 'ada' }, {
    osPlatform: 'darwin',
    keychain,
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.equal(snapshot.results[0].warning, '');
  assert.deepEqual(bearers, ['Bearer rotated-access']);

  const [, lookup, written] = calls.find(([kind]) => kind === 'write');
  // Written back through the same account-scoped lookup the read used.
  assert.equal(lookup.account, 'ada');
  assert.equal(lookup.args[0], 'find-generic-password');

  const stored = JSON.parse(written).claudeAiOauth;
  assert.equal(stored.accessToken, 'rotated-access');
  // The rotated refresh token is the whole point: dropping it would leave the
  // next run redeeming a server-invalidated one.
  assert.equal(stored.refreshToken, 'rotated-refresh');
  assert.ok(stored.expiresAt > Date.now());
  assert.equal(JSON.parse(keychain.item.value).claudeAiOauth.accessToken, 'rotated-access');
});

test('a Keychain write failure keeps the usage bars and surfaces a warning', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-writefail-');
  const keychain = keychainStub(
    keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 }),
    [],
    { onWrite: () => { throw new Error('User interaction is not allowed.'); } },
  );
  const bearers = mockRefreshAndUsage(t);

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, { osPlatform: 'darwin', keychain });
  const snapshot = await provider.fetch();

  // The refreshed token still works for this run, so the fetch must succeed.
  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(bearers, ['Bearer rotated-access']);
  assert.match(snapshot.results[0].warning, /could not save the refreshed credentials: User interaction is not allowed\./);
  assert.match(
    stripBlessedTags(renderClaudeSnapshot(snapshot, 100, 'detail')),
    /could not save the refreshed credentials/,
  );
});

test('a token rotated underneath us is not clobbered', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-race-');
  const keychain = keychainStub(keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 }));
  // Claude Code rewrites the item between our read and our write.
  const original = keychain.find;
  let reads = 0;
  keychain.find = async (lookups, options) => {
    const result = await original(lookups, options);

    if (options?.secret && ++reads > 1) {
      return { ...result, value: keychainSecret({ accessToken: 'claude-code-rotated' }) };
    }

    return result;
  };
  const writes = [];
  keychain.write = async (...args) => { writes.push(args); };
  const bearers = mockRefreshAndUsage(t);

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, { osPlatform: 'darwin', keychain });
  const snapshot = await provider.fetch();

  assert.deepEqual(writes, [], 'must not overwrite a newer credential');
  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(bearers, ['Bearer rotated-access']);
  assert.match(snapshot.results[0].warning, /credentials changed underneath/);
});

test('a logout between read and write is not undone', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-logout-');
  const keychain = keychainStub(keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 }));
  const original = keychain.find;
  let reads = 0;
  keychain.find = async (lookups, options) => (options?.secret && ++reads > 1
    ? { found: false }
    : original(lookups, options));
  const writes = [];
  keychain.write = async (...args) => { writes.push(args); };
  mockRefreshAndUsage(t);

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, { osPlatform: 'darwin', keychain });
  const snapshot = await provider.fetch();

  // `add-generic-password -U` creates a missing item, so a vanished entry must
  // block the write instead of resurrecting a login the user just removed.
  assert.deepEqual(writes, []);
  assert.equal(snapshot.results[0].ok, true);
  assert.match(snapshot.results[0].warning, /credentials changed underneath/);
});

test('only invalid_grant means re-login; other refresh rejections do not', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-refresh-reject-');
  const expiring = () => keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 });

  const dead = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(expiring()),
  });
  mockRefreshAndUsage(t, { refresh: { error: 'invalid_grant' }, refreshStatus: 400 });
  const deadSnapshot = await dead.fetch();

  assert.equal(deadSnapshot.results[0].status, 'EXPIRED');
  assert.match(deadSnapshot.results[0].error, /invalid_grant.*\/login again/);

  // A WAF or proxy answering 400 is not an expired login, and telling the user
  // to /login again cannot fix a network appliance.
  const blocked = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(expiring()),
  });
  mockRefreshAndUsage(t, { refresh: { message: '<html>blocked</html>' }, refreshStatus: 400 });
  const blockedSnapshot = await blocked.fetch();

  assert.equal(blockedSnapshot.results[0].ok, true);
  assert.match(blockedSnapshot.results[0].warning, /token refresh got HTTP 400 — check your network or proxy/);
  assert.doesNotMatch(blockedSnapshot.results[0].warning, /login again/);
});

test('an item holding no accessToken is reported, not crashed on', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-empty-');
  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub('{}'),
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].status, 'CRED');
  assert.match(snapshot.results[0].error, /has no accessToken/);
});

test('a locked or denied Keychain is reported as such, not as "not signed in"', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-locked-');
  const locked = {
    find: async () => ({ found: false, error: 'User interaction is not allowed.' }),
  };

  // The account must still be detected: a credential that exists but cannot be
  // read is not the same as having no login, and telling the user to /login
  // again would not fix a locked keychain.
  const accounts = await readClaudeAccounts({ CLAUDE_CONFIG_DIR: configDir }, { osPlatform: 'darwin', keychain: locked });
  assert.equal(accounts.length, 1);

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, { osPlatform: 'darwin', keychain: locked });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].status, 'CRED');
  assert.match(snapshot.results[0].error, /cannot read the login Keychain: User interaction is not allowed\./);
  assert.doesNotMatch(snapshot.results[0].error, /no accessToken/);
});

test('a hex-encoded Keychain payload is decoded instead of failing to parse', async (t) => {
  const json = keychainSecret();
  const hex = Buffer.from(json, 'utf8').toString('hex');

  assert.equal(parseKeychainCredentials(hex).claudeAiOauth.accessToken, 'keychain-access-token');
  assert.equal(parseKeychainCredentials(`0x${hex}`).claudeAiOauth.accessToken, 'keychain-access-token');
  assert.equal(parseKeychainCredentials(json).claudeAiOauth.accessToken, 'keychain-access-token');
  assert.equal(parseKeychainCredentials('not json, not hex'), null);
  assert.equal(parseKeychainCredentials(''), null);

  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-hex-');
  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_url, options) => {
    tokens.push(options?.headers?.Authorization);
    return new Response(JSON.stringify(SAMPLE_USAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(hex),
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(tokens, ['Bearer keychain-access-token']);
});

test('an unreadable Keychain falls through to .credentials.json', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-fallthrough-');
  await writeFile(join(configDir, '.credentials.json'), keychainSecret({ accessToken: 'file-token' }));

  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_url, options) => {
    tokens.push(options?.headers?.Authorization);
    return new Response(JSON.stringify(SAMPLE_USAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: { find: async () => ({ found: false, error: 'User interaction is not allowed.' }) },
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(tokens, ['Bearer file-token']);
});

test('an expired Keychain token falls through to a live file token', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-keychain-stale-');
  await writeFile(join(configDir, '.credentials.json'), keychainSecret({ accessToken: 'file-token' }));

  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_url, options) => {
    tokens.push(options?.headers?.Authorization);
    return new Response(JSON.stringify(SAMPLE_USAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir }, {
    osPlatform: 'darwin',
    keychain: keychainStub(keychainSecret({ accessToken: 'stale', expiresAt: Date.now() - 60_000 })),
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.results[0].ok, true);
  assert.deepEqual(tokens, ['Bearer file-token']);
});

test('local transcript usage keeps the provider alive without credentials', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-local-only-');
  const projectDir = join(configDir, 'projects', 'proj-a');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'session.jsonl'), transcriptLine({ id: 'msg_1', t: Date.now() }));

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_DISABLE_SYSTEM_KEY: '1' });
  assert.ok(provider, 'transcripts alone must keep the Claude provider detected');

  const snapshot = await provider.fetch();
  assert.deepEqual(snapshot.results, []);
  assert.deepEqual(snapshot.local.models.map((entry) => entry.model), ['claude-fable-5']);
  assert.deepEqual(provider.headerStatus(snapshot), { ok: true, text: 'LOCAL' });
  assert.deepEqual(provider.alertItems(snapshot), []);

  const detail = stripBlessedTags(provider.render(snapshot, 100, 'detail'));
  const compact = stripBlessedTags(provider.render(snapshot, 100, 'compact'));
  assert.match(detail, /Local usage by model/);
  assert.match(detail, /No account credentials/);
  assert.match(compact, /No account credentials/);
});

test('no credentials and no local usage leaves the provider undetected', async (t) => {
  const configDir = await emptyConfigDir(t, 'tokensleft-undetected-');
  const env = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_DISABLE_SYSTEM_KEY: '1' };
  assert.equal(await createClaudeProvider(env), null);

  await mkdir(join(configDir, 'projects'), { recursive: true });
  assert.equal(await createClaudeProvider(env), null, 'an empty projects dir is not usage');
});

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeFileAtomic } from '../lib/fsx.js';
import { createClaudeProvider } from '../providers/claude.js';
import { buildCodexItems, createCodexProvider } from '../providers/codex.js';
import { createGeminiProvider } from '../providers/gemini.js';
import { buildAntigravityItems, createAntigravityProvider } from '../providers/antigravity.js';

async function tempDir(t, prefix = 'tokensleft-security-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('writeFileAtomic creates private files and preserves an existing mode', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'credentials.json');

  await writeFileAtomic(file, 'first');
  assert.equal(await readFile(file, 'utf8'), 'first');

  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await chmod(file, 0o640);
  }

  await writeFileAtomic(file, 'second', { expectedContent: 'first' });
  assert.equal(await readFile(file, 'utf8'), 'second');

  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  }

  assert.ok((await readdir(dir)).every((name) => !name.includes('.tmp-')));
});

test('writeFileAtomic refuses a stale overwrite and removes its temp file', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'credentials.json');
  await writeFile(file, 'new owner content');

  await assert.rejects(
    writeFileAtomic(file, 'stale refreshed content', { expectedContent: 'old owner content' }),
    (error) => error.code === 'EATOMICCONFLICT',
  );
  assert.equal(await readFile(file, 'utf8'), 'new owner content');
  assert.deepEqual(await readdir(dir), ['credentials.json']);
});

test('writeFileAtomic serializes competing TokensLeft writers', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'credentials.json');
  await writeFile(file, 'initial');

  const results = await Promise.allSettled([
    writeFileAtomic(file, 'first', { expectedContent: 'initial' }),
    writeFileAtomic(file, 'second', { expectedContent: 'initial' }),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'EATOMICCONFLICT');
  assert.match(await readFile(file, 'utf8'), /^(first|second)$/);
  assert.deepEqual(await readdir(dir), ['credentials.json']);
});

test('writeFileAtomic updates a symlink target without replacing the link', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'credentials-target.json');
  const link = join(dir, 'credentials.json');
  await writeFile(target, 'initial');
  await symlink('credentials-target.json', link);

  await writeFileAtomic(link, 'updated', { expectedContent: 'initial' });

  assert.equal(await readFile(target, 'utf8'), 'updated');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test('writeFileAtomic refuses a dangling credential symlink', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t);
  const link = join(dir, 'credentials.json');
  await symlink('missing-target.json', link);

  await assert.rejects(
    writeFileAtomic(link, 'updated'),
    (error) => error.code === 'EATOMICSYMLINK',
  );
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test('unknown quota values and balances are not fabricated into percentages', () => {
  const credits = buildCodexItems({ credits: { balance: 250 } });
  assert.deepEqual(credits, [{ kind: 'info', key: 'codex:credits', label: 'Credits', value: '250 left' }]);

  const antigravity = buildAntigravityItems({
    models: {
      missing: { displayName: 'Gemini 3 Pro' },
      known: { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.75 } },
    },
  });
  assert.deepEqual(antigravity.map((item) => item.label), ['Gemini Flash']);
  assert.equal(antigravity[0].percent, 25);
});

test('Claude read-only mode does not refresh or rewrite expired credentials', async (t) => {
  const dir = await tempDir(t, 'tokensleft-claude-readonly-');
  const credentialsPath = join(dir, '.credentials.json');
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-must-not-be-used',
      expiresAt: Date.now() - 60_000,
    },
  });
  await writeFile(credentialsPath, raw);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('read-only Claude must not make a request with an expired token');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createClaudeProvider({ CLAUDE_CONFIG_DIR: dir, TOKENSLEFT_READ_ONLY: '1' });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.results[0].status, 'EXPIRED');
  assert.match(snapshot.results[0].error, /read-only mode/i);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(credentialsPath, 'utf8'), raw);
});

test('Codex read-only mode reports a rejected token without refreshing it', async (t) => {
  const dir = await tempDir(t, 'tokensleft-codex-readonly-');
  const authPath = join(dir, 'auth.json');
  const raw = JSON.stringify({
    tokens: {
      access_token: 'stale-access',
      refresh_token: 'refresh-must-not-be-used',
      account_id: 'account-1',
    },
    last_refresh: '2000-01-01T00:00:00.000Z',
  }, null, 2);
  await writeFile(authPath, raw);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createCodexProvider({ CODEX_HOME: dir, TOKENSLEFT_READ_ONLY: 'true' });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 401);
  assert.match(snapshot.error, /log in again/i);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => !url.includes('auth.openai.com/oauth/token')));
  assert.equal(await readFile(authPath, 'utf8'), raw);
});

test('Gemini read-only mode does not refresh or rewrite expired credentials', async (t) => {
  const dir = await tempDir(t, 'tokensleft-gemini-readonly-');
  const credsPath = join(dir, 'oauth_creds.json');
  const raw = JSON.stringify({
    access_token: 'expired-access',
    refresh_token: 'refresh-must-not-be-used',
    expiry_date: Date.now() - 60_000,
  }, null, 2);
  await writeFile(credsPath, raw);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('read-only Gemini must not make a request with an expired token');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createGeminiProvider({ GEMINI_CLI_HOME: dir, TOKENSLEFT_READ_ONLY: 'yes' });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'EXPIRED');
  assert.match(snapshot.error, /read-only mode/i);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(credsPath, 'utf8'), raw);
});

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

function protoString(field, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function protoVarint(field, value) {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function antigravityEnvelope() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const inner = Buffer.concat([
    protoString(1, 'access-will-be-rejected'),
    protoString(3, 'refresh-must-not-be-used'),
    protoString(4, protoVarint(1, expiry)),
  ]);
  const payload = protoString(1, inner.toString('base64'));
  const wrapper = Buffer.concat([
    protoString(1, 'oauthTokenInfoSentinelKey'),
    protoString(2, payload),
  ]);
  return protoString(1, wrapper).toString('base64');
}

test('Antigravity read-only mode never redeems its refresh token', async (t) => {
  const dir = await tempDir(t, 'tokensleft-antigravity-readonly-');
  const dbPath = join(dir, 'state.vscdb');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);

  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('antigravityUnifiedStateSync.oauthToken', antigravityEnvelope());
  } finally {
    db.close();
  }

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createAntigravityProvider({
    ANTIGRAVITY_STATE_DB: dbPath,
    TOKENSLEFT_READ_ONLY: '1',
  });
  const snapshot = await provider.fetch();
  assert.equal(snapshot.status, 'EXPIRED');
  assert.match(snapshot.error, /read-only mode/i);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((url) => !url.includes('oauth2.googleapis.com/token')));
});

test('Antigravity removes its private fallback copy after a database error', async (t) => {
  const dir = await tempDir(t, 'tokensleft-antigravity-copy-');
  const dbPath = join(dir, 'invalid.vscdb');
  await writeFile(dbPath, 'not a sqlite database');
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('tokensleft-antigravity-')));

  const provider = await createAntigravityProvider({
    ANTIGRAVITY_STATE_DB: dbPath,
    TOKENSLEFT_READ_ONLY: '1',
  });
  const snapshot = await provider.fetch();
  const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('tokensleft-antigravity-')));
  assert.equal(snapshot.status, 'DB');
  assert.deepEqual(after, before);
});

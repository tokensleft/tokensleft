import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadNodeSqlite } from '../lib/runtime.js';
import { createOpencodeProvider, hasOpencodeGoAuth } from '../providers/opencode.js';
import { createZaiProvider, displayProxy } from '../providers/zai.js';

const nodeSqlite = await loadNodeSqlite();
const DatabaseSync = nodeSqlite?.DatabaseSync;
const sqliteTest = (name, run) => test(name, {
  skip: nodeSqlite ? false : 'requires node:sqlite',
}, run);

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createOpencodeDb(path, { providerID = 'anthropic', cost = 0.25 } = {}) {
  const db = new DatabaseSync(path);

  try {
    db.exec('CREATE TABLE message (time_created INTEGER NOT NULL, data TEXT NOT NULL)');
    db.prepare('INSERT INTO message (time_created, data) VALUES (?, ?)').run(
      Date.now(),
      JSON.stringify({
        role: 'assistant',
        providerID,
        modelID: 'test-model',
        cost,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cache: { read: 10, write: 2 },
        },
      }),
    );
  } finally {
    db.close();
  }
}

test('z.ai treats quota as required and removes proxy userinfo from snapshots', async () => {
  assert.equal(displayProxy('http://user:password@proxy.example:8080/path?secret=x'), 'http://proxy.example:8080');
  assert.equal(displayProxy('not a proxy URL'), 'configured proxy');
  assert.equal(displayProxy(''), 'direct');

  await withMockFetch((url) => String(url).includes('/subscription/')
    ? jsonResponse({ data: [{ productName: 'Max' }] })
    : jsonResponse({ error: 'quota unavailable' }, 503), async () => {
    const provider = await createZaiProvider({
      ZAI_API_KEY: 'zai-secret-key',
      ZAI_PROXY: 'http://user:password@proxy.example:8080',
      ZAI_AUTO_DISCOVER: '0',
    });
    const snapshot = await provider.fetch();
    const result = snapshot.results[0];

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.plan, 'Max');
    assert.deepEqual(result.items, []);
    assert.equal(result.account.proxy, 'http://proxy.example:8080');
    assert.doesNotMatch(JSON.stringify(snapshot), /user|password/);
    assert.doesNotMatch(provider.render(snapshot, 100, 'detail'), /user|password/);
  });
});

test('z.ai keeps healthy quota data when subscription metadata is partial', async () => {
  await withMockFetch((url) => String(url).includes('/subscription/')
    ? jsonResponse({ error: 'subscription unavailable' }, 503)
    : jsonResponse({
      data: {
        limits: [{
          type: 'TOKENS_LIMIT',
          unit: 3,
          percentage: 12,
          nextResetTime: Date.now() + 60_000,
        }],
      },
    }), async () => {
    const provider = await createZaiProvider({
      ZAI_API_KEY: 'zai-secret-key',
      ZAI_AUTO_DISCOVER: '0',
    });
    const result = (await provider.fetch()).results[0];

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.partial, 'subscription 503');
    assert.deepEqual(result.items.map((item) => item.label), ['Session']);
  });
});

sqliteTest('OpenCode DB-only installs expose local usage without Go plan quotas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-opencode-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  createOpencodeDb(join(dir, 'opencode.db'));

  const provider = await createOpencodeProvider({ OPENCODE_DATA_DIR: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, '');
  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.local.ok, true);
  assert.deepEqual(snapshot.local.models.map((model) => model.model), ['anthropic/test-model']);
});

test('OpenCode Go auth requires a non-empty opencode-go key', () => {
  assert.equal(hasOpencodeGoAuth({ 'opencode-go': { key: ' go-key ' } }), true);
  assert.equal(hasOpencodeGoAuth({ 'opencode-go': { key: '   ' } }), false);
  assert.equal(hasOpencodeGoAuth({}), false);
});

sqliteTest('OpenCode shows fixed Go quotas with an opencode-go key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-opencode-go-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  createOpencodeDb(join(dir, 'opencode.db'), { providerID: 'opencode-go', cost: 6 });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { key: 'go-key' } }));

  const provider = await createOpencodeProvider({ OPENCODE_DATA_DIR: dir });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan, 'Go');
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Session', 'Weekly', 'Monthly']);
  assert.equal(snapshot.local.ok, true);
});

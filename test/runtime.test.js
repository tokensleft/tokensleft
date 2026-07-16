import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadNodeSqlite } from '../lib/runtime.js';

test('loadNodeSqlite returns the built-in module only when DatabaseSync is available', async () => {
  const module = { DatabaseSync() {} };

  assert.equal(await loadNodeSqlite(async (specifier) => {
    assert.equal(specifier, 'node:sqlite');
    return module;
  }), module);
  assert.equal(await loadNodeSqlite(async () => ({})), null);
  assert.equal(await loadNodeSqlite(async () => { throw new Error('unsupported'); }), null);
});

test('Node 20 reports node:sqlite as unavailable without failing the probe', async () => {
  const sqlite = await loadNodeSqlite();
  const major = Number(process.versions.node.split('.')[0]);

  if (major === 20) {
    assert.equal(sqlite, null);
  } else if (sqlite) {
    assert.equal(typeof sqlite.DatabaseSync, 'function');
  }
});

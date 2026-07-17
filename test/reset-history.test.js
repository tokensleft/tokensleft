import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadResetHistory,
  normalizeResetEvent,
  recordResetEvent,
} from '../lib/reset-history.js';

function event(providerId, detectedAt, label = 'Session') {
  return {
    providerId,
    provider: providerId === 'codex' ? 'Codex' : 'Claude',
    windows: [{ key: label.toLowerCase(), label }],
    detectedAt,
  };
}

test('reset events persist locally and concurrent writers do not lose history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-reset-history-'));
  const path = join(dir, 'reset-history.json');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await Promise.all([
    recordResetEvent(event('codex', '2026-07-17T08:15:30.000Z'), { path }),
    recordResetEvent(event('claude', '2026-07-17T08:16:30.000Z', 'Weekly'), { path }),
  ]);

  const loaded = await loadResetHistory({ path });
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((entry) => entry.provider), ['Claude', 'Codex']);
  assert.equal(loaded[0].windows[0].label, 'Weekly');

  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.events.length, 2);
});

test('reset history repairs malformed files and keeps only the newest entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-reset-history-'));
  const path = join(dir, 'reset-history.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path, 'not json');

  assert.deepEqual(await loadResetHistory({ path }), []);

  await recordResetEvent(event('codex', '2026-07-17T08:15:30.000Z'), { path, maxEntries: 2 });
  await recordResetEvent(event('claude', '2026-07-17T08:16:30.000Z'), { path, maxEntries: 2 });
  const newest = await recordResetEvent(event('codex', '2026-07-17T08:17:30.000Z', 'Weekly'), {
    path,
    maxEntries: 2,
  });

  assert.equal(newest.length, 2);
  assert.deepEqual(newest.map((entry) => entry.detectedAt), [
    '2026-07-17T08:17:30.000Z',
    '2026-07-17T08:16:30.000Z',
  ]);
});

test('reset history rejects incomplete events and cleans display fields', () => {
  assert.equal(normalizeResetEvent({ provider: 'Codex', detectedAt: 'invalid' }), null);
  assert.deepEqual(
    normalizeResetEvent({
      providerId: 'codex',
      provider: 'Codex\nforged',
      windows: [{ key: 'session', label: 'Session\twindow' }],
      detectedAt: '2026-07-17T08:15:30.000Z',
    }),
    {
      providerId: 'codex',
      provider: 'Codex forged',
      windows: [{ key: 'session', label: 'Session window' }],
      detectedAt: '2026-07-17T08:15:30.000Z',
    },
  );
});

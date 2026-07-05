import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDemoProviders } from '../lib/demo.js';
import { stripBlessedTags } from '../lib/format.js';
import { parseArgs } from '../lib/cli.js';

const EXPECTED_IDS = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'antigravity', 'opencode', 'zai'];

test('makeDemoProviders returns every provider with the full contract', async () => {
  const providers = makeDemoProviders();

  assert.deepEqual(providers.map((provider) => provider.id), EXPECTED_IDS);

  for (const provider of providers) {
    assert.ok(provider.title, `${provider.id} has a title`);
    assert.ok(provider.refreshMs > 0, `${provider.id} has a refresh interval`);

    const snapshot = await provider.fetch();
    const status = provider.headerStatus(snapshot);
    assert.equal(status.ok, true, `${provider.id} reports OK`);

    for (const mode of ['detail', 'compact']) {
      const text = stripBlessedTags(provider.render(snapshot, 96, mode));
      assert.ok(text.length > 0, `${provider.id} renders ${mode}`);
      assert.ok(!text.includes('undefined'), `${provider.id} ${mode} has no undefined: ${text}`);
    }

    const alerts = provider.alertItems(snapshot);
    assert.ok(alerts.length > 0, `${provider.id} has alert items`);

    for (const alert of alerts) {
      assert.ok(alert.key && alert.label, `${provider.id} alert has key/label`);
      assert.ok(Number.isFinite(alert.percent), `${provider.id} alert percent is a number`);
      assert.ok(alert.percent >= 0 && alert.percent <= 100, `${provider.id} percent in range`);
    }
  }
});

test('demo snapshots are stable across refreshes (only clocks move)', async () => {
  const [provider] = makeDemoProviders(['codex']);
  const first = await provider.fetch();
  const second = await provider.fetch();

  assert.deepEqual(
    first.items.map((item) => [item.key, item.percent, item.value]),
    second.items.map((item) => [item.key, item.percent, item.value]),
  );
});

test('makeDemoProviders filters by id for single-provider entries', () => {
  const providers = makeDemoProviders(['zai']);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'zai');
});

test('parseArgs recognizes --demo', () => {
  assert.equal(parseArgs(['--demo']).demo, true);
  assert.equal(parseArgs(['--once']).demo, false);
});

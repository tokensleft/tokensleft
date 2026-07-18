import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEMO_IDS, makeDemoProviders } from '../lib/demo.js';
import { stripBlessedTags } from '../lib/format.js';
import { parseArgs, runCli } from '../lib/cli.js';
import {
  composeProviderColumns,
  dashboardContentLayout,
  providerBlocksFitColumn,
  visibleCellWidth,
} from '../lib/tui.js';

const ALL_IDS = ['claude', 'codex', 'gemini', 'kimi', 'copilot', 'grok', 'antigravity', 'opencode', 'zai'];
const FIXED_NOW = Date.parse('2026-07-14T12:00:00Z');

function fixedDemo(ids = ALL_IDS) {
  return makeDemoProviders(ids, { clock: () => FIXED_NOW, random: () => 0.5 });
}

function snapshotItems(snapshot) {
  if (Array.isArray(snapshot.results)) {
    return snapshot.results.flatMap((result) => result.items || []);
  }

  return snapshot.items || [];
}

test('default demo mirrors a plausible detected-provider run', () => {
  assert.deepEqual(makeDemoProviders(undefined, {
    clock: () => FIXED_NOW,
    random: () => 0.5,
  }).map((provider) => provider.id), DEFAULT_DEMO_IDS);
  assert.deepEqual(DEFAULT_DEMO_IDS, ['claude', 'codex', 'gemini', 'kimi', 'antigravity', 'zai']);
});

test('every demo provider keeps the full dashboard contract', async () => {
  const providers = fixedDemo();

  assert.deepEqual(providers.map((provider) => provider.id), ALL_IDS);

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
      assert.ok('resetAt' in alert, `${provider.id} alert carries its reset timestamp`);
    }
  }
});

test('demo fixtures follow current live provider shapes', async () => {
  const providers = Object.fromEntries(fixedDemo().map((provider) => [provider.id, provider]));
  const snapshots = Object.fromEntries(await Promise.all(Object.entries(providers).map(async ([id, provider]) => [id, await provider.fetch()])));

  const claude = snapshots.claude;
  assert.equal(claude.results[0].name, 'system');
  assert.equal(claude.results[0].plan, 'max / claude_max_20x');
  assert.deepEqual(claude.results[0].items.map((item) => item.label), ['Session', 'Weekly all', 'Wk Fable']);
  assert.deepEqual(claude.local.models.map((entry) => entry.model), [
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-haiku-4-5-20251001',
  ]);

  assert.equal(snapshots.codex.plan, 'plus');
  assert.deepEqual(snapshots.codex.items.map((item) => item.label), ['Weekly', 'Resets', 'Reset chance (48h)']);
  assert.equal(snapshots.codex.items[1].kind, 'info');
  assert.equal(snapshots.codex.items[1].details.length, 5);
  assert.equal(snapshots.codex.items[2].value, '68% · unofficial');
  assert.deepEqual(snapshots.codex.local.models.map((entry) => entry.model), ['gpt-5.5', 'gpt-5.6-sol', 'codex-auto-review']);

  assert.equal(snapshots.gemini.plan, 'Free');
  assert.deepEqual(snapshots.gemini.items.map((item) => [item.label, item.percent]), [['Pro', 100], ['Flash', 0]]);
  assert.equal(snapshots.kimi.plan, 'Allegretto');
  assert.deepEqual(snapshots.kimi.items.map((item) => item.label), [
    'Weekly limit',
    '5h limit',
    'Shared quota',
    'Parallel',
    'Extra Usage',
    'Models',
  ]);
  assert.deepEqual(snapshots.kimi.items.filter((item) => item.kind === 'usage').map((item) => item.percent), [34, 38]);
  const kimiDetail = stripBlessedTags(providers.kimi.render(snapshots.kimi, 120, 'detail'));
  const kimiCompact = stripBlessedTags(providers.kimi.render(snapshots.kimi, 120, 'compact'));
  assert.match(kimiDetail, /Allegretto[\s\S]*Shared quota[\s\S]*Parallel[\s\S]*Models/);
  assert.match(kimiCompact, /Allegretto/);
  assert.doesNotMatch(kimiCompact, /Shared quota|Parallel|Models/);
  assert.match(kimiCompact, /Weekly limit[\s\S]*5h limit[\s\S]*Extra Usage/);
  assert.deepEqual(snapshots.antigravity.items.map((item) => [item.label, item.percent]), [
    ['Gemini Pro', 0],
    ['Gemini Flash', 0],
    ['Claude', 0],
  ]);

  assert.deepEqual(snapshots.copilot.items.map((item) => item.label), ['Premium']);
  assert.deepEqual(snapshots.zai.results.map((result) => result.account.name), ['Account 1', 'Account 2']);
  assert.equal(snapshots.zai.results[0].account.proxy, 'direct');
  assert.match(snapshots.zai.results[1].account.proxy, /^http:/);
  assert.equal(snapshots.zai.results[0].items.find((item) => item.label === 'Web Searches').value, '0/1,000 0%');

  assert.equal(providers.zai.refreshMs, 60_000);
  for (const id of ALL_IDS.filter((entry) => entry !== 'zai')) {
    assert.equal(providers[id].refreshMs, 300_000, `${id} uses the live 5-minute default`);
  }
});

test('demo quota values stay stable while forecast clocks advance', async () => {
  let now = FIXED_NOW;
  const providers = makeDemoProviders(ALL_IDS, { clock: () => now, random: () => 0.5 });

  for (const provider of providers) {
    const first = await provider.fetch();
    now += 60_000;
    const second = await provider.fetch();

    const stable = (item) => [item.key, item.label, item.percent, item.value, item.resetAt?.getTime() ?? null];
    assert.deepEqual(snapshotItems(first).map(stable), snapshotItems(second).map(stable), `${provider.id} quota values are stable`);
  }
});

test('only the first Codex demo reset credit expires within the next hour', async () => {
  const now = Date.now();
  const [provider] = makeDemoProviders(['codex'], { clock: () => now, random: () => 0.5 });
  const snapshot = await provider.fetch();
  const resets = snapshot.items.find((item) => item.label === 'Resets');

  assert.match(resets.note, /^next expires \d+m \d+s$/);
  assert.equal(resets.details.length, 5);
  assert.match(resets.details[0], /^expires \d+m \d+s \(.+\)$/);
  assert.ok(resets.details.slice(1).every((line) => /^expires \d+d \d+h \(.+\)$/.test(line)));
  assert.match(stripBlessedTags(provider.render(snapshot, 100, 'compact')), /⚠ next expires \d+m \d+s/);
});

test('default demo fits responsive compact and detail columns', async () => {
  const now = Date.now();
  const providers = makeDemoProviders(undefined, { clock: () => now, random: () => 0.5 });
  const snapshots = await Promise.all(providers.map((provider) => provider.fetch()));

  for (const [shellWidth, mode] of [[160, 'compact'], [208, 'detail']]) {
    const layout = dashboardContentLayout(shellWidth, { mode, providerCount: providers.length });
    const blocks = providers.map((provider, index) => (
      `▌ ${provider.title}\n${provider.render(snapshots[index], layout.columnWidth, mode)}`
    ));

    assert.equal(layout.columns, 2);
    assert.equal(providerBlocksFitColumn(blocks, layout.columnWidth), true, `${mode} blocks fit`);
    const content = composeProviderColumns(blocks, layout, mode);
    assert.ok(content.split('\n').every((line) => visibleCellWidth(line) <= layout.contentWidth));
  }
});

test('CLI default demo uses the curated live-shaped provider set', async () => {
  const output = [];
  const realLog = console.log;
  console.log = (...args) => output.push(args.join(' '));

  try {
    await runCli(['--demo', '--once']);
  } finally {
    console.log = realLog;
  }

  const text = output.join('\n');
  for (const title of ['Claude Code', 'Codex', 'Gemini', 'Kimi Code', 'Antigravity', 'z.ai']) {
    assert.match(text, new RegExp(`▌ ${title.replace('.', '\\.')}`));
  }
  assert.doesNotMatch(text, /▌ Copilot|▌ Grok|▌ OpenCode/);
});

test('makeDemoProviders filters by id for providers outside the default set', () => {
  const providers = fixedDemo(['copilot']);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'copilot');
});

test('parseArgs recognizes --demo', () => {
  assert.equal(parseArgs(['--demo']).demo, true);
  assert.equal(parseArgs(['--once']).demo, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatPlainProviderBlock,
  isNpxExecution,
  plainOutputWidth,
  PROVIDERS,
  parseArgs,
  providerEnvironment,
  resolveProviderSupport,
  runCli,
  usage,
  VERSION,
} from '../lib/cli.js';

const EXPECTED_IDS = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'antigravity', 'opencode', 'zai'];

test('PROVIDERS registry lists all eight providers in dashboard order', () => {
  assert.deepEqual(PROVIDERS.map((entry) => entry.id), EXPECTED_IDS);

  for (const entry of PROVIDERS) {
    assert.equal(typeof entry.make, 'function', `${entry.id} has a factory`);
    assert.ok(entry.hint, `${entry.id} has a not-detected hint`);
  }

  assert.deepEqual(
    PROVIDERS.filter((entry) => entry.requiresNodeSqlite).map((entry) => entry.id),
    ['antigravity', 'opencode'],
  );
});

test('resolveProviderSupport skips only SQLite-backed providers when node:sqlite is unavailable', async () => {
  const unavailable = await resolveProviderSupport(PROVIDERS, async () => null);
  assert.deepEqual(unavailable.supported.map((entry) => entry.id), ['claude', 'codex', 'gemini', 'copilot', 'grok', 'zai']);
  assert.deepEqual(unavailable.skipped.map((entry) => entry.id), ['antigravity', 'opencode']);

  const available = await resolveProviderSupport(PROVIDERS, async () => ({ DatabaseSync() {} }));
  assert.deepEqual(available.supported, PROVIDERS);
  assert.deepEqual(available.skipped, []);
});

test('resolveProviderSupport does not probe SQLite for unrelated providers', async () => {
  let probed = false;
  const selected = PROVIDERS.filter((entry) => entry.id === 'claude');
  const support = await resolveProviderSupport(selected, async () => {
    probed = true;
    return null;
  });

  assert.equal(probed, false);
  assert.deepEqual(support.supported, selected);
});

test('parseArgs validates --interval and supports the = form', () => {
  assert.equal(parseArgs(['--interval', '30']).intervalMs, 30_000);
  assert.equal(parseArgs(['--interval=45']).intervalMs, 45_000);
  assert.throws(() => parseArgs(['--interval', 'claude']), /--interval expects a positive number/);
  assert.throws(() => parseArgs(['claude', '--interval']), /--interval expects a positive number/);
  assert.throws(() => parseArgs(['--interval=abc']), /--interval expects a positive number/);
});

test('parseArgs accepts provider positionals, dedupes, and combines with flags', () => {
  const args = parseArgs(['claude', 'zai', 'claude', '--demo', '--interval', '30']);

  assert.deepEqual(args.providers, ['claude', 'zai']);
  assert.equal(args.demo, true);
  assert.equal(args.intervalMs, 30_000);
  assert.equal(args.json, false);
});

test('parseArgs rejects unknown providers and unknown options', () => {
  assert.throws(() => parseArgs(['chatgpt']), /Unknown provider: chatgpt/);
  assert.throws(() => parseArgs(['--verbose']), /Unknown option: --verbose/);
});

test('parseArgs recognizes help', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs recognizes version and read-only mode', () => {
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['--read-only']).readOnly, true);
  assert.deepEqual(
    providerEnvironment({ TOKEN: 'value' }, true),
    { TOKEN: 'value', TOKENSLEFT_READ_ONLY: '1' },
  );
});

test('isNpxExecution recognizes npm exec/npx without mistaking an npm script for it', () => {
  assert.equal(isNpxExecution({ npm_command: 'exec', npm_lifecycle_event: 'npx' }), true);
  assert.equal(isNpxExecution({ npm_execpath: '/usr/local/bin/npx-cli.js', npm_lifecycle_event: 'npx' }), true);
  assert.equal(isNpxExecution({ npm_command: 'run-script', npm_lifecycle_event: 'npx' }), false);
  assert.equal(isNpxExecution({}), false);
});

test('plain output width prefers terminal columns then COLUMNS', () => {
  assert.equal(plainOutputWidth({ columns: 88 }, { COLUMNS: '55' }), 88);
  assert.equal(plainOutputWidth({}, { COLUMNS: '55' }), 55);
  assert.equal(plainOutputWidth({}, {}), 96);
  assert.equal(plainOutputWidth({ columns: 999 }, {}), 160);
});

test('--version prints the installed package version without loading providers', async () => {
  const output = [];
  const realLog = console.log;
  console.log = (value) => output.push(String(value));

  try {
    await runCli(['--version']);
  } finally {
    console.log = realLog;
  }

  assert.deepEqual(output, [VERSION]);
});

test('--once formatting strips terminal controls and Blessed tags at the final output sink', () => {
  const provider = {
    title: `Unsafe\x1b]0;owned\x07\u202E title`,
    render: () => '{red-fg}safe{/red-fg} \x1b[31mowned\x1b[0m',
  };
  const output = formatPlainProviderBlock(provider, {}, 80, true);

  assert.doesNotMatch(output, /\x1b|\x07|\u202E|\{\/?red-fg\}/);
  assert.match(output, /safe owned/);
});

test('usage lists every provider id', () => {
  const text = usage();

  for (const id of EXPECTED_IDS) {
    assert.ok(text.includes(id), `usage mentions ${id}`);
  }

  assert.match(text, /--read-only/);
  assert.match(text, /--version/);
});

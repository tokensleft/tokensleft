import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDERS, parseArgs, usage } from '../lib/cli.js';

const EXPECTED_IDS = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'antigravity', 'opencode', 'zai'];

test('PROVIDERS registry lists all eight providers in dashboard order', () => {
  assert.deepEqual(PROVIDERS.map((entry) => entry.id), EXPECTED_IDS);

  for (const entry of PROVIDERS) {
    assert.equal(typeof entry.make, 'function', `${entry.id} has a factory`);
    assert.ok(entry.hint, `${entry.id} has a not-detected hint`);
  }
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

test('usage lists every provider id', () => {
  const text = usage();

  for (const id of EXPECTED_IDS) {
    assert.ok(text.includes(id), `usage mentions ${id}`);
  }
});

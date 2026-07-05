import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDotEnv, readRefreshMs, splitCsv, unquote } from '../lib/env.js';

test('parseDotEnv parses assignments, quotes, comments', () => {
  const env = parseDotEnv([
    '# comment',
    'PLAIN=value',
    'QUOTED="hello world"',
    "SINGLE='x=y'",
    'SPACED =  padded  ',
    'NOEQUALS',
    '',
  ].join('\n'), { BASE: '1' });

  assert.equal(env.BASE, '1');
  assert.equal(env.PLAIN, 'value');
  assert.equal(env.QUOTED, 'hello world');
  assert.equal(env.SINGLE, 'x=y');
  assert.equal(env.SPACED, 'padded');
  assert.equal(env.NOEQUALS, undefined);
});

test('parseDotEnv overrides base env', () => {
  const env = parseDotEnv('KEY=file', { KEY: 'process' });
  assert.equal(env.KEY, 'file');
});

test('readRefreshMs takes the first valid key, floors at 5s', () => {
  assert.equal(readRefreshMs({ A: '30' }, ['A', 'B'], 999), 30_000);
  assert.equal(readRefreshMs({ B: '30' }, ['A', 'B'], 999), 30_000);
  assert.equal(readRefreshMs({ A: '2' }, ['A'], 999), 5_000);
  assert.equal(readRefreshMs({ A: 'nope' }, ['A'], 999), 999);
  assert.equal(readRefreshMs({}, ['A'], 999), 999);
});

test('splitCsv trims entries', () => {
  assert.deepEqual(splitCsv(' a, b ,c '), ['a', 'b', 'c']);
});

test('unquote strips matching quotes only', () => {
  assert.equal(unquote('"a"'), 'a');
  assert.equal(unquote("'a'"), 'a');
  assert.equal(unquote('"a'), '"a');
});

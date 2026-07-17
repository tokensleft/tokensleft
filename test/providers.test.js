import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildZaiItems, readZaiAccounts } from '../providers/zai.js';

const SAMPLE_QUOTA = {
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 8, nextResetTime: Date.now() + 3600_000, currentValue: 80, usage: 1000 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 81, nextResetTime: Date.now() + 86400_000, currentValue: 810, usage: 1000 },
      {
        type: 'TIME_LIMIT',
        currentValue: 35,
        usage: 1000,
        nextResetTime: Date.now() + 86400_000,
        usageDetails: [{ modelCode: 'search-prime', usage: 2 }],
      },
    ],
  },
};

test('buildZaiItems maps session/weekly/web-search limits', () => {
  const items = buildZaiItems(SAMPLE_QUOTA, { prefix: 'k1' });
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly', 'Web Searches']);
  assert.equal(items[0].percent, 8);
  assert.equal(items[1].percent, 81);
  assert.equal(items[2].value, '35/1,000 4%');
  assert.deepEqual(items[2].details, [{ label: 'search-prime', value: '2' }]);
  assert.ok(items.every((item) => item.key.startsWith('k1:')));
});

test('buildZaiItems handles empty quota', () => {
  const items = buildZaiItems({ data: { limits: [] } });
  assert.equal(items[0].kind, 'empty');
});

test('readZaiAccounts reads numbered, single, and csv forms', () => {
  assert.deepEqual(
    readZaiAccounts({ ZAI_KEY_1: 'a', ZAI_NAME_1: 'main', ZAI_KEY_2: 'b' }).map((account) => account.name),
    ['main', 'Account 2'],
  );
  assert.equal(readZaiAccounts({ ZAI_API_KEY: 'x' })[0].name, '');
  assert.deepEqual(readZaiAccounts({ ZAI_KEYS: 'a,b,c' }).map((account) => account.name), [
    'Account 1',
    'Account 2',
    'Account 3',
  ]);
  assert.equal(readZaiAccounts({}).length, 0);
});

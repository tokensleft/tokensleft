import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LITELLM_PRICING_URL,
  MODELS_DEV_PRICING_URL,
  calculateModelCost,
  findModelPricing,
  initializeModelPricing,
  mergePricingEntries,
  parseLiteLlmPricing,
  parseModelsDevPricing,
} from '../lib/model-pricing.js';

test('pricing sources normalize LiteLLM and supplement it with canonical models.dev tiers', () => {
  const litellm = parseLiteLlmPricing({
    'gpt-5.6-sol': {
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.00003,
      cache_read_input_token_cost: 0.0000005,
    },
    'openrouter/gpt-5.6-sol': {
      input_cost_per_token: 0.5,
      output_cost_per_token: 3,
    },
  });
  const modelsDev = parseModelsDevPricing({
    openai: {
      models: {
        'gpt-5.6-sol': {
          id: 'gpt-5.6-sol',
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [{
              input: 10,
              output: 45,
              cache_read: 1,
              tier: { type: 'context', size: 272000 },
            }],
          },
          limit: { context: 1050000 },
        },
      },
    },
  });
  const merged = mergePricingEntries(litellm, modelsDev);

  assert.deepEqual(Object.keys(litellm), ['gpt-5.6-sol']);
  assert.equal(merged['gpt-5.6-sol'].input, 5);
  assert.equal(merged['gpt-5.6-sol'].cacheRead, 0.5);
  assert.equal(merged['gpt-5.6-sol'].inputAbove, 10);
  assert.equal(merged['gpt-5.6-sol'].threshold, 272000);
  assert.equal(merged['gpt-5.6-sol'].tierMode, 'whole');
  assert.equal(merged['gpt-5.6-sol'].source, 'LiteLLM+models.dev');
});

test('model lookup handles provider prefixes, Kimi short names, and dated aliases', () => {
  const entries = {
    'claude-opus-4-1': { input: 15, output: 75 },
    'claude-opus-4-20250514': { input: 15, output: 75 },
    'gpt-5.1-codex-mini': { input: 0.25, output: 2 },
    'kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
    'glm-5': { input: 1, output: 3.2 },
  };

  assert.equal(findModelPricing('claude-opus-4-1-20250805', { entries }).input, 15);
  assert.equal(findModelPricing('claude-opus-4', { entries }).output, 75);
  assert.equal(findModelPricing('gpt-5.1-mini', { entries }).input, 0.25);
  assert.equal(findModelPricing('kimi-code/k3', { entries }).output, 15);
  assert.equal(findModelPricing('zai/glm-5', { entries }).output, 3.2);
  assert.equal(findModelPricing('unknown-model', { entries }), null);
});

test('embedded pricing retains the previous Claude Code fallback model', () => {
  assert.deepEqual(
    [findModelPricing('claude-mythos-5').input, findModelPricing('claude-mythos-5').output],
    [10, 50],
  );
});

test('cost calculation prices cache buckets and one-hour Claude cache writes', () => {
  const entries = {
    'test-model': {
      input: 1,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    },
  };
  const cost = calculateModelCost('test-model', {
    input: 100,
    output: 10,
    cacheRead: 20,
    cacheWrite5m: 30,
    cacheWrite1h: 40,
  }, { entries });

  assert.equal(cost, (100 + 100 + 2 + 37.5 + 80) / 1_000_000);
});

test('OpenAI long-context pricing switches the whole request above 272K', () => {
  const entries = {
    'gpt-5.6-sol': {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      inputAbove: 10,
      outputAbove: 45,
      cacheReadAbove: 1,
      threshold: 272000,
      tierMode: 'whole',
    },
  };
  const short = calculateModelCost('gpt-5.6-sol', {
    input: 100000,
    output: 1000,
    cacheRead: 100,
    totalInput: 100100,
  }, { entries });
  const long = calculateModelCost('gpt-5.6-sol', {
    input: 300000,
    output: 1000,
    cacheRead: 100,
    totalInput: 300100,
  }, { entries });

  assert.ok(Math.abs(short - 0.53005) < 1e-12);
  assert.ok(Math.abs(long - 3.0451) < 1e-12);
});

test('Claude Sonnet 5 follows the temporary official promotional rate', () => {
  const entries = {
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const during = findModelPricing('claude-sonnet-5', {
    entries,
    now: Date.parse('2026-08-31T23:59:59Z'),
  });
  const after = findModelPricing('claude-sonnet-5', {
    entries,
    now: Date.parse('2026-09-01T00:00:00Z'),
  });

  assert.deepEqual([during.input, during.output, during.cacheRead], [2, 10, 0.2]);
  assert.deepEqual([after.input, after.output, after.cacheRead], [3, 15, 0.3]);
});

test('pricing refresh writes a last-known-good cache and a fresh cache skips network', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-pricing-'));
  const cachePath = join(dir, 'pricing.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-07-19T12:00:00Z');
  const calls = [];
  const fetchJsonFn = async (url) => {
    calls.push(url);

    if (url === LITELLM_PRICING_URL) {
      return {
        'gpt-test': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      };
    }

    assert.equal(url, MODELS_DEV_PRICING_URL);
    return {
      moonshotai: {
        models: {
          'kimi-test': {
            id: 'kimi-test',
            cost: { input: 3, output: 15, cache_read: 0.3 },
          },
          'kimi-k3': {
            id: 'kimi-k3',
            cost: { input: 4, output: 20, cache_read: 0.4 },
          },
        },
      },
    };
  };

  const first = await initializeModelPricing({
    now,
    cachePath,
    fetchJsonFn,
    minimumEntries: 1,
  });
  const cached = JSON.parse(await readFile(cachePath, 'utf8'));

  assert.equal(first.source, 'live');
  assert.deepEqual(calls.sort(), [LITELLM_PRICING_URL, MODELS_DEV_PRICING_URL].sort());
  assert.equal(cached.entries['gpt-test'].input, 1);
  assert.equal(cached.entries['kimi-test'].output, 15);
  assert.equal(cached.entries['kimi-k3'].output, 20);

  calls.length = 0;
  const second = await initializeModelPricing({
    now: now + 1000,
    cachePath,
    fetchJsonFn,
    minimumEntries: 1,
  });

  assert.equal(second.source, 'cache');
  assert.deepEqual(calls, []);
});

test('an undersized cache refreshes and one source may fail synchronously', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-pricing-small-cache-'));
  const cachePath = join(dir, 'pricing.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-07-19T12:00:00Z');
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    updatedAt: new Date(now).toISOString(),
    entries: {
      incomplete: { input: 1, output: 2 },
    },
  }));
  const calls = [];
  const metadata = await initializeModelPricing({
    now,
    cachePath,
    minimumEntries: 2,
    fetchJsonFn(url) {
      calls.push(url);

      if (url === LITELLM_PRICING_URL) {
        throw new Error('synchronous fetch failure');
      }

      return {
        moonshotai: {
          models: {
            'kimi-test-a': { id: 'kimi-test-a', cost: { input: 1, output: 2 } },
            'kimi-test-b': { id: 'kimi-test-b', cost: { input: 3, output: 4 } },
          },
        },
      };
    },
  });

  assert.equal(metadata.source, 'live');
  assert.deepEqual(calls.sort(), [LITELLM_PRICING_URL, MODELS_DEV_PRICING_URL].sort());
  assert.equal(findModelPricing('kimi-test-b').output, 4);

  const offline = await initializeModelPricing({
    env: { TOKENSLEFT_PRICING_OFFLINE: '1' },
    cachePath: join(dir, 'missing.json'),
    fetchJsonFn() {
      throw new Error('offline mode must not fetch');
    },
  });
  assert.equal(offline.source, 'embedded');
  assert.equal(findModelPricing('kimi-test-b'), null);
});

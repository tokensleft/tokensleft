import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCodexResetForecastItem,
  createCodexProvider,
  createCodexResetForecastFetcher,
  parseCodexResetForecast,
} from '../providers/codex.js';

test('Codex reset forecast parser accepts only a valid 0-100 score', () => {
  const forecast = parseCodexResetForecast({
    fetchedAt: '2026-07-18T07:02:07.329Z',
    nextRefreshAt: '2026-07-18T07:32:07.329Z',
    forecast: { score: 94.6 },
  });

  assert.equal(forecast.score, 95);
  assert.equal(forecast.fetchedAt.toISOString(), '2026-07-18T07:02:07.329Z');
  assert.equal(forecast.nextRefreshAt.toISOString(), '2026-07-18T07:32:07.329Z');
  assert.equal(parseCodexResetForecast({ forecast: { score: -1 } }), null);
  assert.equal(parseCodexResetForecast({ forecast: { score: 101 } }), null);
  assert.equal(parseCodexResetForecast({ forecast: { score: '95' } }), null);
  assert.equal(parseCodexResetForecast({}), null);
});

test('Codex reset forecast fetcher is anonymous and caches until the source refreshes', async () => {
  let now = Date.parse('2026-07-18T07:00:00.000Z');
  let score = 63;
  let calls = 0;
  const fetchForecast = createCodexResetForecastFetcher({
    clock: () => now,
    async fetcher(url, options) {
      calls += 1;
      assert.equal(url, 'https://www.willcodexquotareset.com/api/forecast');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['User-Agent'], 'tokensleft');
      assert.equal(options.timeoutMs, 4_000);
      return {
        fetchedAt: new Date(now).toISOString(),
        nextRefreshAt: new Date(now + 30 * 60 * 1000).toISOString(),
        forecast: { score },
      };
    },
  });

  assert.equal((await fetchForecast()).score, 63);
  now += 29 * 60 * 1000;
  assert.equal((await fetchForecast()).score, 63);
  assert.equal(calls, 1);

  now += 2 * 60 * 1000;
  score = 74;
  assert.equal((await fetchForecast()).score, 74);
  assert.equal(calls, 2);
});

test('Codex reset forecast failures are omitted instead of breaking quota usage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-codex-forecast-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'codex-access', account_id: 'account-1' },
    last_refresh: new Date().toISOString(),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage');
    return new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 604800 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createCodexProvider({ CODEX_HOME: dir }, {
    resetForecastFetcher: async () => {
      throw new Error('forecast unavailable');
    },
  });
  const snapshot = await provider.fetch();

  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.items.map((item) => item.label), ['Weekly']);
});

test('Codex provider renders the unofficial 48-hour reset chance in its section', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-codex-forecast-render-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'codex-access', account_id: 'account-1' },
    last_refresh: new Date().toISOString(),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 604800 },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = await createCodexProvider({ CODEX_HOME: dir }, {
    resetForecastFetcher: async () => ({ score: 95 }),
  });
  const snapshot = await provider.fetch();
  const item = buildCodexResetForecastItem({ score: 95 });

  assert.deepEqual(snapshot.items.at(-1), item);
  assert.match(provider.render(snapshot, 100, 'compact'), /Reset chance \(48h\)[\s\S]*95% · unofficial/);
  assert.match(provider.render(snapshot, 100, 'detail'), /source willcodexquotareset\.com/);
});

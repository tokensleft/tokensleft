import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyAgent } from 'undici';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchJson,
  parseRetryAfterDate,
} from '../lib/http.js';

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('parseRetryAfterDate handles delay-seconds relative to a stable clock', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  assert.equal(parseRetryAfterDate('90', now).getTime(), now + 90_000);
  assert.equal(parseRetryAfterDate('0', now).getTime(), now);
});

test('parseRetryAfterDate accepts HTTP dates and rejects invalid values', () => {
  assert.equal(
    parseRetryAfterDate('Wed, 15 Jul 2026 06:00:00 GMT').toISOString(),
    '2026-07-15T06:00:00.000Z',
  );
  assert.equal(parseRetryAfterDate('not-a-retry-time'), null);
  assert.equal(parseRetryAfterDate(null), null);
});

test('fetchJson enforces the default timeout and accepts a caller signal', async () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);

  await withMockFetch((_url, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);

    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }), async () => {
    // AbortSignal.timeout uses an unref'ed timer, so keep this unit-test
    // process alive long enough to observe it when fetch itself is mocked.
    const keepAlive = setTimeout(() => {}, 1_000);

    try {
      await assert.rejects(
        fetchJson('https://example.test/timeout', { timeoutMs: 20 }),
        (error) => error.cause?.name === 'TimeoutError',
      );
    } finally {
      clearTimeout(keepAlive);
    }

    const controller = new AbortController();
    const request = fetchJson('https://example.test/cancel', {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort(new Error('caller cancelled'));

    await assert.rejects(
      request,
      (error) => error.cause?.message === 'caller cancelled',
    );
  });
});

test('overlapping requests reuse one proxy dispatcher and close it afterward', async () => {
  const originalClose = ProxyAgent.prototype.close;
  const dispatchers = [];
  let closes = 0;

  ProxyAgent.prototype.close = function close(...args) {
    // DispatcherBase.close() re-enters itself once with a callback.
    if (args.length === 0) {
      closes += 1;
    }
    return originalClose.apply(this, args);
  };

  try {
    await withMockFetch(async (_url, options) => {
      dispatchers.push(options.dispatcher);
      await new Promise((resolve) => setImmediate(resolve));
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const proxy = 'http://user:password@127.0.0.1:7890';
      const results = await Promise.all([
        fetchJson('https://example.test/a', { proxy }),
        fetchJson('https://example.test/b', { proxy }),
      ]);

      assert.deepEqual(results, [{ ok: true }, { ok: true }]);
      assert.equal(dispatchers.length, 2);
      assert.equal(dispatchers[0], dispatchers[1]);
      assert.equal(closes, 1);

      await assert.rejects(
        fetchJson('https://example.test/invalid-proxy', { proxy: 'http://user:password@[' }),
        (error) => error.message === 'Proxy configuration is invalid or unsupported.'
          && !error.message.includes('password'),
      );
    });
  } finally {
    ProxyAgent.prototype.close = originalClose;
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isReloginRequired,
  oauthErrorCode,
  postTokenRefresh,
  ReloginRequiredError,
} from '../lib/oauth.js';
import {
  errorSnapshot,
  multiAccountHeaderStatus,
  singleAccountHeaderStatus,
  usageAlertItems,
} from '../lib/provider.js';

test('oauthErrorCode finds the grant error wherever the server put it', () => {
  assert.equal(oauthErrorCode({ error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(oauthErrorCode({ error: { code: 'invalid_client' } }), 'invalid_client');
  assert.equal(oauthErrorCode({ code: ' expired ' }), 'expired');
  assert.equal(oauthErrorCode({ error_description: 'Token has been revoked' }), 'Token has been revoked');
  assert.equal(oauthErrorCode({ error: { type: 'html' } }), '');
  assert.equal(oauthErrorCode(null), '');
  assert.equal(oauthErrorCode('invalid_grant'), '');
});

test('isReloginRequired accepts the shared error class and duck-typed provider errors', () => {
  const error = new ReloginRequiredError('log in again', { code: 'invalid_grant' });

  assert.equal(error.name, 'ReloginRequiredError');
  assert.equal(error.code, 'invalid_grant');
  assert.equal(error.message, 'log in again');
  assert.equal(isReloginRequired(error), true);
  assert.equal(isReloginRequired(Object.assign(new Error('kimi'), { relogin: true })), true);
  assert.equal(isReloginRequired(new Error('network')), false);
  assert.equal(isReloginRequired('token refresh rejected'), false);
  assert.equal(isReloginRequired(null), false);
});

test('postTokenRefresh encodes form and JSON grants and reports transport failures softly', async (t) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });

    if (calls.length === 1) {
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    }

    if (calls.length === 2) {
      return new Response('<html>bad gateway</html>', { status: 502 });
    }

    throw new Error('ECONNRESET');
  };
  t.after(() => { globalThis.fetch = original; });

  const form = await postTokenRefresh('https://auth.example/token', {
    form: { grant_type: 'refresh_token', refresh_token: 'r' },
  });
  assert.deepEqual(form, { status: 200, ok: true, body: { access_token: 'a' }, failure: null });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].options.body, 'grant_type=refresh_token&refresh_token=r');

  const json = await postTokenRefresh('https://auth.example/token', {
    json: { grant_type: 'refresh_token' },
    timeoutMs: 50,
  });
  assert.equal(json.status, 502);
  assert.equal(json.ok, false);
  assert.equal(json.body, null);
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.body, '{"grant_type":"refresh_token"}');

  const failed = await postTokenRefresh('https://auth.example/token', { form: {} });
  assert.equal(failed.status, 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.body, null);
  assert.match(failed.failure.message, /ECONNRESET/);
});

test('provider helpers build error snapshots, header status, and usage-only alerts', () => {
  const startedAt = Date.now() - 5;
  const snapshot = errorSnapshot(401, 'nope', startedAt, { body: 'x' });

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.status, 401);
  assert.equal(snapshot.error, 'nope');
  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.body, 'x');
  assert.ok(snapshot.ms >= 5);

  assert.deepEqual(singleAccountHeaderStatus({ ok: true }), { ok: true, text: 'OK' });
  assert.deepEqual(singleAccountHeaderStatus({ ok: false, status: 'CRED' }), { ok: false, text: 'CRED' });
  assert.deepEqual(singleAccountHeaderStatus({ ok: false }), { ok: false, text: 'ERR' });

  assert.deepEqual(multiAccountHeaderStatus({ fatal: 'boom' }), { ok: false, text: 'ERR' });
  assert.deepEqual(multiAccountHeaderStatus({ results: [{ ok: true }, { ok: false }] }), { ok: false, text: '1/2 OK' });
  assert.deepEqual(
    multiAccountHeaderStatus(
      { results: [{ ok: true }, { ok: false, status: 'DUP' }] },
      { countable: (result) => result.status !== 'DUP' },
    ),
    { ok: true, text: '1/1 OK' },
  );

  const items = [
    { kind: 'usage', key: 'a', label: 'Session', percent: 10, resetAt: null },
    { kind: 'info', key: 'b', label: 'Credits', value: '3' },
    { kind: 'empty', key: 'c', label: 'Quota' },
  ];
  assert.deepEqual(usageAlertItems(items), [{ key: 'a', label: 'Session', percent: 10, resetAt: null }]);
  assert.equal(usageAlertItems(items, 'work')[0].label, 'work Session');
  assert.deepEqual(usageAlertItems(undefined), []);
});

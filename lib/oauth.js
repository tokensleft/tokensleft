import { parseJson } from './http.js';

const DEFAULT_TIMEOUT_MS = 15_000;

// Thrown when the refresh token itself is dead and only a fresh login in the
// owning CLI can help. Providers turn it into an EXPIRED snapshot carrying the
// message verbatim; every other refresh failure is soft and keeps the current
// access token in play.
export class ReloginRequiredError extends Error {
  constructor(message, { code = '' } = {}) {
    super(message);
    this.name = 'ReloginRequiredError';
    this.code = code;
    this.relogin = true;
  }
}

// Duck-typed so provider-specific error classes (Kimi's) can opt in by
// setting `relogin` without extending this class.
export function isReloginRequired(error) {
  return error instanceof ReloginRequiredError || error?.relogin === true;
}

// The OAuth error code of a rejected grant, wherever the server put it.
export function oauthErrorCode(body) {
  if (!body || typeof body !== 'object') {
    return '';
  }

  const candidates = [body.error?.code, body.error, body.code, body.error_description];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim() : '';
}

// POSTs a refresh_token grant. `form` sends application/x-www-form-urlencoded,
// `json` sends a JSON document. A transport failure (offline, DNS, timeout)
// comes back as { failure } with status 0 so callers can keep their current
// token; an HTTP answer comes back as { status, ok, body } with the parsed
// JSON body, or null when the server did not answer with JSON.
export async function postTokenRefresh(url, { form, json, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const body = form ? new URLSearchParams(form).toString() : JSON.stringify(json ?? {});
  const contentType = form ? 'application/x-www-form-urlencoded' : 'application/json';
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { status: 0, ok: false, body: null, failure: error };
  }

  const text = await response.text();
  return { status: response.status, ok: response.ok, body: parseJson(text), failure: null };
}

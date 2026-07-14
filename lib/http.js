export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// Proxy dispatchers are shared while requests overlap, then closed as soon as
// the last borrower finishes. z.ai requests subscription and quota data in
// parallel, so this avoids creating two connection pools per account without
// leaving a new pool behind on every dashboard refresh.
const proxyAgents = new Map();

export async function fetchJson(url, {
  key,
  headers = {},
  proxy = '',
  signal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const requestSignal = combineRequestSignals(signal, timeoutMs);
  const proxyLease = proxy ? await acquireProxyAgent(proxy) : null;
  const requestOptions = {
    method: 'GET',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      Accept: 'application/json',
      ...headers,
    },
    ...(requestSignal ? { signal: requestSignal } : {}),
    ...(proxyLease ? { dispatcher: proxyLease.dispatcher } : {}),
  };

  try {
    let response;

    try {
      response = await fetch(url, requestOptions);
    } catch (error) {
      const detail = proxy
        ? `request via proxy failed (${error?.name || 'Error'})`
        : `request failed: ${error?.message || String(error)}`;
      throw Object.assign(new Error(detail, { cause: error }), { url });
    }

    const text = await response.text();
    const data = parseJson(text);

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('API key invalid or unauthorized'), {
        status: response.status,
        body: text,
        url,
      });
    }

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        status: response.status,
        body: text,
        url,
        retryAfterAt: parseRetryAfterDate(response.headers.get('retry-after')),
      });
    }

    if (!data) {
      throw Object.assign(new Error('invalid JSON response'), {
        status: response.status,
        body: text,
        url,
      });
    }

    return data;
  } finally {
    await proxyLease?.release();
  }
}

export async function fetchJsonResult(url, options) {
  try {
    return { ok: true, data: await fetchJson(url, options) };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      status: error.status || 'ERR',
      body: error.body || '',
      url: error.url || url,
      retryAfterAt: error.retryAfterAt || null,
    };
  }
}

function combineRequestSignals(signal, timeoutMs) {
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : null;

  if (signal && timeoutSignal) {
    return AbortSignal.any([signal, timeoutSignal]);
  }

  return signal || timeoutSignal;
}

async function acquireProxyAgent(proxy) {
  let entry = proxyAgents.get(proxy);

  if (!entry) {
    entry = { promise: createProxyAgent(proxy), borrowers: 0 };
    proxyAgents.set(proxy, entry);
  }

  entry.borrowers += 1;

  try {
    const dispatcher = await entry.promise;
    let released = false;

    return {
      dispatcher,
      async release() {
        if (released) {
          return;
        }

        released = true;
        entry.borrowers -= 1;

        if (entry.borrowers > 0) {
          return;
        }

        if (proxyAgents.get(proxy) === entry) {
          proxyAgents.delete(proxy);
        }

        await closeProxyAgent(dispatcher);
      },
    };
  } catch (error) {
    entry.borrowers -= 1;

    if (entry.borrowers === 0 && proxyAgents.get(proxy) === entry) {
      proxyAgents.delete(proxy);
    }

    throw error;
  }
}

async function createProxyAgent(proxy) {
  let ProxyAgent;

  try {
    ({ ProxyAgent } = await import('undici'));
  } catch {
    throw new Error('Proxy support requires undici. Run npm install first.');
  }

  try {
    return new ProxyAgent(proxy);
  } catch {
    // Do not echo the URL: authenticated proxy URLs may contain a password.
    throw new Error('Proxy configuration is invalid or unsupported.');
  }
}

async function closeProxyAgent(dispatcher) {
  try {
    if (typeof dispatcher?.close === 'function') {
      await dispatcher.close();
    } else if (typeof dispatcher?.destroy === 'function') {
      await dispatcher.destroy();
    }
  } catch {
    // Cleanup must not replace the request result with a pool-close error.
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseRetryAfterDate(value, now = Date.now()) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now + seconds * 1000);
  }

  const retryAt = Date.parse(value);

  if (Number.isFinite(retryAt)) {
    return new Date(retryAt);
  }

  return null;
}

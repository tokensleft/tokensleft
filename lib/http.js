export async function fetchJson(url, { key, headers = {}, proxy = '' } = {}) {
  const requestOptions = {
    method: 'GET',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      Accept: 'application/json',
      ...headers,
    },
  };

  if (proxy) {
    requestOptions.dispatcher = await createProxyAgent(proxy);
  }

  let response;

  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    throw Object.assign(new Error(`request failed: ${error.message}`), { url });
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

async function createProxyAgent(proxy) {
  try {
    const { ProxyAgent } = await import('undici');
    return new ProxyAgent(proxy);
  } catch (error) {
    throw new Error(`Proxy requires undici. Run npm install first. Original error: ${error.message}`);
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

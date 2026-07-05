import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { configPath } from '../lib/fsx.js';
import { parseJson } from '../lib/http.js';
import { renderSingleAccount } from './codex.js';

const CLOUD_CODE_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';
// Antigravity's public "installed application" OAuth client (same values in
// every install; used only to redeem the refresh token from its state DB).
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const OAUTH_TOKEN_SENTINEL = 'oauthTokenInfoSentinelKey';
const QUOTA_PERIOD_MS = 5 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const MODEL_BLACKLIST = new Set([
  'MODEL_CHAT_20706',
  'MODEL_CHAT_23310',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'MODEL_GOOGLE_GEMINI_2_5_PRO',
  'MODEL_PLACEHOLDER_M19',
  'MODEL_PLACEHOLDER_M9',
  'MODEL_PLACEHOLDER_M12',
]);

export function antigravityStateDbPath(env) {
  if (env.ANTIGRAVITY_STATE_DB) {
    return env.ANTIGRAVITY_STATE_DB;
  }

  const suffix = join('Antigravity', 'User', 'globalStorage', 'state.vscdb');

  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), suffix);
  }

  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', suffix);
  }

  return join(homedir(), '.config', suffix);
}

// --- minimal protobuf wire-format reader ---------------------------------------

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;

  while (pos < buf.length) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;

    if ((byte & 0x80) === 0) {
      return { value, pos };
    }

    shift += 7;
  }

  return null;
}

export function readProtoFields(buf) {
  const fields = {};
  let pos = 0;

  while (pos < buf.length) {
    const tag = readVarint(buf, pos);

    if (!tag) {
      break;
    }

    pos = tag.pos;
    const fieldNum = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;

    if (wireType === 0) {
      const varint = readVarint(buf, pos);

      if (!varint) {
        break;
      }

      fields[fieldNum] = { type: 0, value: varint.value };
      pos = varint.pos;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 2) {
      const length = readVarint(buf, pos);

      if (!length || length.pos + length.value > buf.length) {
        break;
      }

      fields[fieldNum] = { type: 2, data: buf.subarray(length.pos, length.pos + length.value) };
      pos = length.pos + length.value;
    } else {
      break;
    }
  }

  return fields;
}

// Antigravity wraps OAuth state in a double-base64 protobuf envelope:
// b64( outer{ 1: wrapper{ 1: sentinel, 2: payload{ 1: b64(inner proto) } } } ),
// inner{ 1: accessToken, 3: refreshToken, 4: { 1: expirySeconds } }.
export function unwrapOAuthEnvelope(base64Text) {
  const outer = readProtoFields(Buffer.from(String(base64Text || '').trim(), 'base64'));

  if (outer[1]?.type !== 2) {
    return null;
  }

  const wrapper = readProtoFields(outer[1].data);
  const sentinel = wrapper[1]?.type === 2 ? wrapper[1].data.toString('utf8') : '';
  const payload = wrapper[2]?.type === 2 ? readProtoFields(wrapper[2].data) : null;

  if (sentinel !== OAUTH_TOKEN_SENTINEL || payload?.[1]?.type !== 2) {
    return null;
  }

  const inner = readProtoFields(Buffer.from(payload[1].data.toString('utf8').trim(), 'base64'));
  const accessToken = inner[1]?.type === 2 ? inner[1].data.toString('utf8') : '';
  const refreshToken = inner[3]?.type === 2 ? inner[3].data.toString('utf8') : '';
  const expiryField = inner[4]?.type === 2 ? readProtoFields(inner[4].data) : null;
  const expirySeconds = expiryField?.[1]?.type === 0 ? expiryField[1].value : null;

  if (!accessToken && !refreshToken) {
    return null;
  }

  return { accessToken, refreshToken, expirySeconds };
}

// --- credential loading ----------------------------------------------------------

async function readStateDbValue(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');

  const query = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });

    try {
      return db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(OAUTH_TOKEN_KEY)?.value;
    } finally {
      db.close();
    }
  };

  try {
    return query(dbPath);
  } catch {
    // DB may be locked by a running Antigravity — retry against a copy.
    const copyPath = join(tmpdir(), `tokensleft-antigravity-${process.pid}.vscdb`);
    await writeFile(copyPath, await readFile(dbPath));
    return query(copyPath);
  }
}

const REFRESH_CACHE_PATH = configPath('antigravity-auth.json');

async function loadCachedToken() {
  const cached = parseJson(await readFile(REFRESH_CACHE_PATH, 'utf8').catch(() => ''));

  if (cached?.accessToken && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  return null;
}

async function cacheToken(accessToken, expiresInSeconds) {
  await mkdir(configPath(), { recursive: true }).catch(() => {});
  await writeFile(REFRESH_CACHE_PATH, JSON.stringify({
    accessToken,
    expiresAtMs: Date.now() + (expiresInSeconds || 3600) * 1000,
  })).catch(() => {});
}

// The state DB is owned by Antigravity and its envelope is write-hostile, so
// refreshed tokens are cached in ~/.tokensleft instead of being written back.
async function refreshAccessToken(refreshToken) {
  let response;

  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }

  const body = parseJson(await response.text());

  if (response.status === 400 || response.status === 401) {
    throw `token refresh rejected (${body?.error || response.status}) — sign in to Antigravity again`;
  }

  if (!response.ok || !body?.access_token) {
    return null;
  }

  await cacheToken(body.access_token, body.expires_in);
  return body.access_token;
}

// --- quota parsing ----------------------------------------------------------------

function poolLabel(displayName) {
  const normalized = displayName.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

  if (normalized.includes('gemini') && normalized.includes('pro')) {
    return 'Gemini Pro';
  }

  if (normalized.includes('gemini') && normalized.includes('flash')) {
    return 'Gemini Flash';
  }

  // All non-Gemini models (Claude, GPT-OSS, ...) share one quota pool.
  return 'Claude';
}

export function buildAntigravityItems(data, { prefix = 'antigravity', now = Date.now() } = {}) {
  const models = data?.models;

  if (!models || typeof models !== 'object') {
    return [];
  }

  const pools = new Map();

  for (const [key, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object' || model.isInternal) {
      continue;
    }

    if (MODEL_BLACKLIST.has(model.model || key)) {
      continue;
    }

    const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : '';

    if (!displayName) {
      continue;
    }

    const fraction = typeof model.quotaInfo?.remainingFraction === 'number' ? model.quotaInfo.remainingFraction : 0;
    const pool = poolLabel(displayName);
    const existing = pools.get(pool);

    if (!existing || fraction < existing.fraction) {
      pools.set(pool, { fraction, resetTime: model.quotaInfo?.resetTime || null });
    }
  }

  const order = ['Gemini Pro', 'Gemini Flash', 'Claude'];

  return [...pools.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, pool]) => buildUsageItem({
      key: `${prefix}:${label.toLowerCase().replace(/\s+/g, '-')}`,
      label,
      percent: (1 - Math.max(0, Math.min(1, pool.fraction))) * 100,
      resetAt: toDate(pool.resetTime),
      periodMs: QUOTA_PERIOD_MS,
      now,
    }));
}

async function fetchAvailableModels(token) {
  for (const url of CLOUD_CODE_URLS) {
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'antigravity',
        },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      return { authFailed: true };
    }

    if (response.ok) {
      return { data: parseJson(await response.text()) };
    }
  }

  return { data: null };
}

// --- provider -----------------------------------------------------------------------

export async function createAntigravityProvider(env) {
  const dbPath = antigravityStateDbPath(env);

  if (!await access(dbPath).then(() => true, () => false)) {
    return null;
  }

  return {
    id: 'antigravity',
    title: 'Antigravity',
    refreshMs: readRefreshMs(env, ['ANTIGRAVITY_REFRESH_SECONDS', 'ANTIGRAVITY_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();
      let tokens;

      try {
        const value = await readStateDbValue(dbPath);
        tokens = value ? unwrapOAuthEnvelope(value) : null;
      } catch (error) {
        return { ok: false, status: 'DB', error: `cannot read Antigravity state: ${error.message}`, ms: Date.now() - startedAt, items: [] };
      }

      if (!tokens) {
        return { ok: false, status: 'CRED', error: 'No Antigravity OAuth state found. Start Antigravity and sign in first.', ms: Date.now() - startedAt, items: [] };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const candidates = [];

      if (tokens.accessToken && (!tokens.expirySeconds || tokens.expirySeconds > nowSec)) {
        candidates.push(tokens.accessToken);
      }

      const cached = await loadCachedToken();

      if (cached && !candidates.includes(cached)) {
        candidates.push(cached);
      }

      try {
        let result = { data: null };
        let sawAuthFailure = false;

        for (const candidate of candidates) {
          result = await fetchAvailableModels(candidate);

          if (result.data) {
            break;
          }

          if (result.authFailed) {
            sawAuthFailure = true;
          }
        }

        // Refresh only on evidence of auth failure (or no usable token) so a
        // Cloud Code outage doesn't burn a refresh grant every probe.
        if (!result.data && tokens.refreshToken && (sawAuthFailure || candidates.length === 0)) {
          const refreshed = await refreshAccessToken(tokens.refreshToken);

          if (refreshed) {
            result = await fetchAvailableModels(refreshed);
          }
        }

        const ms = Date.now() - startedAt;

        if (!result.data) {
          return {
            ok: false,
            status: result.authFailed ? 401 : 'ERR',
            error: result.authFailed
              ? 'Antigravity session expired. Start Antigravity and sign in again.'
              : 'Cloud Code request failed. Try again later.',
            ms,
            items: [],
          };
        }

        const items = buildAntigravityItems(result.data);

        if (items.length === 0) {
          return { ok: false, status: 'ERR', error: 'no model quota data in response', ms, items: [] };
        }

        return { ok: true, ms, plan: '', items };
      } catch (error) {
        const message = typeof error === 'string' ? error : `request failed: ${error.message}`;
        return { ok: false, status: typeof error === 'string' ? 'EXPIRED' : 'ERR', error: message, ms: Date.now() - startedAt, items: [] };
      }
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'antigravity');
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

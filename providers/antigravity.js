import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readOnlyMode, readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { configPath, writeFileAtomic } from '../lib/fsx.js';
import { parseJson } from '../lib/http.js';
import { isReloginRequired, oauthErrorCode, postTokenRefresh, ReloginRequiredError } from '../lib/oauth.js';
import { createSingleAccountProvider, errorSnapshot } from '../lib/provider.js';
import { googleAccountStatus, googleCreditItems, readGoogleOverageSettings } from '../lib/google-billing.js';
import { readAntigravityCliCredential } from '../lib/antigravity-auth.js';
import { ANTIGRAVITY_LOCAL_OPTS, createAntigravityUsageScanner } from '../lib/antigravity-local.js';

const CLOUD_CODE_BASES = [
  'https://cloudcode-pa.googleapis.com/v1internal:',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:',
];
const QUOTA_USER_AGENT = 'antigravity/cli/1.5.0';
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';
// Antigravity's public "installed application" OAuth client (same values in
// every install; used only to redeem the refresh token from agy's keyring
// or the IDE state DB).
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
    const tempDir = await mkdtemp(join(tmpdir(), 'tokensleft-antigravity-'));
    const copyPath = join(tempDir, 'state.vscdb');

    try {
      if (platform() !== 'win32') {
        await chmod(tempDir, 0o700);
      }

      await writeFile(copyPath, await readFile(dbPath), { flag: 'wx', mode: 0o600 });

      if (platform() !== 'win32') {
        await chmod(copyPath, 0o600);
      }

      return query(copyPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

const REFRESH_CACHE_PATH = configPath('antigravity-auth.json');

async function loadCachedToken(credentialHash) {
  const cached = parseJson(await readFile(REFRESH_CACHE_PATH, 'utf8').catch(() => ''));

  if (cached?.credentialHash === credentialHash && cached?.accessToken && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  return null;
}

async function cacheToken(accessToken, expiresInSeconds, credentialHash) {
  const dir = configPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  if (platform() !== 'win32') {
    await chmod(dir, 0o700);
  }

  await writeFileAtomic(REFRESH_CACHE_PATH, JSON.stringify({
    accessToken,
    credentialHash,
    expiresAtMs: Date.now() + (expiresInSeconds || 3600) * 1000,
  }), { mode: 0o600, preserveMode: false });
}

// The state DB is owned by Antigravity and its envelope is write-hostile, so
// refreshed tokens are cached in ~/.tokensleft instead of being written back.
async function refreshAccessToken(refreshToken, credentialHash) {
  const response = await postTokenRefresh(TOKEN_REFRESH_URL, {
    form: {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
  });

  if (response.failure) {
    return null;
  }

  const { body } = response;

  if (response.status === 400 || response.status === 401) {
    const code = oauthErrorCode(body) || response.status;
    throw new ReloginRequiredError(`token refresh rejected (${code}) — sign in to Antigravity again`, { code: String(code) });
  }

  if (!response.ok || !body?.access_token) {
    return null;
  }

  await cacheToken(body.access_token, body.expires_in, credentialHash);
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

  if (normalized.includes('claude')) return 'Claude';
  return displayName;
}

export function buildAntigravityItems(data, { prefix = 'antigravity', now = Date.now(), account = null } = {}) {
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
    if (model.isAvailable === false || model.disabled === true) continue;
    // A catalog entry with a default full quota is not proof that a free
    // account can use paid third-party models.
    if (account?.free && !displayName.toLowerCase().includes('gemini')) continue;

    const fraction = model.quotaInfo?.remainingFraction;

    if (!Number.isFinite(fraction)) {
      continue;
    }

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
      periodMs: account ? null : QUOTA_PERIOD_MS,
      now,
    }));
}

// Unlike fetchAvailableModels, this API reports every quota window, including
// weekly limits shared by multiple models. Keep each server bucket separate.
export function buildAntigravityQuotaItems(data, { prefix = 'antigravity', now = Date.now(), account = null } = {}) {
  const items = [];
  for (const group of Array.isArray(data?.groups) ? data.groups : []) {
    if (!group || typeof group.displayName !== 'string' || !Array.isArray(group.buckets)) continue;
    const name = group.displayName.trim();
    if (!name || (account?.free && !/gemini/i.test(name))) continue;
    const label = /^gemini models$/i.test(name) ? 'Gemini' : /claude.*gpt/i.test(name) ? 'Claude/GPT' : name;
    const order = { '5h': 0, weekly: 1 };
    const buckets = [...group.buckets].sort((a, b) => (order[a?.window] ?? 2) - (order[b?.window] ?? 2));
    for (const bucket of buckets) {
      if (!bucket || !Number.isFinite(bucket.remainingFraction) || typeof bucket.window !== 'string' || !bucket.window) continue;
      const duration = bucket.window === '5h' ? QUOTA_PERIOD_MS : bucket.window === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : null;
      items.push(buildUsageItem({
        key: `${prefix}:${bucket.bucketId || `${name}:${bucket.window}`}`,
        label: `${label} ${bucket.window}`,
        percent: (1 - Math.max(0, Math.min(1, bucket.remainingFraction))) * 100,
        resetAt: toDate(bucket.resetTime),
        periodMs: duration,
        now,
      }));
    }
  }
  return items;
}

async function fetchAntigravityQuota(token) {
  let failure = { data: null };
  for (const base of CLOUD_CODE_BASES) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': QUOTA_USER_AGENT };

    try {
      const accountResponse = await fetch(`${base}loadCodeAssist`, {
        method: 'POST', headers,
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        signal: AbortSignal.timeout(15000),
      });
      if (accountResponse.status === 401) return { authFailed: true };
      if (!accountResponse.ok) {
        failure = { data: null, status: accountResponse.status };
        continue;
      }
      const accountData = parseJson(await accountResponse.text());
      if (googleAccountStatus(accountData).blocked) return { data: {}, accountData };
      const projectValue = accountData?.cloudaicompanionProject;
      const project = typeof projectValue === 'string' ? projectValue : projectValue?.id;
      if (!project || typeof project !== 'string') {
        failure = { data: null, status: 'NOQUOTA', error: 'Google did not report a quota project for this account.' };
        continue;
      }
      // Omitting the account's project makes this endpoint report a misleading
      // enterprise-license error, even for a valid personal Ultra account.
      const response = await fetch(`${base}retrieveUserQuotaSummary`, {
        method: 'POST', headers, body: JSON.stringify({ project }), signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401) return { authFailed: true };
      if (response.ok) {
        const data = parseJson(await response.text());
        if (data && Array.isArray(data.groups)) return { data, accountData };
        failure = { data: null, status: 'NOQUOTA', error: 'Google returned no quota summary for this account.' };
      } else {
        failure = { data: null, status: response.status };
      }
    } catch {
      continue;
    }
  }

  return failure;
}

// --- provider -----------------------------------------------------------------------

export async function createAntigravityProvider(env, { readCliCredential = readAntigravityCliCredential } = {}) {
  const dbPath = antigravityStateDbPath(env);
  const cliHome = env.ANTIGRAVITY_CLI_HOME || join(homedir(), '.gemini', 'antigravity-cli');
  const authSource = env.ANTIGRAVITY_AUTH_SOURCE || (env.ANTIGRAVITY_STATE_DB ? 'ide' : 'auto');
  if (!['auto', 'cli', 'ide'].includes(authSource)) {
    throw new Error('ANTIGRAVITY_AUTH_SOURCE must be auto, cli, or ide.');
  }
  let useCli = authSource === 'cli';
  if (authSource === 'auto' && await access(cliHome).then(() => true, () => false)) {
    // A locked or inaccessible CLI keyring must surface as an error, rather
    // than silently selecting an unrelated account in an old IDE database.
    try { useCli = !!await readCliCredential(); } catch { useCli = true; }
  }
  if (!useCli && !await access(dbPath).then(() => true, () => false)) {
    return null;
  }

  const readOnly = readOnlyMode(env);
  const scanner = useCli ? createAntigravityUsageScanner(cliHome) : null;

  const provider = createSingleAccountProvider({
    id: 'antigravity',
    title: useCli ? 'Antigravity CLI' : 'Antigravity',
    refreshMs: readRefreshMs(env, ['ANTIGRAVITY_REFRESH_SECONDS', 'ANTIGRAVITY_REFRESH_SEC'], DEFAULT_REFRESH_MS),
    localOpts: ANTIGRAVITY_LOCAL_OPTS,

    async fetch() {
      const startedAt = Date.now();
      let tokens;

      try {
        if (useCli) {
          tokens = await readCliCredential();
        } else {
          const value = await readStateDbValue(dbPath);
          tokens = value ? unwrapOAuthEnvelope(value) : null;
        }
      } catch (error) {
        return errorSnapshot(useCli ? 'CRED' : 'DB', useCli ? error.message : `cannot read Antigravity state: ${error.message}`, startedAt);
      }

      if (!tokens) {
        return errorSnapshot('CRED', useCli ? 'No agy CLI keyring session found. Run agy and sign in first.' : 'No Antigravity OAuth state found. Start Antigravity and sign in first.', startedAt);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const candidates = [];

      if (tokens.accessToken && (!tokens.expirySeconds || tokens.expirySeconds > nowSec)) {
        candidates.push(tokens.accessToken);
      }

      const credentialHash = createHash('sha256').update(tokens.refreshToken || tokens.accessToken).digest('hex');
      const cached = await loadCachedToken(credentialHash);

      if (cached && !candidates.includes(cached)) {
        candidates.push(cached);
      }

      if (readOnly && candidates.length === 0) {
        return errorSnapshot('EXPIRED', 'Antigravity OAuth token expired or unavailable in read-only mode. Sign in to Antigravity again.', startedAt);
      }

      try {
        let result = { data: null };
        let sawAuthFailure = false;

        for (const candidate of candidates) {
          result = await fetchAntigravityQuota(candidate);

          if (result.data) {
            break;
          }

          if (result.authFailed) {
            sawAuthFailure = true;
          }
        }

        // Refresh only on evidence of auth failure (or no usable token) so a
        // Cloud Code outage doesn't burn a refresh grant every probe.
        if (!result.data && readOnly && sawAuthFailure) {
          return errorSnapshot('EXPIRED', 'Antigravity OAuth token was rejected in read-only mode. Sign in to Antigravity again.', startedAt);
        }

        if (!result.data && !readOnly && tokens.refreshToken && (sawAuthFailure || candidates.length === 0)) {
          const refreshed = await refreshAccessToken(tokens.refreshToken, credentialHash);

          if (refreshed) {
            result = await fetchAntigravityQuota(refreshed);
          }
        }

        if (!result.data) {
          return result.authFailed
            ? errorSnapshot(401, 'Antigravity session expired. Start Antigravity and sign in again.', startedAt)
            : errorSnapshot(result.status || 'ERR', result.error || 'Cloud Code quota request failed. Try again later.', startedAt);
        }

        const accountData = result.accountData;
        const account = googleAccountStatus(accountData);
        if (account.blocked) return errorSnapshot('INELIGIBLE', `Antigravity access requires attention: ${account.reason}`, startedAt, { plan: account.plan });
        const items = buildAntigravityQuotaItems(result.data, { account });

        if (items.length === 0) {
          return errorSnapshot('NOQUOTA', `No eligible model quota reported for ${account.plan}.`, startedAt, { plan: account.plan });
        }

        const settingsPath = env.ANTIGRAVITY_SETTINGS_PATH || (useCli ? join(cliHome, 'settings.json') : join(dirname(dirname(dbPath)), 'settings.json'));
        let strategy = 'unknown';
        if (useCli && !env.ANTIGRAVITY_SETTINGS_PATH) {
          strategy = await readGoogleOverageSettings(join(dirname(cliHome), 'config', 'config.json'), { antigravity: true });
        }
        if (strategy === 'unknown') strategy = await readGoogleOverageSettings(settingsPath, { antigravity: true });
        items.push(...googleCreditItems(accountData, { prefix: 'antigravity', strategy })
          .filter((item) => !['unknown', 'unavailable'].includes(item.value)));
        items.push({ kind: 'info', key: 'antigravity:credentials', label: 'Credentials', value: useCli ? 'agy CLI (system keyring)' : 'Antigravity IDE (state DB)', detailOnly: true });
        return { ok: true, ms: Date.now() - startedAt, plan: account.plan, planId: account.id, planMultiplier: account.multiplier, items };
      } catch (error) {
        if (isReloginRequired(error)) {
          return errorSnapshot('EXPIRED', error.message, startedAt);
        }

        return errorSnapshot('ERR', `request failed: ${error.message}`, startedAt);
      }
    },
  });
  if (scanner) {
    const fetchQuota = provider.fetch;
    provider.fetch = async () => {
      const [snapshot, local] = await Promise.all([fetchQuota(), scanner.scan()]);
      return { ...snapshot, local };
    };
  }
  return provider;
}

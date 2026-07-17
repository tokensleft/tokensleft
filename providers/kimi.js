import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readRefreshMs, splitCsv } from '../lib/env.js';
import { buildUsageItem } from '../lib/forecast.js';
import { writeFileAtomic } from '../lib/fsx.js';
import { escapeBlessed, formatNumber } from '../lib/format.js';
import { parseJson } from '../lib/http.js';
import { COLOR } from '../lib/palette.js';
import { formatUsageItem, formatUsageItemCompact } from '../lib/render.js';

export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
export const DEFAULT_KIMI_OAUTH_HOST = 'https://auth.kimi.com';
export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const MODEL_CACHE_MS = 60 * 60 * 1000;
const MODEL_REQUEST_TIMEOUT_MS = 8_000;
const MIN_TOKEN_REFRESH_SECONDS = 5 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);
const FIXED_POINT_CENTS = 1_000_000;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOnlyMode(env) {
  return /^(1|true|yes)$/i.test(env.TOKENSLEFT_READ_ONLY || '');
}

export function kimiCredentialPaths(env = {}, home = homedir()) {
  const explicitPath = cleanEnvValue(env.KIMI_AUTH_PATH);

  if (explicitPath) {
    return [explicitPath];
  }

  const currentHome = cleanEnvValue(env.KIMI_CODE_HOME);

  if (currentHome) {
    return [join(currentHome, 'credentials', 'kimi-code.json')];
  }

  return [
    join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
    join(home, '.kimi', 'credentials', 'kimi-code.json'),
  ];
}

async function readOAuthCredential(path) {
  const raw = await readFile(path, 'utf8').catch(() => '');
  const credentials = parseJson(raw);

  if (!isRecord(credentials)) {
    return null;
  }

  const accessToken = cleanEnvValue(credentials.access_token);
  const refreshToken = cleanEnvValue(credentials.refresh_token);

  if (!accessToken && !refreshToken) {
    return null;
  }

  return { kind: 'oauth', path, raw, credentials };
}

function addKimiDisplayNames(accounts) {
  const multiple = accounts.length > 1;

  return accounts.map((account, index) => ({
    ...account,
    name: account.name || (multiple ? `Account ${index + 1}` : ''),
  }));
}

export function readKimiKeyAccounts(env = {}) {
  const accounts = [];

  // Kimi Code membership keys use the managed kimi.com endpoint. Keep these
  // distinct from KIMI_API_KEY, which belongs to the Moonshot Open Platform.
  for (let index = 1; ; index += 1) {
    const source = `KIMI_CODE_API_KEY_${index}`;
    const token = cleanEnvValue(env[source]);

    if (!token) {
      break;
    }

    accounts.push({
      id: `key_${index}`,
      name: cleanEnvValue(env[`KIMI_CODE_NAME_${index}`]),
      credential: { kind: 'api-key', token, source },
    });
  }

  if (accounts.length > 0) {
    return addKimiDisplayNames(accounts);
  }

  const singleKey = cleanEnvValue(env.KIMI_CODE_API_KEY);

  if (singleKey) {
    return [{
      id: 'key_1',
      name: cleanEnvValue(env.KIMI_CODE_NAME),
      credential: { kind: 'api-key', token: singleKey, source: 'KIMI_CODE_API_KEY' },
    }];
  }

  const csvAccounts = splitCsv(env.KIMI_CODE_API_KEYS || '')
    .filter(Boolean)
    .map((token, index) => ({
      id: `key_${index + 1}`,
      name: '',
      credential: { kind: 'api-key', token, source: 'KIMI_CODE_API_KEYS' },
    }));
  return addKimiDisplayNames(csvAccounts);
}

export async function readKimiAccounts(env = {}) {
  const keyAccounts = readKimiKeyAccounts(env);

  if (keyAccounts.length > 0) {
    return keyAccounts;
  }

  for (const path of kimiCredentialPaths(env)) {
    const credential = await readOAuthCredential(path);

    if (credential) {
      return [{
        id: 'cli',
        name: cleanEnvValue(env.KIMI_CODE_NAME),
        credential,
      }];
    }
  }

  return [];
}

export async function findKimiCredential(env = {}) {
  const accounts = await readKimiAccounts(env);
  return accounts[0]?.credential || null;
}

function expirySeconds(credentials) {
  const value = Number(credentials?.expires_at);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function kimiTokenExpired(credentials, now = Date.now()) {
  if (!cleanEnvValue(credentials?.access_token)) {
    return true;
  }

  const expiresAt = expirySeconds(credentials);
  return expiresAt !== null && expiresAt <= now / 1000;
}

export function kimiTokenNeedsRefresh(credentials, now = Date.now()) {
  if (!cleanEnvValue(credentials?.access_token)) {
    return true;
  }

  const expiresAt = expirySeconds(credentials);

  if (expiresAt === null) {
    return false;
  }

  const expiresIn = Number(credentials.expires_in);
  const threshold = Number.isFinite(expiresIn) && expiresIn > 0
    ? Math.max(MIN_TOKEN_REFRESH_SECONDS, expiresIn * 0.5)
    : MIN_TOKEN_REFRESH_SECONDS;
  return expiresAt - now / 1000 < threshold;
}

function apiErrorMessage(data, fallback) {
  const candidates = [
    data?.message,
    data?.error_description,
    data?.detail,
    data?.error?.message,
    typeof data?.error === 'string' ? data.error : '',
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim().slice(0, 300) : fallback;
}

class KimiRefreshError extends Error {
  constructor(message, { unauthorized = false } = {}) {
    super(message);
    this.name = 'KimiRefreshError';
    this.unauthorized = unauthorized;
  }
}

async function recoverRotatedCredential(credential) {
  const latest = await readOAuthCredential(credential.path);

  if (
    latest
    && cleanEnvValue(latest.credentials.access_token)
    && cleanEnvValue(latest.credentials.refresh_token) !== cleanEnvValue(credential.credentials.refresh_token)
  ) {
    return latest;
  }

  return null;
}

// Kimi Code rotates refresh tokens. The compare-before-replace write prevents
// TokensLeft from overwriting a newer token written by Kimi or another process.
export async function refreshKimiCredential(credential, env = {}, {
  now = Date.now,
  sleep = delay,
} = {}) {
  if (credential?.kind !== 'oauth') {
    throw new KimiRefreshError('Kimi Code OAuth credentials are unavailable.', { unauthorized: true });
  }

  const refreshToken = cleanEnvValue(credential.credentials.refresh_token);

  if (!refreshToken) {
    throw new KimiRefreshError('Kimi Code session cannot be refreshed. Run `kimi` and /login again.', { unauthorized: true });
  }

  const oauthHost = (
    cleanEnvValue(env.KIMI_CODE_OAUTH_HOST)
    || cleanEnvValue(env.KIMI_OAUTH_HOST)
    || DEFAULT_KIMI_OAUTH_HOST
  ).replace(/\/+$/, '');
  const url = `${oauthHost}/api/oauth/token`;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: KIMI_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new KimiRefreshError(`Kimi Code token refresh failed: ${error?.message || String(error)}`);

      if (attempt < 2) {
        await sleep(2 ** attempt * 1000);
        continue;
      }

      throw lastError;
    }

    const text = await response.text();
    const data = parseJson(text) || {};
    const errorCode = typeof data.error === 'string' ? data.error : '';

    if (response.status === 401 || response.status === 403 || errorCode === 'invalid_grant') {
      const rotated = await recoverRotatedCredential(credential);

      if (rotated) {
        return rotated;
      }

      throw new KimiRefreshError('Kimi Code session expired. Run `kimi` and /login again.', { unauthorized: true });
    }

    if (response.ok) {
      const accessToken = cleanEnvValue(data.access_token);
      const nextRefreshToken = cleanEnvValue(data.refresh_token);
      const expiresIn = Number(data.expires_in);

      if (!accessToken || !nextRefreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new KimiRefreshError('Kimi Code token refresh returned an invalid response.');
      }

      const credentials = {
        ...credential.credentials,
        access_token: accessToken,
        refresh_token: nextRefreshToken,
        expires_at: Math.floor(now() / 1000) + expiresIn,
        scope: typeof data.scope === 'string' ? data.scope : '',
        token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
        expires_in: expiresIn,
      };
      const serialized = `${JSON.stringify(credentials, null, 2)}\n`;

      try {
        await writeFileAtomic(credential.path, serialized, { expectedContent: credential.raw });
      } catch (error) {
        if (error?.code === 'EATOMICCONFLICT') {
          const rotated = await recoverRotatedCredential(credential);

          if (rotated) {
            return rotated;
          }
        }

        throw new KimiRefreshError(`Kimi Code token refreshed but could not safely update credentials: ${error.message}`);
      }

      return { kind: 'oauth', path: credential.path, raw: serialized, credentials };
    }

    const message = apiErrorMessage(data, `Kimi Code token refresh failed (HTTP ${response.status}).`);
    lastError = new KimiRefreshError(message);

    if (RETRYABLE_REFRESH_STATUSES.has(response.status) && attempt < 2) {
      await sleep(2 ** attempt * 1000);
      continue;
    }

    throw lastError;
  }

  throw lastError || new KimiRefreshError('Kimi Code token refresh failed.');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateFromAbsolute(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const number = Number(value);
    const milliseconds = number > 10_000_000_000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string' && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function resetAtFrom(sources, now) {
  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }

    for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
      const date = dateFromAbsolute(source[key]);

      if (date) {
        return date;
      }
    }
  }

  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }

    for (const key of ['reset_in', 'resetIn', 'reset_after_seconds', 'resetAfterSeconds', 'ttl', 'window']) {
      if (key === 'window' && isRecord(source[key])) {
        continue;
      }

      const seconds = finiteNumber(source[key]);

      if (seconds !== null && seconds > 0) {
        return new Date(now + seconds * 1000);
      }
    }
  }

  return null;
}

function durationMilliseconds(durationValue, unitValue) {
  const duration = finiteNumber(durationValue);

  if (duration === null || duration <= 0) {
    return null;
  }

  const unit = String(unitValue || '').toUpperCase();

  if (unit.includes('MINUTE')) {
    return duration * 60 * 1000;
  }

  if (unit.includes('HOUR')) {
    return duration * 60 * 60 * 1000;
  }

  if (unit.includes('DAY')) {
    return duration * 24 * 60 * 60 * 1000;
  }

  return duration * 1000;
}

function periodFromLabel(label) {
  const text = String(label || '').toLowerCase();
  const amount = Number(text.match(/(\d+(?:\.\d+)?)\s*([mhdw])\b/)?.[1]);
  const unit = text.match(/(\d+(?:\.\d+)?)\s*([mhdw])\b/)?.[2];

  if (Number.isFinite(amount) && amount > 0) {
    const multiplier = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return amount * multiplier;
  }

  if (text.includes('weekly') || text.includes('week')) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (text.includes('daily') || text.includes('day')) {
    return 24 * 60 * 60 * 1000;
  }

  if (text.includes('monthly') || text.includes('month')) {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return null;
}

function periodMsFrom(item, detail, window, label) {
  const directSeconds = finiteNumber(
    detail.limit_window_seconds
    ?? item.limit_window_seconds
    ?? window.limit_window_seconds
    ?? detail.window_seconds
    ?? item.window_seconds,
  );

  if (directSeconds !== null && directSeconds > 0) {
    return directSeconds * 1000;
  }

  return durationMilliseconds(
    window.duration ?? item.duration ?? detail.duration,
    window.timeUnit ?? window.time_unit ?? item.timeUnit ?? item.time_unit ?? detail.timeUnit ?? detail.time_unit,
  ) || periodFromLabel(label);
}

function limitLabel(item, detail, window, index) {
  for (const key of ['name', 'title', 'scope']) {
    const value = item[key] ?? detail[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const periodMs = durationMilliseconds(
    window.duration ?? item.duration ?? detail.duration,
    window.timeUnit ?? window.time_unit ?? item.timeUnit ?? item.time_unit ?? detail.timeUnit ?? detail.time_unit,
  );

  if (periodMs !== null) {
    const minutes = periodMs / 60_000;

    if (minutes >= 60 && minutes % 60 === 0) {
      return `${minutes / 60}h limit`;
    }

    return `${minutes}m limit`;
  }

  return `Limit #${index + 1}`;
}

function quotaRow(raw, label, sources, periodMs, now) {
  if (!isRecord(raw)) {
    return null;
  }

  const limit = finiteNumber(raw.limit);
  let used = finiteNumber(raw.used);

  if (used === null && limit !== null) {
    const remaining = finiteNumber(raw.remaining);

    if (remaining !== null) {
      used = limit - remaining;
    }
  }

  if (used === null && limit === null) {
    return null;
  }

  return {
    label: typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : label,
    used: used ?? 0,
    limit: limit ?? 0,
    resetAt: resetAtFrom(sources, now),
    periodMs,
  };
}

function fixedPointToCents(value) {
  const cents = value / FIXED_POINT_CENTS;
  return cents > 0 && cents < 1 ? 1 : Math.round(cents);
}

function money(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const cents = finiteNumber(raw.priceInCents);

  if (cents === null) {
    return null;
  }

  return { cents: Math.trunc(cents), currency: typeof raw.currency === 'string' ? raw.currency : '' };
}

function boosterWallet(raw) {
  if (!isRecord(raw) || !isRecord(raw.balance) || raw.balance.type !== 'BOOSTER') {
    return null;
  }

  const amount = finiteNumber(raw.balance.amount);

  if (amount === null || amount <= 0) {
    return null;
  }

  const amountLeft = finiteNumber(raw.balance.amountLeft);
  const monthlyLimit = money(raw.monthlyChargeLimit);
  const monthlyUsed = money(raw.monthlyUsed);
  const currency = monthlyLimit?.currency || monthlyUsed?.currency || 'USD';

  return {
    balanceCents: amountLeft === null ? 0 : fixedPointToCents(amountLeft),
    totalCents: fixedPointToCents(amount),
    monthlyChargeLimitEnabled: raw.monthlyChargeLimitEnabled === true,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency,
  };
}

function enumLabel(value, prefix) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  return withoutPrefix
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part === 'api' ? 'API' : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function membershipInfo(payload) {
  const membership = isRecord(payload.user) && isRecord(payload.user.membership)
    ? payload.user.membership
    : null;
  // Kimi's API still calls the public Allegretto tier LEVEL_INTERMEDIATE.
  const level = membership?.level === 'LEVEL_INTERMEDIATE'
    ? 'Allegretto'
    : enumLabel(membership?.level, 'LEVEL_');
  const type = enumLabel(payload.subType, 'TYPE_');

  if (!level && !type) {
    return null;
  }

  return { level, type, paid: payload.subType === 'TYPE_PURCHASE' };
}

function sharedQuotaInfo(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const limit = finiteNumber(raw.limit);
  const remaining = finiteNumber(raw.remaining);

  if (limit === null || limit <= 0 || remaining === null) {
    return null;
  }

  return { limit, remaining: Math.max(0, Math.min(limit, remaining)) };
}

function parallelInfo(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const limit = finiteNumber(raw.limit);
  const active = Array.isArray(raw.details) ? raw.details.length : null;

  if ((limit === null || limit <= 0) && active === null) {
    return null;
  }

  return { limit: limit !== null && limit > 0 ? limit : null, active };
}

function authenticationInfo(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const method = enumLabel(raw.method, 'METHOD_');
  const scope = enumLabel(raw.scope, 'FEATURE_');
  return method || scope ? { method, scope } : null;
}

export function parseKimiUsagePayload(payload, { now = Date.now() } = {}) {
  if (!isRecord(payload)) {
    return {
      summary: null,
      limits: [],
      extraUsage: null,
      membership: null,
      sharedQuota: null,
      parallel: null,
      authentication: null,
    };
  }

  const summaryRaw = isRecord(payload.usage) ? payload.usage : null;
  const summaryLabel = typeof summaryRaw?.name === 'string' && summaryRaw.name.trim()
    ? summaryRaw.name.trim()
    : 'Weekly limit';
  const summary = quotaRow(
    summaryRaw,
    summaryLabel,
    [summaryRaw],
    periodFromLabel(summaryLabel),
    now,
  );
  const limits = [];

  if (Array.isArray(payload.limits)) {
    for (let index = 0; index < payload.limits.length; index += 1) {
      const item = isRecord(payload.limits[index]) ? payload.limits[index] : null;

      if (!item) {
        continue;
      }

      const detail = isRecord(item.detail) ? item.detail : item;
      const window = isRecord(item.window) ? item.window : {};
      const label = limitLabel(item, detail, window, index);
      const row = quotaRow(detail, label, [detail, item, window], periodMsFrom(item, detail, window, label), now);

      if (row) {
        limits.push(row);
      }
    }
  }

  return {
    summary,
    limits,
    extraUsage: boosterWallet(payload.boosterWallet),
    membership: membershipInfo(payload),
    sharedQuota: sharedQuotaInfo(payload.totalQuota),
    parallel: parallelInfo(payload.parallel),
    authentication: authenticationInfo(payload.authentication),
  };
}

function keyPart(label, fallback) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function formatMoney(cents, currency) {
  const amount = (Math.max(0, cents) / 100).toFixed(2);
  const upper = String(currency || 'USD').toUpperCase();

  if (upper === 'USD') {
    return `$${amount}`;
  }

  if (upper === 'CNY') {
    return `¥${amount}`;
  }

  return `${amount} ${upper}`;
}

export function parseKimiModelsPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const models = payload.data.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
      return [];
    }

    const contextLength = finiteNumber(raw.context_length);
    const displayName = typeof raw.display_name === 'string' && raw.display_name.trim()
      ? raw.display_name.trim().replace(/Highspeed/gi, 'HighSpeed')
      : raw.id.trim();

    return [{
      id: raw.id.trim(),
      displayName,
      contextLength: contextLength !== null && contextLength > 0 ? contextLength : null,
      supportsThinking: raw.supports_thinking_type !== 'no' && (
        raw.supports_reasoning === true || typeof raw.supports_thinking_type === 'string'
      ),
      supportsImage: raw.supports_image_in === true,
      supportsVideo: raw.supports_video_in === true,
      supportsTools: raw.supports_tool_use !== false,
    }];
  });

  const priority = (model) => model.id === 'k3' ? 0 : /highspeed/i.test(model.id) ? 2 : 1;
  return models.sort((left, right) => priority(left) - priority(right));
}

function formatContextLength(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  if (value >= 1_048_576 && value % 1_048_576 === 0) {
    return `${value / 1_048_576}M`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)}K`;
  }

  return formatNumber(value);
}

function modelInfoItem(models, prefix) {
  if (!Array.isArray(models) || models.length === 0) {
    return null;
  }

  const summary = models.map((model) => [model.displayName, formatContextLength(model.contextLength)]
    .filter(Boolean)
    .join(' '));
  const details = models.map((model) => {
    const capabilities = [
      model.supportsThinking ? 'thinking' : '',
      model.supportsImage ? 'image' : '',
      model.supportsVideo ? 'video' : '',
      model.supportsTools ? 'tools' : '',
    ].filter(Boolean);
    const meta = [
      formatContextLength(model.contextLength) ? `${formatContextLength(model.contextLength)} context` : '',
      ...capabilities,
    ].filter(Boolean).join(' | ');
    return meta ? `${model.displayName}: ${meta}` : model.displayName;
  });

  return {
    kind: 'info',
    key: `${prefix}:models`,
    label: 'Models',
    value: summary.join(' | '),
    details,
    detailOnly: true,
  };
}

export function buildKimiItems(payload, { prefix = 'kimi', now = Date.now(), models = [] } = {}) {
  const parsed = parseKimiUsagePayload(payload, { now });
  const rows = [
    ...(parsed.summary ? [{ row: parsed.summary, key: `${prefix}:summary` }] : []),
    ...parsed.limits.map((row, index) => ({
      row,
      key: `${prefix}:limit:${keyPart(row.label, String(index + 1))}:${index + 1}`,
    })),
  ];
  const items = [];

  for (const { row, key } of rows) {
    if (!Number.isFinite(row.limit) || row.limit <= 0 || !Number.isFinite(row.used)) {
      continue;
    }

    const used = Math.max(0, row.used);
    const percent = Math.max(0, Math.min(100, (used / row.limit) * 100));
    items.push(buildUsageItem({
      key,
      label: row.label,
      value: `${Math.round(percent)}%`,
      percent,
      resetAt: row.resetAt,
      periodMs: row.periodMs,
      now,
    }));
  }

  if (parsed.sharedQuota) {
    items.push({
      kind: 'info',
      key: `${prefix}:shared-quota`,
      label: 'Shared quota',
      value: `${formatNumber(parsed.sharedQuota.remaining)}/${formatNumber(parsed.sharedQuota.limit)} left`,
      detailOnly: true,
    });
  }

  if (parsed.parallel) {
    const { active, limit } = parsed.parallel;
    const value = active !== null && limit !== null
      ? `${formatNumber(active)}/${formatNumber(limit)} active`
      : active !== null
        ? `${formatNumber(active)} active`
        : `${formatNumber(limit)} max`;
    items.push({
      kind: 'info',
      key: `${prefix}:parallel`,
      label: 'Parallel',
      value,
      detailOnly: true,
    });
  }

  if (parsed.extraUsage) {
    const extra = parsed.extraUsage;
    const spent = formatMoney(extra.monthlyUsedCents, extra.currency);
    const details = [
      `used this month ${spent}`,
      `monthly limit ${extra.monthlyChargeLimitEnabled && extra.monthlyChargeLimitCents > 0
        ? formatMoney(extra.monthlyChargeLimitCents, extra.currency)
        : 'Unlimited'}`,
      `original balance ${formatMoney(extra.totalCents, extra.currency)}`,
    ];
    items.push({
      kind: 'info',
      key: `${prefix}:extra-usage`,
      label: 'Extra Usage',
      value: `${formatMoney(extra.balanceCents, extra.currency)} left`,
      note: `${spent} used this month`,
      details,
    });
  }

  const modelsItem = modelInfoItem(models, prefix);

  if (modelsItem) {
    items.push(modelsItem);
  }

  return items;
}

function apiBaseUrl(env) {
  return (cleanEnvValue(env.KIMI_CODE_BASE_URL) || DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
}

function usageUrl(env) {
  return `${apiBaseUrl(env)}/usages`;
}

function modelsUrl(env) {
  return `${apiBaseUrl(env)}/models`;
}

function requestUsage(url, token) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function fetchKimiModels(url, token) {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      await response.arrayBuffer().catch(() => {});
      return null;
    }

    const data = parseJson(await response.text());
    return data ? parseKimiModelsPayload(data) : null;
  } catch {
    return null;
  }
}

function createKimiModelLoader(env) {
  const cache = new Map();

  return async (account, token) => {
    const key = `${account.id}:${modelsUrl(env)}`;
    const cached = cache.get(key);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.models;
    }

    const models = await fetchKimiModels(modelsUrl(env), token);

    if (models === null) {
      return cached?.models || [];
    }

    cache.set(key, { models, expiresAt: now + MODEL_CACHE_MS });
    return models;
  };
}

function errorSnapshot(status, error, startedAt, body = '') {
  return {
    ok: false,
    status,
    error,
    ms: Date.now() - startedAt,
    items: [],
    ...(body ? { body: body.slice(0, 300) } : {}),
  };
}

function decorateAccountSnapshot(account, snapshot) {
  return {
    name: account.name,
    source: account.credential.kind === 'api-key' ? account.credential.source : 'CLI login',
    ...snapshot,
  };
}

async function fetchKimiAccountUsage(account, env, readOnly, loadModels) {
  const startedAt = Date.now();
  let credential = account.credential;
  const finish = (snapshot) => decorateAccountSnapshot(account, snapshot);
  let token;

  if (credential.kind === 'api-key') {
    token = credential.token;
  } else {
    const expired = kimiTokenExpired(credential.credentials);

    if (readOnly && expired) {
      return finish(errorSnapshot('EXPIRED', 'Kimi Code OAuth token expired or unavailable in read-only mode. Run `kimi` and /login again.', startedAt));
    }

    if (!readOnly && kimiTokenNeedsRefresh(credential.credentials)) {
      try {
        credential = await refreshKimiCredential(credential, env);
      } catch (error) {
        if (error.unauthorized || expired) {
          return finish(errorSnapshot(error.unauthorized ? 'EXPIRED' : 'ERR', error.message, startedAt));
        }
        // A still-valid access token is preferable to hiding quota data
        // because a proactive refresh briefly failed.
      }
    }

    token = cleanEnvValue(credential.credentials.access_token);

    if (!token) {
      return finish(errorSnapshot('CRED', 'Kimi Code is not logged in. Run `kimi` and /login.', startedAt));
    }
  }

  let modelsToken = token;
  let modelsPromise = loadModels(account, token);
  let response;

  try {
    response = await requestUsage(usageUrl(env), token);

    if (!readOnly && credential.kind === 'oauth' && (response.status === 401 || response.status === 403)) {
      const latest = await readOAuthCredential(credential.path);

      // Kimi may have rotated the token in another process after this
      // refresh began. Try that newer access token before rotating again.
      if (latest && latest.raw !== credential.raw && cleanEnvValue(latest.credentials.access_token)) {
        await response.arrayBuffer().catch(() => {});
        credential = latest;
        token = cleanEnvValue(credential.credentials.access_token);
        response = await requestUsage(usageUrl(env), token);
      }

      if (response.status === 401 || response.status === 403) {
        await response.arrayBuffer().catch(() => {});
        credential = await refreshKimiCredential(credential, env);
        token = cleanEnvValue(credential.credentials.access_token);
        response = await requestUsage(usageUrl(env), token);
      }
    }
  } catch (error) {
    const message = error instanceof KimiRefreshError
      ? error.message
      : `request failed: ${error?.message || String(error)}`;
    return finish(errorSnapshot(error?.unauthorized ? 'EXPIRED' : 'ERR', message, startedAt));
  }

  const text = await response.text();
  const data = parseJson(text);

  if (response.status === 401 || response.status === 403) {
    const message = credential.kind === 'api-key'
      ? `Kimi Code API key is invalid or expired. Check ${credential.source}.`
      : 'Kimi Code session expired. Run `kimi` and /login again.';
    return finish(errorSnapshot(response.status, message, startedAt));
  }

  if (!response.ok) {
    const message = response.status === 404
      ? 'Kimi Code usage endpoint is unavailable for this account or endpoint.'
      : apiErrorMessage(data, `HTTP ${response.status}`);
    return finish(errorSnapshot(response.status, message, startedAt, text));
  }

  if (!data) {
    return finish(errorSnapshot('ERR', 'Kimi Code usage response was not valid JSON.', startedAt, text));
  }

  if (token !== modelsToken) {
    modelsToken = token;
    modelsPromise = loadModels(account, token);
  }

  const models = await modelsPromise;
  const parsed = parseKimiUsagePayload(data);
  const prefix = `kimi:${account.id}`;
  const items = buildKimiItems(data, { prefix, models });

  if (items.length === 0) {
    items.push({ kind: 'empty', key: `${prefix}:empty`, label: 'Plan usage', message: 'no usage data available' });
  }

  const fallbackAuth = credential.kind === 'api-key' ? 'API Key' : 'CLI login';
  return finish({
    ok: true,
    ms: Date.now() - startedAt,
    plan: parsed.membership?.level || (parsed.membership?.paid ? 'Paid' : ''),
    auth: parsed.authentication?.method || fallbackAuth,
    scope: parsed.authentication?.scope || '',
    items,
  });
}

function renderKimiAccountBlock(result, width, mode = 'detail') {
  const compact = mode === 'compact';
  const status = result.ok
    ? `{${COLOR.success}-fg}{bold}OK{/bold}{/${COLOR.success}-fg}`
    : `{${COLOR.danger}-fg}{bold}${escapeBlessed(String(result.status))}{/bold}{/${COLOR.danger}-fg}`;
  const fallbackAuth = result.source === 'CLI login' ? result.source : 'API Key';
  const metaParts = compact
    ? [result.plan]
    : [result.plan, result.auth || fallbackAuth, `${result.ms}ms`];
  const meta = metaParts.filter(Boolean).join(' | ');
  const metaText = meta ? `  {${COLOR.muted}-fg}${escapeBlessed(meta)}{/${COLOR.muted}-fg}` : '';
  const accountText = result.name
    ? `{${COLOR.accentSoft}-fg}{bold}${escapeBlessed(result.name)}{/bold}{/${COLOR.accentSoft}-fg}  `
    : '  ';
  const lines = [
    `${accountText}${status}${metaText}`,
  ];

  if (!result.ok) {
    lines.push(`  {${COLOR.danger}-fg}${escapeBlessed(result.error || 'unknown error')}{/${COLOR.danger}-fg}`);

    if (result.body && !compact) {
      lines.push(`  {${COLOR.muted}-fg}${escapeBlessed(result.body)}{/${COLOR.muted}-fg}`);
    }

    return lines.join('\n');
  }

  const itemFormatter = compact ? formatUsageItemCompact : formatUsageItem;
  const items = compact ? result.items.filter((item) => !item.detailOnly) : result.items;
  lines.push(...items.map((item) => itemFormatter(item, width)));
  return lines.join('\n');
}

export function renderKimiSnapshot(snapshot, width, mode = 'detail') {
  if (snapshot.fatal) {
    return `  {${COLOR.danger}-fg}${escapeBlessed(snapshot.fatal)}{/${COLOR.danger}-fg}`;
  }

  const joiner = mode === 'compact' ? '\n' : '\n\n';
  return snapshot.results.map((result) => renderKimiAccountBlock(result, width, mode)).join(joiner);
}

export async function createKimiProvider(env) {
  const detected = await readKimiAccounts(env);

  if (detected.length === 0) {
    return null;
  }

  const readOnly = readOnlyMode(env);
  const loadModels = createKimiModelLoader(env);

  return {
    id: 'kimi',
    title: 'Kimi Code',
    refreshMs: readRefreshMs(env, ['KIMI_REFRESH_SECONDS', 'KIMI_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const accounts = await readKimiAccounts(env);

      if (accounts.length === 0) {
        return { fatal: 'Kimi Code credentials disappeared. Run `kimi` and /login again.', results: [] };
      }

      const results = await Promise.all(accounts.map((account) => fetchKimiAccountUsage(
        account,
        env,
        readOnly,
        loadModels,
      )));
      return { results };
    },

    render(snapshot, width, mode = 'detail') {
      return renderKimiSnapshot(snapshot, width, mode);
    },

    headerStatus(snapshot) {
      if (snapshot.fatal) {
        return { ok: false, text: 'ERR' };
      }

      const okCount = snapshot.results.filter((result) => result.ok).length;
      return { ok: okCount === snapshot.results.length, text: `${okCount}/${snapshot.results.length} OK` };
    },

    alertItems(snapshot) {
      if (snapshot.fatal) {
        return [];
      }

      return snapshot.results.flatMap((result) => result.items
        .filter((item) => item.kind === 'usage')
        .map((item) => ({
          key: item.key,
          label: [result.name, item.label].filter(Boolean).join(' '),
          percent: item.percent,
          resetAt: item.resetAt,
        })));
    },
  };
}

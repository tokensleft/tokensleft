import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed } from '../lib/format.js';
import { formatUsageItem, formatUsageItemCompact } from '../lib/render.js';
import { parseJson } from '../lib/http.js';
import { writeFileAtomic } from '../lib/fsx.js';

// Codex CLI's public OAuth client (an "installed application" client — the
// same value every Codex install ships with). Used to redeem the refresh
// token already stored in auth.json.
const TOKEN_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const SESSION_PERIOD_MS = 5 * 60 * 60 * 1000;
const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

export async function findCodexAuthPath(env) {
  const candidates = env.CODEX_HOME
    ? [join(env.CODEX_HOME, 'auth.json')]
    : [join(homedir(), '.codex', 'auth.json'), join(homedir(), '.config', 'codex', 'auth.json')];

  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) {
      return candidate;
    }
  }

  return null;
}

async function loadAuth(authPath) {
  const raw = await readFile(authPath, 'utf8').catch((error) => {
    throw new Error(`cannot read ${authPath}: ${error.message}`);
  });
  const auth = parseJson(raw);

  if (!auth || (!auth.tokens?.access_token && !auth.OPENAI_API_KEY)) {
    throw new Error('no Codex tokens in auth.json — run `codex` to log in');
  }

  return auth;
}

function authNeedsRefresh(auth, now = Date.now()) {
  if (!auth.last_refresh) {
    return true;
  }

  const lastMs = Date.parse(auth.last_refresh);
  return !Number.isFinite(lastMs) || now - lastMs > REFRESH_AGE_MS;
}

// Returns the new access token, null on soft failure, throws a user-facing
// string when re-login is required.
async function refreshAuth(authPath, auth) {
  if (!auth.tokens?.refresh_token) {
    return null;
  }

  let response;

  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: auth.tokens.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }

  const body = parseJson(await response.text());

  if (response.status === 400 || response.status === 401) {
    const code = body?.error?.code || body?.error || body?.code || response.status;
    throw `token refresh rejected (${code}) — run \`codex\` to log in again`;
  }

  if (!response.ok || !body?.access_token) {
    return null;
  }

  auth.tokens.access_token = body.access_token;

  if (body.refresh_token) {
    auth.tokens.refresh_token = body.refresh_token;
  }

  if (body.id_token) {
    auth.tokens.id_token = body.id_token;
  }

  auth.last_refresh = new Date().toISOString();
  await writeFileAtomic(authPath, JSON.stringify(auth, null, 2)).catch(() => {});
  return auth.tokens.access_token;
}

function requestUsage(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'tokensleft',
  };

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  return fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(15000) });
}

function windowResetAt(window, nowSec) {
  if (!window) {
    return null;
  }

  if (typeof window.reset_at === 'number') {
    return toDate(window.reset_at * (window.reset_at > 10_000_000_000 ? 1 : 1000));
  }

  if (typeof window.reset_after_seconds === 'number') {
    return new Date((nowSec + window.reset_after_seconds) * 1000);
  }

  return null;
}

function windowPeriodMs(window, fallbackMs) {
  return typeof window?.limit_window_seconds === 'number' ? window.limit_window_seconds * 1000 : fallbackMs;
}

export function buildCodexItems(data, headers = {}, { prefix = 'codex', now = Date.now() } = {}) {
  const items = [];
  const nowSec = Math.floor(now / 1000);
  const rateLimit = data?.rate_limit || null;
  const primary = rateLimit?.primary_window || null;
  const secondary = rateLimit?.secondary_window || null;
  const headerPrimary = Number(headers['x-codex-primary-used-percent']);
  const headerSecondary = Number(headers['x-codex-secondary-used-percent']);
  const primaryPercent = Number.isFinite(headerPrimary)
    ? headerPrimary
    : typeof primary?.used_percent === 'number' ? primary.used_percent : null;
  const secondaryPercent = Number.isFinite(headerSecondary)
    ? headerSecondary
    : typeof secondary?.used_percent === 'number' ? secondary.used_percent : null;

  if (primaryPercent !== null) {
    items.push(buildUsageItem({
      key: `${prefix}:session`,
      label: 'Session',
      percent: primaryPercent,
      resetAt: windowResetAt(primary, nowSec),
      periodMs: windowPeriodMs(primary, SESSION_PERIOD_MS),
      now,
    }));
  }

  if (secondaryPercent !== null) {
    items.push(buildUsageItem({
      key: `${prefix}:weekly`,
      label: 'Weekly',
      percent: secondaryPercent,
      resetAt: windowResetAt(secondary, nowSec),
      periodMs: windowPeriodMs(secondary, WEEKLY_PERIOD_MS),
      now,
    }));
  }

  if (Array.isArray(data?.additional_rate_limits)) {
    for (const entry of data.additional_rate_limits) {
      if (!entry?.rate_limit) {
        continue;
      }

      const name = typeof entry.limit_name === 'string' ? entry.limit_name : '';
      const shortName = name.replace(/^GPT-[\d.]+-Codex-/, '') || name || 'Model';
      const extra = entry.rate_limit;

      if (typeof extra.primary_window?.used_percent === 'number') {
        items.push(buildUsageItem({
          key: `${prefix}:extra:${shortName}`,
          label: shortName,
          percent: extra.primary_window.used_percent,
          resetAt: windowResetAt(extra.primary_window, nowSec),
          periodMs: windowPeriodMs(extra.primary_window, SESSION_PERIOD_MS),
          now,
        }));
      }

      if (typeof extra.secondary_window?.used_percent === 'number') {
        items.push(buildUsageItem({
          key: `${prefix}:extra:${shortName}:weekly`,
          label: `${shortName} Wk`,
          percent: extra.secondary_window.used_percent,
          resetAt: windowResetAt(extra.secondary_window, nowSec),
          periodMs: windowPeriodMs(extra.secondary_window, WEEKLY_PERIOD_MS),
          now,
        }));
      }
    }
  }

  const review = data?.code_review_rate_limit?.primary_window;

  if (typeof review?.used_percent === 'number') {
    items.push(buildUsageItem({
      key: `${prefix}:reviews`,
      label: 'Reviews',
      percent: review.used_percent,
      resetAt: windowResetAt(review, nowSec),
      periodMs: windowPeriodMs(review, WEEKLY_PERIOD_MS),
      now,
    }));
  }

  const creditsBalance = Number(headers['x-codex-credits-balance'] ?? data?.credits?.balance);

  // 0 usually means "never bought credits" — a permanent 100% bar is noise.
  if (Number.isFinite(creditsBalance) && creditsBalance > 0) {
    const limit = 1000;
    const used = Math.max(0, Math.min(limit, limit - creditsBalance));

    items.push(buildUsageItem({
      key: `${prefix}:credits`,
      label: 'Credits',
      value: `${Math.round(creditsBalance)} left`,
      percent: (used / limit) * 100,
      periodMs: WEEKLY_PERIOD_MS,
      now,
    }));
  }

  return items;
}

export async function createCodexProvider(env) {
  const authPath = await findCodexAuthPath(env);

  if (!authPath) {
    return null;
  }

  return {
    id: 'codex',
    title: 'Codex',
    refreshMs: readRefreshMs(env, ['CODEX_REFRESH_SECONDS', 'CODEX_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();
      let auth;

      try {
        auth = await loadAuth(authPath);
      } catch (error) {
        return { ok: false, status: 'CRED', error: error.message, ms: Date.now() - startedAt, items: [] };
      }

      if (!auth.tokens?.access_token) {
        return { ok: false, status: 'APIKEY', error: 'Codex usage is not available for API-key auth. Run `codex` to log in with ChatGPT.', ms: Date.now() - startedAt, items: [] };
      }

      let token = auth.tokens.access_token;

      if (authNeedsRefresh(auth)) {
        try {
          token = (await refreshAuth(authPath, auth)) || token;
        } catch (message) {
          return { ok: false, status: 'EXPIRED', error: String(message), ms: Date.now() - startedAt, items: [] };
        }
      }

      let response;

      try {
        response = await requestUsage(token, auth.tokens.account_id);

        if (response.status === 401 || response.status === 403) {
          const refreshed = await refreshAuth(authPath, auth);

          if (refreshed) {
            token = refreshed;
            response = await requestUsage(token, auth.tokens.account_id);
          }
        }
      } catch (error) {
        const message = typeof error === 'string' ? error : `request failed: ${error.message}`;
        return { ok: false, status: typeof error === 'string' ? 'EXPIRED' : 'ERR', error: message, ms: Date.now() - startedAt, items: [] };
      }

      const text = await response.text();
      const ms = Date.now() - startedAt;

      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, error: 'Token expired. Run `codex` to log in again.', ms, items: [] };
      }

      const data = parseJson(text);

      if (!response.ok || !data) {
        return { ok: false, status: response.status, error: `HTTP ${response.status}`, body: text.slice(0, 300), ms, items: [] };
      }

      const headers = Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

      return {
        ok: true,
        ms,
        plan: data.plan_type || '',
        items: buildCodexItems(data, headers),
      };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'codex');
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

// Shared single-account renderer for providers without multi-key support.
export function renderSingleAccount(snapshot, width, mode, name) {
  if (snapshot.fatal) {
    return `  {red-fg}${escapeBlessed(snapshot.fatal)}{/red-fg}`;
  }

  const compact = mode === 'compact';
  const status = snapshot.ok
    ? '{green-fg}{bold}OK{/bold}{/green-fg}'
    : `{red-fg}{bold}${escapeBlessed(String(snapshot.status))}{/bold}{/red-fg}`;
  const meta = [snapshot.plan, compact ? '' : `${snapshot.ms}ms`].filter(Boolean).join(' · ');
  const lines = [
    `{cyan-fg}{bold}${escapeBlessed(name)}{/bold}{/cyan-fg}  ${status}  {white-fg}${escapeBlessed(meta)}{/white-fg}`,
  ];

  if (!snapshot.ok) {
    lines.push(`  {red-fg}${escapeBlessed(snapshot.error || 'unknown error')}{/red-fg}`);

    if (snapshot.body && !compact) {
      lines.push(`  {white-fg}${escapeBlessed(snapshot.body)}{/white-fg}`);
    }

    return lines.join('\n');
  }

  const itemFormatter = compact ? formatUsageItemCompact : formatUsageItem;
  lines.push(...snapshot.items.map((item) => itemFormatter(item, width)));
  return lines.join('\n');
}

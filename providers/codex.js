import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { formatCountdown } from '../lib/format.js';
import { createLocalUsageScanner, jsonlRefresher } from '../lib/local-usage.js';
import { parseJson } from '../lib/http.js';
import { renderSingleAccount } from '../lib/provider-render.js';
import { writeFileAtomic } from '../lib/fsx.js';

export { renderSingleAccount } from '../lib/provider-render.js';

// Codex CLI's public OAuth client (an "installed application" client — the
// same value every Codex install ships with). Used to redeem the refresh
// token already stored in auth.json.
const TOKEN_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// Sibling endpoint: /usage gives only the reset-credit count; the dated
// credits (each with an expires_at redemption deadline) live here.
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
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

  return { auth, raw };
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
async function refreshAuth(authPath, authState) {
  const { auth } = authState;

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
  const serialized = JSON.stringify(auth, null, 2);

  try {
    await writeFileAtomic(authPath, serialized, { expectedContent: authState.raw });
  } catch (error) {
    throw new Error(`OAuth token refreshed but could not safely update Codex credentials: ${error.message}`);
  }

  authState.raw = serialized;
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

function requestResetCredits(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'tokensleft',
  };

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  return fetch(RESET_CREDITS_URL, { headers, signal: AbortSignal.timeout(15000) });
}

// Redemption deadlines of still-available reset credits, soonest first — the
// "use it or lose it" dates. Ignores credits that never expire (expires_at
// null), already lapsed, or aren't available to redeem.
export function availableResetExpiries(creditsData, now = Date.now()) {
  const credits = Array.isArray(creditsData?.credits) ? creditsData.credits : [];
  const expiries = [];

  for (const credit of credits) {
    if (credit?.status !== 'available') {
      continue;
    }

    const ms = Date.parse(credit.expires_at ?? credit.expiresAt ?? '');

    if (Number.isFinite(ms) && ms > now) {
      expiries.push(ms);
    }
  }

  return expiries.sort((a, b) => a - b).map((ms) => new Date(ms));
}

export function soonestResetCreditExpiry(creditsData, now = Date.now()) {
  return availableResetExpiries(creditsData, now)[0] ?? null;
}

function shortDate(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
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

// Codex historically returned a 5h "primary" (session) window and a 7d
// "secondary" (weekly) window, so the two were labeled by position. It has
// since started returning a single window whose duration is the weekly one —
// labeling that by position mislabels a weekly limit as "Session". Name each
// window from its own limit_window_seconds instead, and only fall back to the
// positional default when the API omits the duration.
function windowMeta(window, fallback) {
  const seconds = Number(window?.limit_window_seconds);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return fallback;
  }

  const periodMs = seconds * 1000;
  const hours = seconds / 3600;

  if (hours <= 8) {
    return { key: 'session', label: 'Session', periodMs };
  }

  if (hours <= 48) {
    return { key: 'daily', label: 'Daily', periodMs };
  }

  if (hours <= 24 * 10) {
    return { key: 'weekly', label: 'Weekly', periodMs };
  }

  return { key: 'monthly', label: 'Monthly', periodMs };
}

export function buildCodexItems(data, headers = {}, { prefix = 'codex', now = Date.now(), resetCreditExpiries = [] } = {}) {
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
    const meta = windowMeta(primary, { key: 'session', label: 'Session', periodMs: SESSION_PERIOD_MS });
    items.push(buildUsageItem({
      key: `${prefix}:${meta.key}`,
      label: meta.label,
      percent: primaryPercent,
      resetAt: windowResetAt(primary, nowSec),
      periodMs: meta.periodMs,
      now,
    }));
  }

  if (secondaryPercent !== null) {
    const meta = windowMeta(secondary, { key: 'weekly', label: 'Weekly', periodMs: WEEKLY_PERIOD_MS });
    items.push(buildUsageItem({
      key: `${prefix}:${meta.key}`,
      label: meta.label,
      percent: secondaryPercent,
      resetAt: windowResetAt(secondary, nowSec),
      periodMs: meta.periodMs,
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

  // The API exposes a purchased balance but no stable cap. Without a real
  // denominator this is information, not a percentage-based quota.
  if (Number.isFinite(creditsBalance) && creditsBalance > 0) {
    items.push({
      kind: 'info',
      key: `${prefix}:credits`,
      label: 'Credits',
      value: `${Math.round(creditsBalance)} left`,
    });
  }

  // Early rate-limit resets Codex now grants: a bare count with no known cap,
  // so it's an info line rather than a bar. Redemption deadlines come from the
  // sibling reset-credits endpoint — compact shows the soonest, detail lists
  // each credit's expiry (`note`/`details` are info-only render hints).
  const resets = Number(data?.rate_limit_reset_credits?.available_count);

  if (Number.isFinite(resets)) {
    const expiries = (Array.isArray(resetCreditExpiries) ? resetCreditExpiries : [])
      .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()) && date.getTime() > now)
      .sort((a, b) => a.getTime() - b.getTime());
    const item = {
      kind: 'info',
      key: `${prefix}:resets`,
      label: 'Resets',
      value: `${resets} available`,
    };

    if (resets > 0 && expiries.length > 0) {
      item.expiresAt = expiries[0];
      item.note = `next expires ${formatCountdown(expiries[0]).replace(/^in /, '')}`;
      item.details = expiries.map((date) => `expires ${formatCountdown(date).replace(/^in /, '')} (${shortDate(date)})`);
    }

    items.push(item);
  }

  return items;
}

// --- local session-log aggregation ------------------------------------------------

// USD per 1M tokens. Codex rollouts don't record prices, so cost is estimated
// from public API rates: uncached input + cached input (90% off, except
// codex-mini at 75% off) + output (reasoning is billed inside output).
// Pro models don't support prompt caching, so their cached rate is inert.
export const MODEL_PRICING = [
  { match: /^gpt-5\.6-sol/, input: 5, cachedInput: 0.5, output: 30 },
  { match: /^gpt-5\.6-terra/, input: 2.5, cachedInput: 0.25, output: 15 },
  { match: /^gpt-5\.6-luna/, input: 1, cachedInput: 0.1, output: 6 },
  { match: /^gpt-5\.5-pro/, input: 30, cachedInput: 30, output: 180 },
  { match: /^gpt-5\.5/, input: 5, cachedInput: 0.5, output: 30 },
  { match: /^gpt-5\.4-mini/, input: 0.75, cachedInput: 0.075, output: 4.5 },
  { match: /^gpt-5\.4-nano/, input: 0.2, cachedInput: 0.02, output: 1.25 },
  { match: /^gpt-5\.4/, input: 2.5, cachedInput: 0.25, output: 15 },
  { match: /^gpt-5\.[23]/, input: 1.75, cachedInput: 0.175, output: 14 },
  { match: /^gpt-5(\.1)?(-codex)?-mini/, input: 0.25, cachedInput: 0.025, output: 2 },
  { match: /^gpt-5(\.1)?-nano/, input: 0.05, cachedInput: 0.005, output: 0.4 },
  { match: /^gpt-5-pro/, input: 15, cachedInput: 15, output: 120 },
  { match: /^gpt-5(\.1)?(-codex)?($|-)/, input: 1.25, cachedInput: 0.125, output: 10 },
  { match: /^codex-mini/, input: 1.5, cachedInput: 0.375, output: 6 },
];

// Parses appended rollout lines. Usage is the delta of the cumulative
// `total_token_usage` between consecutive token_count events — repeated
// events (same totals) contribute nothing, unlike summing `last_token_usage`.
// The first event's baseline is totals-minus-last. The model comes from the
// surrounding turn_context records.
//
// Forked/resumed/subagent sessions replay the parent's whole token_count
// history at the head of the child file, rewritten in one burst of
// near-identical timestamps; the parent's own file already records that
// usage. When the file is marked forked and its first two events share a
// timestamp-second, the leading same-second events are skipped (they only
// seed the running totals) — the same heuristic ccusage uses.
export function parseRolloutChunk(text, state) {
  const events = [];
  const lines = String(text).split('\n');
  const remainder = text.endsWith('\n') ? '' : lines.pop() ?? '';

  for (const line of lines) {
    if (!line || (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"'))) {
      continue;
    }

    const record = parseJson(line);

    if (record?.type === 'session_meta') {
      if (record.payload?.forked_from_id || line.includes('"thread_spawn"')) {
        state.replay = true;
      }

      continue;
    }

    if (record?.type === 'turn_context') {
      const model = record.payload?.model ?? record.payload?.model_name ?? record.payload?.metadata?.model;

      if (typeof model === 'string' && model) {
        state.model = model;
        state.firstModel ??= model;
      }

      continue;
    }

    const info = record?.type === 'event_msg' && record.payload?.type === 'token_count' ? record.payload.info : null;
    const totals = info?.total_token_usage;
    const t = Date.parse(record?.timestamp || '');

    if (!totals || !Number.isFinite(t)) {
      continue;
    }

    const current = {
      input: totals.input_tokens || 0,
      cached: totals.cached_input_tokens || 0,
      output: totals.output_tokens || 0,
    };

    if (state.replay) {
      const sec = Math.floor(t / 1000);

      if (state.burstSec === null && state.prevTotals === null) {
        // Might be the replay burst or a genuinely new first event — hold it
        // until the next event tells the two apart.
        state.burstSec = sec;
        state.pending = { t, model: state.model, totals: current, last: info.last_token_usage || {} };
        state.prevTotals = current;
        continue;
      }

      if (sec === state.burstSec) {
        // Same second as the first event: it's a replay burst — drop the held
        // event and swallow the rest of the burst, tracking totals only.
        state.pending = null;
        state.prevTotals = current;
        continue;
      }

      state.replay = false;

      if (state.pending) {
        // Not a burst after all: the held first event was real usage.
        const { totals: held, last } = state.pending;
        const heldDelta = {
          input: Math.min(held.input, last.input_tokens || 0),
          cached: Math.min(held.cached, last.cached_input_tokens || 0),
          output: Math.min(held.output, last.output_tokens || 0),
        };

        if (heldDelta.input + heldDelta.output > 0) {
          events.push({ t: state.pending.t, model: state.pending.model, input: heldDelta.input, cached: heldDelta.cached, output: heldDelta.output });
        }

        state.pending = null;
      }
    }

    const last = info.last_token_usage || {};
    const base = state.prevTotals || {
      input: Math.max(0, current.input - (last.input_tokens || 0)),
      cached: Math.max(0, current.cached - (last.cached_input_tokens || 0)),
      output: Math.max(0, current.output - (last.output_tokens || 0)),
    };
    const delta = {
      input: Math.max(0, current.input - base.input),
      cached: Math.max(0, current.cached - base.cached),
      output: Math.max(0, current.output - base.output),
    };
    state.prevTotals = current;

    if (delta.input + delta.output > 0) {
      events.push({ t, model: state.model, input: delta.input, cached: delta.cached, output: delta.output });
    }
  }

  return { events, remainder };
}

// `input_tokens` includes the cached tokens — split them out for the table.
function toCodexUsage(event) {
  const model = event.model || 'unknown';
  const pricing = MODEL_PRICING.find((entry) => entry.match.test(model)) || null;
  const input = Math.max(0, event.input - event.cached);

  return {
    model,
    input,
    output: event.output,
    cacheRead: event.cached,
    cacheWrite: 0,
    cost: pricing
      ? (input * pricing.input + event.cached * pricing.cachedInput + event.output * pricing.output) / 1e6
      : null,
  };
}

// Incremental scanner over CODEX_HOME/{sessions,archived_sessions}/YYYY/MM/DD/
// rollout-*.jsonl. Archiving copies a rollout file, so when the same relative
// path exists in both roots the active copy wins.
export function createRolloutScanner(codexHome) {
  const roots = [join(codexHome, 'archived_sessions'), join(codexHome, 'sessions')];
  const refreshRollout = jsonlRefresher(parseRolloutChunk);

  const listFiles = async () => {
    const byRelPath = new Map(); // later roots (active sessions/) overwrite earlier
    let found = false;

    for (const root of roots) {
      let entries;

      try {
        entries = await readdir(root, { recursive: true });
      } catch {
        continue;
      }

      found = true;

      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          byRelPath.set(entry, join(root, entry));
        }
      }
    }

    if (!found) {
      throw new Error(`no session logs at ${roots[1]}`);
    }

    return [...byRelPath.values()];
  };

  return createLocalUsageScanner({
    listFiles,
    initState: () => ({ model: null, firstModel: null, prevTotals: null, replay: false, burstSec: null, pending: null }),

    async refreshFile(filePath, info, cached) {
      await refreshRollout(filePath, info, cached);

      // token_count events before the file's first turn_context get its model
      for (const event of cached.events) {
        if (event.model) {
          break;
        }

        event.model = cached.state.firstModel;
      }
    },

    toUsage: toCodexUsage,
  });
}

export const CODEX_LOCAL_OPTS = { source: 'sessions' };

export async function createCodexProvider(env) {
  const authPath = await findCodexAuthPath(env);

  if (!authPath) {
    return null;
  }

  const scanner = createRolloutScanner(dirname(authPath));
  const readOnly = /^(1|true|yes)$/i.test(env.TOKENSLEFT_READ_ONLY || '');

  return {
    id: 'codex',
    title: 'Codex',
    refreshMs: readRefreshMs(env, ['CODEX_REFRESH_SECONDS', 'CODEX_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const [local, snapshot] = await Promise.all([
        scanner.scan().catch((error) => ({ ok: false, error: error.message, models: [] })),
        fetchCodexUsage(authPath, readOnly),
      ]);
      snapshot.local = local;
      return snapshot;
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'codex', CODEX_LOCAL_OPTS);
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || [])
        .filter((item) => item.kind !== 'info')
        .map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

async function fetchCodexUsage(authPath, readOnly = false) {
  const startedAt = Date.now();
  let authState;

  try {
    authState = await loadAuth(authPath);
  } catch (error) {
    return { ok: false, status: 'CRED', error: error.message, ms: Date.now() - startedAt, items: [] };
  }

  const { auth } = authState;

  if (!auth.tokens?.access_token) {
    return { ok: false, status: 'APIKEY', error: 'Codex usage is not available for API-key auth. Run `codex` to log in with ChatGPT.', ms: Date.now() - startedAt, items: [] };
  }

  let token = auth.tokens.access_token;

  if (!readOnly && authNeedsRefresh(auth)) {
    try {
      token = (await refreshAuth(authPath, authState)) || token;
    } catch (message) {
      return { ok: false, status: 'EXPIRED', error: String(message), ms: Date.now() - startedAt, items: [] };
    }
  }

  let response;

  try {
    response = await requestUsage(token, auth.tokens.account_id);

    if (!readOnly && (response.status === 401 || response.status === 403)) {
      const refreshed = await refreshAuth(authPath, authState);

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

  // The reset-credit expiry dates live on a sibling endpoint; fetch them
  // best-effort only when there are credits, and never fail the snapshot.
  let resetCreditExpiries = [];

  if (Number(data?.rate_limit_reset_credits?.available_count) > 0) {
    try {
      const creditsResponse = await requestResetCredits(token, auth.tokens.account_id);

      if (creditsResponse.ok) {
        resetCreditExpiries = availableResetExpiries(parseJson(await creditsResponse.text()));
      }
    } catch {
      // best-effort: keep the count-only "Resets" line
    }
  }

  return {
    ok: true,
    ms,
    plan: data.plan_type || '',
    items: buildCodexItems(data, headers, { resetCreditExpiries }),
  };
}

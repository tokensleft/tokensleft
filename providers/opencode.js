import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { parseJson } from '../lib/http.js';
import { aggregateUsageEvents } from '../lib/local-usage.js';
import { createSingleAccountProvider } from '../lib/provider.js';

// Kept for callers of the legacy local-estimate helper. Live provider quotas
// come from the server; recorded API cost does not determine Go allowance.
const PLAN_LIMITS_USD = { session: 12, weekly: 30, monthly: 60 };
const SESSION_PERIOD_MS = 5 * 60 * 60 * 1000;
const WEEK_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

function opencodeDataDir(env) {
  return env.OPENCODE_DATA_DIR || join(homedir(), '.local', 'share', 'opencode');
}

export function startOfUtcWeek(nowMs) {
  const date = new Date(nowMs);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function anchorMonth(year, month, anchorDate) {
  const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(anchorDate.getUTCDate(), maxDay),
    anchorDate.getUTCHours(),
    anchorDate.getUTCMinutes(),
    anchorDate.getUTCSeconds(),
    anchorDate.getUTCMilliseconds(),
  );
}

// Monthly window anchored to the first recorded usage (mirrors the plan's
// billing anchor); falls back to calendar months when there is no history.
export function anchoredMonthBounds(nowMs, anchorMs) {
  if (!Number.isFinite(anchorMs)) {
    const date = new Date(nowMs);
    return {
      startMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      endMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    };
  }

  const nowDate = new Date(nowMs);
  const anchorDate = new Date(anchorMs);
  let year = nowDate.getUTCFullYear();
  let month = nowDate.getUTCMonth();
  let startMs = anchorMonth(year, month, anchorDate);

  if (startMs > nowMs) {
    month -= 1;

    if (month < 0) {
      month = 11;
      year -= 1;
    }

    startMs = anchorMonth(year, month, anchorDate);
  }

  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;
  return { startMs, endMs: anchorMonth(nextYear, nextMonth, anchorDate) };
}

export function sumCostRange(rows, startMs, endMs) {
  let total = 0;

  for (const row of rows) {
    if (row.createdMs >= startMs && row.createdMs < endMs) {
      total += row.cost;
    }
  }

  return Math.round(total * 10000) / 10000;
}

function sessionResetAt(rows, nowMs) {
  const windowStart = nowMs - SESSION_PERIOD_MS;
  let oldest = null;

  for (const row of rows) {
    if (row.createdMs >= windowStart && row.createdMs < nowMs && (oldest === null || row.createdMs < oldest)) {
      oldest = row.createdMs;
    }
  }

  return new Date((oldest === null ? nowMs : oldest) + SESSION_PERIOD_MS);
}

// OpenCode 2.x replaces message with session_message and moves the role into
// a type column and the model into data.model. Prefer it when legacy tables
// coexist after migration so the same usage is never counted twice.
function messageUsageSql(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  const v2 = tables.has('session_message');
  if (!v2 && !tables.has('message')) {
    return null;
  }
  return `SELECT time_created AS t,
              json_extract(data, '${v2 ? '$.model.providerID' : '$.providerID'}') AS providerID,
              json_extract(data, '${v2 ? '$.model.id' : '$.modelID'}') AS modelID,
              coalesce(json_extract(data, '$.tokens.input'), 0) AS input,
              coalesce(json_extract(data, '$.tokens.output'), 0) + coalesce(json_extract(data, '$.tokens.reasoning'), 0) AS output,
              coalesce(json_extract(data, '$.tokens.cache.read'), 0) AS cacheRead,
              coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS cacheWrite,
              json_extract(data, '$.cost') AS cost
       FROM ${v2 ? 'session_message' : 'message'}
       WHERE json_valid(data) AND ${v2
    ? "(type = 'assistant' OR (type = 'compaction' AND json_type(data, '$.tokens') = 'object'))"
    : "json_extract(data, '$.role') = 'assistant'"}`;
}

// Per-model local usage from assistant messages, mirroring `opencode stats`:
// reasoning tokens fold into output, `tokens.input` already excludes cache
// reads/writes, and cost is what OpenCode itself recorded per message.
export async function loadLocalModels(dbPath, now) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const sql = messageUsageSql(db);
    if (!sql) {
      throw new Error('unsupported OpenCode database schema (no message or session_message table)');
    }
    const rows = db.prepare(sql).all();

    const events = rows.map((row) => ({
      t: Number(row.t),
      model: [row.providerID, row.modelID].filter(Boolean).join('/') || 'unknown',
      input: Number(row.input) || 0,
      output: Number(row.output) || 0,
      cacheRead: Number(row.cacheRead) || 0,
      cacheWrite: Number(row.cacheWrite) || 0,
      cost: Number.isFinite(Number(row.cost)) && row.cost !== null ? Number(row.cost) : null,
    })).filter((event) => Number.isFinite(event.t));

    return { ok: true, models: aggregateUsageEvents([events], { now }) };
  } finally {
    db.close();
  }
}

export const OPENCODE_LOCAL_OPTS = {
  source: 'opencode.db',
  note: '$ = cost recorded by OpenCode per message',
};

export function buildOpencodeItems(rows, { prefix = 'opencode', now = Date.now() } = {}) {
  const anchorMs = rows.reduce((min, row) => (min === null || row.createdMs < min ? row.createdMs : min), null);
  const weekStart = startOfUtcWeek(now);
  const monthBounds = anchoredMonthBounds(now, anchorMs);
  const windows = [
    { key: 'session', label: 'Session', cost: sumCostRange(rows, now - SESSION_PERIOD_MS, now), limit: PLAN_LIMITS_USD.session, resetAt: sessionResetAt(rows, now), periodMs: SESSION_PERIOD_MS },
    { key: 'weekly', label: 'Weekly', cost: sumCostRange(rows, weekStart, weekStart + WEEK_PERIOD_MS), limit: PLAN_LIMITS_USD.weekly, resetAt: new Date(weekStart + WEEK_PERIOD_MS), periodMs: WEEK_PERIOD_MS },
    { key: 'monthly', label: 'Monthly', cost: sumCostRange(rows, monthBounds.startMs, monthBounds.endMs), limit: PLAN_LIMITS_USD.monthly, resetAt: new Date(monthBounds.endMs), periodMs: monthBounds.endMs - monthBounds.startMs },
  ];

  return windows.map((window) => buildUsageItem({
    key: `${prefix}:${window.key}`,
    label: window.label,
    value: `${Math.round(Math.min(100, (window.cost / window.limit) * 100))}% ($${window.cost.toFixed(2)}/$${window.limit})`,
    percent: Math.min(100, Math.max(0, (window.cost / window.limit) * 100)),
    resetAt: window.resetAt,
    periodMs: window.periodMs,
    now,
  }));
}

export function hasOpencodeGoAuth(auth) {
  const key = auth?.['opencode-go']?.key;
  return typeof key === 'string' && key.trim().length > 0;
}

export function buildOpencodeQuotaItems(data, { prefix = 'opencode', now = Date.now() } = {}) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return [];
  return [
    ['rolling', 'Session', SESSION_PERIOD_MS],
    ['weekly', 'Weekly', WEEK_PERIOD_MS],
    ['monthly', 'Monthly', null],
  ].flatMap(([key, label, periodMs]) => {
    const window = usage[key];
    if (typeof window?.percent !== 'number' || !Number.isFinite(window.percent)
      || window.percent < 0 || window.percent > 100) return [];
    return [buildUsageItem({
      key: `${prefix}:${key}`, label, percent: window.percent,
      resetAt: toDate(window.resetsAt), periodMs, now,
      severity: window.status && window.status !== 'ok' ? 'warning' : '',
      details: window.status && window.status !== 'ok' ? [`Status: ${window.status}`] : [],
    })];
  });
}

async function fetchGoQuota(key) {
  // The inference route replaced Zen in v2. Older deployments keep Zen.
  for (const url of ['https://opencode.ai/inference/go/v1/usage', 'https://opencode.ai/zen/go/v1/usage']) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'tokensleft' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) { await response.body?.cancel(); continue; }
    if (!response.ok) return { items: [], error: `quota unavailable (HTTP ${response.status})` };
    const data = parseJson(await response.text());
    const items = buildOpencodeQuotaItems(data);
    if (!items.some((item) => item.kind === 'usage')) return { items: [], error: 'quota response has no valid usage windows' };
    items.push({ kind: 'info', key: 'opencode:overage', label: 'Extra usage', value: typeof data?.useBalance === 'boolean' ? data.useBalance ? 'enabled' : 'disabled' : 'unavailable' });
    const plan = data?.plan === 'go-plus' ? 'Go Plus' : data?.plan === 'go' ? 'Go' : 'Go (tier unavailable)';
    return { items, plan };
  }
  return { items: [], error: 'quota endpoint unavailable' };
}

export async function createOpencodeProvider(env) {
  const dataDir = opencodeDataDir(env);
  const authPath = join(dataDir, 'auth.json');
  const dbPath = join(dataDir, 'opencode.db');
  const auth = parseJson(await readFile(authPath, 'utf8').catch(() => ''));
  const goKey = env.OPENCODE_GO_API_KEY?.trim() || (hasOpencodeGoAuth(auth) ? auth['opencode-go'].key.trim() : '');
  const hasGoAuth = !!goKey;
  const hasDb = await access(dbPath).then(() => true, () => false);

  if (!hasGoAuth && !hasDb) {
    return null;
  }

  return createSingleAccountProvider({
    id: 'opencode',
    title: 'OpenCode',
    refreshMs: readRefreshMs(env, ['OPENCODE_REFRESH_SECONDS', 'OPENCODE_REFRESH_SEC'], DEFAULT_REFRESH_MS),
    localOpts: OPENCODE_LOCAL_OPTS,

    async fetch() {
      const startedAt = Date.now();

      const local = hasDb ? await loadLocalModels(dbPath, Date.now())
        .catch((error) => ({ ok: false, error: `cannot read opencode.db: ${error.message}`, models: [] }))
        : { ok: true, models: [] };

      // A database can exist for any OpenCode provider. Fixed Go plan limits
      // are meaningful only when opencode-go auth is present; DB-only installs
      // still get their local per-model usage table without invented quotas.
      if (!hasGoAuth) {
        return {
          ok: local.ok,
          status: local.ok ? 'OK' : 'DB',
          error: local.ok ? '' : local.error,
          ms: Date.now() - startedAt,
          plan: '',
          items: [],
          local,
        };
      }

      const currentAuth = parseJson(await readFile(authPath, 'utf8').catch(() => ''));
      const currentKey = env.OPENCODE_GO_API_KEY?.trim() || (hasOpencodeGoAuth(currentAuth) ? currentAuth['opencode-go'].key.trim() : '') || goKey;
      const quota = await fetchGoQuota(currentKey).catch(() => ({ items: [], error: 'quota request failed; check connection or Console' }));

      return {
        ok: true,
        ms: Date.now() - startedAt,
        plan: quota.plan || 'Go (tier unavailable)',
        items: quota.items.length ? quota.items : [{ kind: 'empty', key: 'opencode:quota', label: 'Go quota', message: quota.error }],
        local,
      };
    },
  });
}

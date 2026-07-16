import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem } from '../lib/forecast.js';
import { parseJson } from '../lib/http.js';
import { aggregateUsageEvents } from '../lib/local-usage.js';
import { renderSingleAccount } from '../lib/provider-render.js';

// OpenCode's "Go" plan has no usage API; the CLI stores per-session cost in a
// local SQLite DB, and the plan limits are fixed dollar amounts.
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

async function loadCostRows(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const columns = db.prepare('PRAGMA table_info(session)').all().map((row) => row.name);
    const modernSchema = columns.includes('cost') && columns.includes('model');
    const sql = modernSchema
      ? `SELECT time_updated AS createdMs, CAST(cost AS TEXT) AS cost
         FROM session
         WHERE json_valid(model) AND json_extract(model, '$.providerID') = 'opencode-go' AND cost > 0`
      : `SELECT time_created AS createdMs, CAST(coalesce(json_extract(data, '$.cost'), 0) AS TEXT) AS cost
         FROM message
         WHERE json_valid(data) AND json_extract(data, '$.providerID') = 'opencode-go'
           AND json_extract(data, '$.role') = 'assistant' AND coalesce(json_extract(data, '$.cost'), 0) > 0`;

    return db.prepare(sql).all()
      .map((row) => ({ createdMs: Number(row.createdMs), cost: Number(row.cost) }))
      .filter((row) => Number.isFinite(row.createdMs) && row.createdMs > 0 && Number.isFinite(row.cost) && row.cost >= 0);
  } finally {
    db.close();
  }
}

// Per-model local usage from assistant messages, mirroring `opencode stats`:
// reasoning tokens fold into output, `tokens.input` already excludes cache
// reads/writes, and cost is what OpenCode itself recorded per message.
export async function loadLocalModels(dbPath, now) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const rows = db.prepare(
      `SELECT time_created AS t,
              json_extract(data, '$.providerID') AS providerID,
              json_extract(data, '$.modelID') AS modelID,
              coalesce(json_extract(data, '$.tokens.input'), 0) AS input,
              coalesce(json_extract(data, '$.tokens.output'), 0) + coalesce(json_extract(data, '$.tokens.reasoning'), 0) AS output,
              coalesce(json_extract(data, '$.tokens.cache.read'), 0) AS cacheRead,
              coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS cacheWrite,
              json_extract(data, '$.cost') AS cost
       FROM message
       WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant'`,
    ).all();

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

export async function createOpencodeProvider(env) {
  const dataDir = opencodeDataDir(env);
  const authPath = join(dataDir, 'auth.json');
  const dbPath = join(dataDir, 'opencode.db');
  const auth = parseJson(await readFile(authPath, 'utf8').catch(() => ''));
  const hasGoAuth = hasOpencodeGoAuth(auth);
  const hasDb = await access(dbPath).then(() => true, () => false);

  if (!hasGoAuth && !hasDb) {
    return null;
  }

  return {
    id: 'opencode',
    title: 'OpenCode',
    refreshMs: readRefreshMs(env, ['OPENCODE_REFRESH_SECONDS', 'OPENCODE_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();

      if (!hasDb) {
        return { ok: true, ms: Date.now() - startedAt, plan: 'Go', items: [{ kind: 'empty', key: 'opencode:none', label: 'Usage', message: 'no local usage history yet' }] };
      }

      const local = await loadLocalModels(dbPath, Date.now())
        .catch((error) => ({ ok: false, error: `cannot read opencode.db: ${error.message}`, models: [] }));

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

      let rows;

      try {
        rows = await loadCostRows(dbPath);
      } catch (error) {
        return { ok: false, status: 'DB', error: `cannot read opencode.db: ${error.message}`, ms: Date.now() - startedAt, items: [], local };
      }

      return {
        ok: true,
        ms: Date.now() - startedAt,
        plan: 'Go',
        items: buildOpencodeItems(rows),
        local,
      };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'opencode', OPENCODE_LOCAL_OPTS);
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).filter((item) => item.kind !== 'empty').map((item) => ({ key: item.key, label: item.label, percent: item.percent, resetAt: item.resetAt }));
    },
  };
}

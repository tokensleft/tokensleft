import { access, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from '../lib/claude-settings.js';
import { writeFileAtomic } from '../lib/fsx.js';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed, formatTokens, maskKey, padStart, padVisible } from '../lib/format.js';
import { parseJson, parseRetryAfterDate } from '../lib/http.js';
import { formatUsageItem, formatUsageItemCompact } from '../lib/render.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Claude Code's public OAuth client — same values every install ships with;
// used only to redeem the refresh_token already on disk.
const TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SESSION_PERIOD_MS = 5 * 60 * 60 * 1000;
const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

// USD per 1M tokens; cache read = 0.1x input, cache write 5m = 1.25x, 1h = 2x
export const MODEL_PRICING = [
  { match: /^claude-fable-5/, input: 10, output: 50 },
  { match: /^claude-mythos-5/, input: 10, output: 50 },
  { match: /^claude-opus-4/, input: 5, output: 25 },
  { match: /^claude-sonnet-5/, input: 3, output: 15 },
  { match: /^claude-sonnet-4/, input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, input: 1, output: 5 },
];

export { claudeConfigDir } from '../lib/claude-settings.js';

// Accounts: the system key is auto-detected from Claude Code's credentials
// file (re-read on every refresh — Claude Code rotates the token); manual
// keys come from CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_TOKEN_1..N in .env.
export async function readClaudeAccounts(env) {
  const accounts = [];
  const configDir = claudeConfigDir(env);
  const disableSystem = /^(1|true|yes)$/i.test(env.CLAUDE_DISABLE_SYSTEM_KEY || '');

  if (!disableSystem) {
    const credentialsPath = join(configDir, '.credentials.json');
    const exists = await access(credentialsPath).then(() => true, () => false);

    if (exists) {
      accounts.push({
        name: env.CLAUDE_SYSTEM_NAME || 'system',
        source: 'system',
        credentialsPath,
      });
    }
  }

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    accounts.push({
      name: env.CLAUDE_NAME || 'manual',
      source: 'manual',
      token: env.CLAUDE_CODE_OAUTH_TOKEN,
    });
  }

  for (let index = 1; ; index += 1) {
    const token = env[`CLAUDE_TOKEN_${index}`] || env[`CLAUDE_KEY_${index}`];

    if (!token) {
      break;
    }

    accounts.push({
      name: env[`CLAUDE_NAME_${index}`] || `manual_${index}`,
      source: 'manual',
      token,
    });
  }

  return accounts;
}

async function resolveCredentials(account) {
  if (account.source === 'manual') {
    return { token: account.token, plan: '', expiresAt: null, refresh: null };
  }

  const raw = await readFile(account.credentialsPath, 'utf8').catch((error) => {
    throw new Error(`cannot read credentials: ${error.message}`);
  });
  const parsed = parseJson(raw);
  const oauth = parsed?.claudeAiOauth;

  if (!oauth?.accessToken) {
    throw new Error('no accessToken in .credentials.json — run `claude` and /login');
  }

  return {
    token: oauth.accessToken,
    plan: [oauth.subscriptionType, (oauth.rateLimitTier || '').replace(/^default_/, '')].filter(Boolean).join(' / '),
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    refresh: oauth.refreshToken
      ? () => refreshOAuthToken(account.credentialsPath, parsed, oauth)
      : null,
  };
}

// Redeems the refresh token and persists the rotated credentials back to the
// file, exactly as Claude Code itself would (minified JSON, other keys kept).
// Returns the new access token, null on soft failure, throws a user-facing
// string when the refresh token itself is dead (re-login required).
async function refreshOAuthToken(credentialsPath, parsed, oauth) {
  let response;

  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }

  const body = parseJson(await response.text());

  if (response.status === 400 || response.status === 401) {
    const code = body?.error || body?.error_description || '';
    throw `token refresh rejected (${code || response.status}) — run \`claude\` and /login again`;
  }

  if (!response.ok || !body?.access_token) {
    return null;
  }

  oauth.accessToken = body.access_token;

  if (body.refresh_token) {
    oauth.refreshToken = body.refresh_token;
  }

  if (typeof body.expires_in === 'number') {
    oauth.expiresAt = Date.now() + body.expires_in * 1000;
  }

  parsed.claudeAiOauth = oauth;
  await writeFileAtomic(credentialsPath, JSON.stringify(parsed)).catch(() => {});
  return oauth.accessToken;
}

export function tokenNeedsRefresh(expiresAt, now = Date.now()) {
  return Number.isFinite(expiresAt) && now + TOKEN_REFRESH_BUFFER_MS >= expiresAt;
}

export function buildClaudeLimitItems(data, { prefix = 'claude', now = Date.now() } = {}) {
  const items = [];
  const limits = Array.isArray(data?.limits) ? data.limits : [];

  if (limits.length > 0) {
    for (const limit of limits) {
      const isSession = limit.group === 'session' || limit.kind === 'session';
      const scopeName = limit.scope?.model?.display_name || limit.scope?.surface || '';
      const label = isSession
        ? 'Session'
        : limit.kind === 'weekly_scoped'
          ? `Wk ${scopeName || 'scoped'}`
          : 'Weekly all';
      const percent = Number.isFinite(limit.percent) ? limit.percent : 0;
      const resetAt = toDate(limit.resets_at);
      const periodMs = isSession ? SESSION_PERIOD_MS : WEEKLY_PERIOD_MS;

      items.push(buildUsageItem({
        key: `${prefix}:${limit.kind || label}${scopeName ? `:${scopeName}` : ''}`,
        label,
        percent,
        resetAt,
        periodMs,
        severity: limit.severity || '',
        active: limit.is_active === true,
        now,
      }));
    }
  } else {
    if (data?.five_hour) {
      items.push(buildUsageItem({
        key: `${prefix}:session`,
        label: 'Session',
        percent: data.five_hour.utilization ?? 0,
        resetAt: toDate(data.five_hour.resets_at),
        periodMs: SESSION_PERIOD_MS,
        now,
      }));
    }

    if (data?.seven_day) {
      items.push(buildUsageItem({
        key: `${prefix}:weekly`,
        label: 'Weekly all',
        percent: data.seven_day.utilization ?? 0,
        resetAt: toDate(data.seven_day.resets_at),
        periodMs: WEEKLY_PERIOD_MS,
        now,
      }));
    }
  }

  if (data?.extra_usage?.is_enabled) {
    items.push(buildUsageItem({
      key: `${prefix}:extra`,
      label: 'Extra usage',
      percent: Number.isFinite(data.extra_usage.utilization) ? data.extra_usage.utilization : 0,
      periodMs: MONTHLY_PERIOD_MS,
      now,
    }));
  }

  return items;
}

export function formatSpend(spend) {
  if (!spend?.enabled) {
    return '';
  }

  const used = spend.used;
  const exponent = Number.isFinite(used?.exponent) ? used.exponent : 2;
  const amount = Number.isFinite(used?.amount_minor) ? (used.amount_minor / 10 ** exponent).toFixed(2) : '0.00';
  return `$${amount} (${Math.round(spend.percent || 0)}%)`;
}

async function fetchAccountUsage(account, seenTokens) {
  const startedAt = Date.now();
  let credentials;

  try {
    credentials = await resolveCredentials(account);
  } catch (error) {
    return { name: account.name, source: account.source, ok: false, status: 'CRED', error: error.message, ms: Date.now() - startedAt, items: [] };
  }

  if (seenTokens.has(credentials.token)) {
    return { name: account.name, source: account.source, ok: false, status: 'DUP', error: `same token as "${seenTokens.get(credentials.token)}" — skipped`, ms: 0, items: [] };
  }

  seenTokens.set(credentials.token, account.name);

  let token = credentials.token;

  // Proactively refresh when the token is expired or about to expire.
  if (credentials.refresh && tokenNeedsRefresh(credentials.expiresAt)) {
    try {
      token = (await credentials.refresh()) || token;
    } catch (message) {
      return { name: account.name, source: account.source, plan: credentials.plan, ok: false, status: 'EXPIRED', error: String(message), ms: Date.now() - startedAt, items: [] };
    }
  }

  if (!credentials.refresh && credentials.expiresAt && credentials.expiresAt < Date.now()) {
    return {
      name: account.name,
      source: account.source,
      plan: credentials.plan,
      ok: false,
      status: 'EXPIRED',
      error: 'OAuth token expired and no refresh token available. Run any prompt in Claude Code, or /login again.',
      ms: Date.now() - startedAt,
      items: [],
    };
  }

  const requestUsage = (bearer) => fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  let response;

  try {
    response = await requestUsage(token);

    // Stale token the expiry check missed — refresh once and retry.
    if ((response.status === 401 || response.status === 403) && credentials.refresh) {
      const refreshed = await credentials.refresh();

      if (refreshed) {
        token = refreshed;
        response = await requestUsage(token);
      }
    }
  } catch (error) {
    const message = typeof error === 'string' ? error : `request failed: ${error.message}`;
    return { name: account.name, source: account.source, plan: credentials.plan, ok: false, status: typeof error === 'string' ? 'EXPIRED' : 'ERR', error: message, ms: Date.now() - startedAt, items: [] };
  }

  const text = await response.text();
  const data = parseJson(text);
  const ms = Date.now() - startedAt;

  if (response.status === 401 || response.status === 403) {
    return { name: account.name, source: account.source, plan: credentials.plan, ok: false, status: response.status, error: 'OAuth token invalid or expired. Run `claude` and /login again.', ms, items: [] };
  }

  if (!response.ok || !data) {
    return {
      name: account.name,
      source: account.source,
      plan: credentials.plan,
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      body: text.slice(0, 300),
      retryAfterAt: parseRetryAfterDate(response.headers.get('retry-after')),
      ms,
      items: [],
    };
  }

  return {
    name: account.name,
    source: account.source,
    plan: credentials.plan,
    ok: true,
    ms,
    items: buildClaudeLimitItems(data, { prefix: account.name }),
    spend: formatSpend(data.spend),
  };
}

// --- local transcript aggregation ----------------------------------------------

export function parseTranscriptChunk(text) {
  const events = [];
  const lines = String(text).split('\n');
  const endsWithNewline = text.endsWith('\n');
  const remainder = endsWithNewline ? '' : lines.pop() ?? '';

  for (const line of lines) {
    if (!line || !line.includes('"usage"')) {
      continue;
    }

    const record = parseJson(line);
    const message = record?.message;

    if (record?.type !== 'assistant' || !message?.usage || !message.model || message.model.startsWith('<')) {
      continue;
    }

    const t = Date.parse(record.timestamp || '');

    if (!Number.isFinite(t)) {
      continue;
    }

    const usage = message.usage;
    events.push({
      t,
      id: message.id || record.uuid || '',
      model: message.model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cache5m: usage.cache_creation?.ephemeral_5m_input_tokens ?? (usage.cache_creation ? 0 : usage.cache_creation_input_tokens || 0),
      cache1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    });
  }

  return { events, remainder };
}

// Incremental scanner: transcripts are append-only, so we remember the byte
// offset of the last complete line per file and only parse what was appended.
export function createTranscriptScanner(configDir) {
  const fileCache = new Map(); // path -> { offset, events }

  const readSlice = async (filePath, position, length) => {
    const handle = await open(filePath, 'r');

    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  };

  const updateFile = async (filePath, size) => {
    let cached = fileCache.get(filePath);

    if (cached && size < cached.offset) {
      cached = null; // file shrank (rotated/rewritten) — reparse
    }

    if (!cached) {
      cached = { offset: 0, events: [] };
      fileCache.set(filePath, cached);
    }

    if (size > cached.offset) {
      const text = await readSlice(filePath, cached.offset, size - cached.offset);
      const { events, remainder } = parseTranscriptChunk(text);
      cached.events.push(...events);
      cached.offset += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(remainder, 'utf8');
    }

    return cached;
  };

  return {
    async scan(now = Date.now()) {
      const projectsDir = join(configDir, 'projects');
      const weekStart = now - WEEKLY_PERIOD_MS;
      const todayStart = new Date(now).setHours(0, 0, 0, 0);
      const seenFiles = new Set();
      let files = 0;

      let projectNames;

      try {
        projectNames = await readdir(projectsDir);
      } catch {
        return { ok: false, error: `no transcripts at ${projectsDir}`, models: [] };
      }

      for (const project of projectNames) {
        const dir = join(projectsDir, project);
        let entries = [];

        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) {
            continue;
          }

          const filePath = join(dir, entry);
          const info = await stat(filePath).catch(() => null);

          if (!info || info.mtimeMs < weekStart) {
            fileCache.delete(filePath);
            continue;
          }

          files += 1;
          seenFiles.add(filePath);

          try {
            const cached = await updateFile(filePath, info.size);
            cached.events = cached.events.filter((event) => event.t >= weekStart);
          } catch {
            fileCache.delete(filePath);
          }
        }
      }

      for (const filePath of fileCache.keys()) {
        if (!seenFiles.has(filePath)) {
          fileCache.delete(filePath);
        }
      }

      return { ok: true, files, models: aggregateEvents(fileCache, { weekStart, todayStart }) };
    },
  };
}

export function aggregateEvents(fileCache, { weekStart, todayStart }) {
  const perModel = new Map();
  const seen = new Set();

  for (const { events } of fileCache.values()) {
    for (const event of events) {
      if (event.t < weekStart) {
        continue;
      }

      if (event.id) {
        if (seen.has(event.id)) {
          continue;
        }

        seen.add(event.id);
      }

      let bucket = perModel.get(event.model);

      if (!bucket) {
        bucket = {
          model: event.model,
          pricing: MODEL_PRICING.find((entry) => entry.match.test(event.model)) || null,
          today: emptyUsage(),
          week: emptyUsage(),
        };
        perModel.set(event.model, bucket);
      }

      addUsage(bucket.week, event, bucket.pricing);

      if (event.t >= todayStart) {
        addUsage(bucket.today, event, bucket.pricing);
      }
    }
  }

  return [...perModel.values()].sort((a, b) => (b.week.cost - a.week.cost) || (b.week.output - a.week.output));
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, hasCost: false };
}

function addUsage(target, event, pricing) {
  target.input += event.input;
  target.output += event.output;
  target.cacheRead += event.cacheRead;
  target.cacheWrite += event.cache5m + event.cache1h;
  target.messages += 1;

  if (pricing) {
    target.hasCost = true;
    target.cost += (
      event.input * pricing.input +
      event.output * pricing.output +
      event.cacheRead * pricing.input * 0.1 +
      event.cache5m * pricing.input * 1.25 +
      event.cache1h * pricing.input * 2
    ) / 1e6;
  }
}

// --- rendering -------------------------------------------------------------------

function renderAccountBlock(result, width, mode = 'detail') {
  const compact = mode === 'compact';
  const status = result.ok
    ? '{green-fg}{bold}OK{/bold}{/green-fg}'
    : `{red-fg}{bold}${escapeBlessed(String(result.status))}{/bold}{/red-fg}`;
  const metaParts = compact
    ? [result.plan, result.spend ? `spend ${result.spend}` : '']
    : [result.plan, result.source, `${result.ms}ms`];
  const meta = metaParts.filter(Boolean).join(' · ');
  const lines = [
    `{cyan-fg}{bold}${escapeBlessed(result.name)}{/bold}{/cyan-fg}  ${status}  {white-fg}${escapeBlessed(meta)}{/white-fg}`,
  ];

  if (!result.ok) {
    lines.push(`  {red-fg}${escapeBlessed(result.error || 'unknown error')}{/red-fg}`);

    if (result.body && !compact) {
      lines.push(`  {white-fg}${escapeBlessed(result.body)}{/white-fg}`);
    }

    if (result.retryAfterAt) {
      lines.push(`  {yellow-fg}retry after ${escapeBlessed(result.retryAfterAt.toLocaleTimeString())}{/yellow-fg}`);
    }

    return lines.join('\n');
  }

  const itemFormatter = compact ? formatUsageItemCompact : formatUsageItem;
  lines.push(...result.items.map((item) => itemFormatter(item, width)));

  if (result.spend && !compact) {
    lines.push(`  {bold}${'Spend'.padEnd(12)}{/bold} ${escapeBlessed(result.spend)}`);
  }

  return lines.join('\n');
}

export function formatModelTable(models) {
  const rows = [];
  const header = [
    padVisible('model', 22),
    padStart('today out', 10),
    padStart('today $', 9),
    padStart('7d in', 9),
    padStart('7d out', 9),
    padStart('7d cache', 10),
    padStart('7d $', 9),
    padStart('msgs', 7),
  ].join(' ');
  rows.push(`  {white-fg}{underline}${escapeBlessed(header)}{/underline}{/white-fg}`);

  const totals = { todayOut: 0, todayCost: 0, weekIn: 0, weekOut: 0, weekCache: 0, weekCost: 0, messages: 0 };

  for (const entry of models) {
    const line = [
      padVisible(entry.model.replace(/^claude-/, '').replace(/-\d{8}$/, ''), 22),
      padStart(formatTokens(entry.today.output), 10),
      padStart(formatCost(entry.today), 9),
      padStart(formatTokens(entry.week.input), 9),
      padStart(formatTokens(entry.week.output), 9),
      padStart(formatTokens(entry.week.cacheRead + entry.week.cacheWrite), 10),
      padStart(formatCost(entry.week), 9),
      padStart(String(entry.week.messages), 7),
    ].join(' ');
    const tone = /fable|mythos/.test(entry.model) ? 'magenta' : /opus/.test(entry.model) ? 'yellow' : 'white';
    rows.push(`  {${tone}-fg}${escapeBlessed(line)}{/${tone}-fg}`);

    totals.todayOut += entry.today.output;
    totals.todayCost += entry.today.cost;
    totals.weekIn += entry.week.input;
    totals.weekOut += entry.week.output;
    totals.weekCache += entry.week.cacheRead + entry.week.cacheWrite;
    totals.weekCost += entry.week.cost;
    totals.messages += entry.week.messages;
  }

  const totalLine = [
    padVisible('total', 22),
    padStart(formatTokens(totals.todayOut), 10),
    padStart(`$${totals.todayCost.toFixed(2)}`, 9),
    padStart(formatTokens(totals.weekIn), 9),
    padStart(formatTokens(totals.weekOut), 9),
    padStart(formatTokens(totals.weekCache), 10),
    padStart(`$${totals.weekCost.toFixed(2)}`, 9),
    padStart(String(totals.messages), 7),
  ].join(' ');
  rows.push(`  {bold}${escapeBlessed(totalLine)}{/bold}`);
  rows.push('  {gray-fg}$ = estimated from public API prices; subscription usage is prepaid{/gray-fg}');

  return rows.join('\n');
}

// Compact local usage: one line per model, totals only when several models.
export function formatLocalCompact(local) {
  if (!local.ok) {
    return `  {red-fg}local: ${escapeBlessed(local.error || 'scan failed')}{/red-fg}`;
  }

  if (local.models.length === 0) {
    return '  {white-fg}local: no usage in the last 7 days{/white-fg}';
  }

  const lines = local.models.map((entry) => {
    const name = entry.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const tone = /fable|mythos/.test(entry.model) ? 'magenta' : /opus/.test(entry.model) ? 'yellow' : 'white';
    const text = [
      `today ${formatTokens(entry.today.output)} out ${formatCost(entry.today)}`,
      `7d ${formatTokens(entry.week.output)} out ${formatCost(entry.week)}`,
      `cache ${formatTokens(entry.week.cacheRead + entry.week.cacheWrite)}`,
      `${entry.week.messages} msgs`,
    ].join(' · ');

    return `  {bold}${escapeBlessed(name.padEnd(12))}{/bold} {${tone}-fg}${escapeBlessed(text)}{/${tone}-fg}`;
  });

  if (local.models.length > 1) {
    const totals = local.models.reduce((acc, entry) => {
      acc.todayCost += entry.today.cost;
      acc.weekOut += entry.week.output;
      acc.weekCost += entry.week.cost;
      return acc;
    }, { todayCost: 0, weekOut: 0, weekCost: 0 });
    lines.push(`  {bold}${'total'.padEnd(12)}{/bold} today $${totals.todayCost.toFixed(2)} · 7d ${formatTokens(totals.weekOut)} out $${totals.weekCost.toFixed(2)}`);
  }

  return lines.join('\n');
}

function formatCost(usage) {
  if (!usage.hasCost) {
    return usage.messages > 0 ? '?' : '$0.00';
  }

  return `$${usage.cost.toFixed(2)}`;
}

// Full provider view: one block per account plus the local-usage section.
// Shared with the demo provider (lib/demo.js).
export function renderClaudeSnapshot(snapshot, width, mode = 'detail') {
  if (snapshot.fatal) {
    return `  {red-fg}${escapeBlessed(snapshot.fatal)}{/red-fg}`;
  }

  const compact = mode === 'compact';
  const sections = snapshot.results
    .filter((result) => result.status !== 'DUP')
    .map((result) => renderAccountBlock(result, width, mode));

  if (compact) {
    sections.push(formatLocalCompact(snapshot.local));
  } else {
    sections.push([
      `{cyan-fg}{bold}Local usage by model{/bold}{/cyan-fg} {white-fg}(transcripts, last 7 days${snapshot.local.ok ? ` | ${snapshot.local.files} files` : ''}){/white-fg}`,
      snapshot.local.ok
        ? snapshot.local.models.length > 0
          ? formatModelTable(snapshot.local.models)
          : '  {white-fg}no usage recorded in the last 7 days{/white-fg}'
        : `  {red-fg}${escapeBlessed(snapshot.local.error || 'scan failed')}{/red-fg}`,
    ].join('\n'));
  }

  return sections.join(compact ? '\n' : '\n\n');
}

// --- provider ---------------------------------------------------------------------

export async function createClaudeProvider(env) {
  const accounts = await readClaudeAccounts(env);

  if (accounts.length === 0) {
    return null;
  }

  const scanner = createTranscriptScanner(claudeConfigDir(env));

  return {
    id: 'claude',
    title: 'Claude Code',
    refreshMs: readRefreshMs(env, ['CLAUDE_REFRESH_SECONDS', 'CLAUDE_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();
      const local = await scanner.scan().catch((error) => ({ ok: false, error: error.message, models: [] }));

      const seenTokens = new Map();
      const results = [];

      for (const account of accounts) {
        results.push(await fetchAccountUsage(account, seenTokens));
      }

      return { results, local, ms: Date.now() - startedAt };
    },

    render(snapshot, width, mode = 'detail') {
      return renderClaudeSnapshot(snapshot, width, mode);
    },

    headerStatus(snapshot) {
      if (snapshot.fatal) {
        return { ok: false, text: 'ERR' };
      }

      const counted = snapshot.results.filter((result) => result.status !== 'DUP');
      const okCount = counted.filter((result) => result.ok).length;
      return { ok: okCount === counted.length, text: `${okCount}/${counted.length} OK` };
    },

    alertItems(snapshot) {
      if (snapshot.fatal) {
        return [];
      }

      return snapshot.results.flatMap((result) => result.items.map((item) => ({
        key: item.key,
        label: `${result.name} ${item.label}`,
        percent: item.percent,
      })));
    },

    nextDelayMs(snapshot, base) {
      const rateLimited = snapshot?.results?.filter((result) => result.status === 429) || [];

      if (rateLimited.length === 0) {
        return base;
      }

      const retryDelays = rateLimited
        .map((result) => result.retryAfterAt instanceof Date ? result.retryAfterAt.getTime() - Date.now() : NaN)
        .filter((delay) => Number.isFinite(delay) && delay > 0);
      return Math.max(base, RATE_LIMIT_BACKOFF_MS, ...retryDelays);
    },
  };
}

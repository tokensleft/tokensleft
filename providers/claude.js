import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from '../lib/claude-settings.js';
import { writeFileAtomic } from '../lib/fsx.js';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed } from '../lib/format.js';
import { parseJson, parseRetryAfterDate } from '../lib/http.js';
import { createLocalUsageScanner, jsonlRefresher, renderLocalUsage } from '../lib/local-usage.js';
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

// Maps a transcript event to the canonical usage-event shape, pricing it at
// public API rates (cache read = 0.1x input, cache write 5m = 1.25x, 1h = 2x).
function toClaudeUsage(event) {
  const pricing = MODEL_PRICING.find((entry) => entry.match.test(event.model)) || null;

  return {
    model: event.model,
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead,
    cacheWrite: event.cache5m + event.cache1h,
    cost: pricing
      ? (
        event.input * pricing.input +
        event.output * pricing.output +
        event.cacheRead * pricing.input * 0.1 +
        event.cache5m * pricing.input * 1.25 +
        event.cache1h * pricing.input * 2
      ) / 1e6
      : null,
  };
}

// Incremental scanner over ~/.claude/projects/**/*.jsonl transcripts —
// recursive, so subagent transcripts (projects/<slug>/<session>/subagents/…)
// count too.
export function createTranscriptScanner(configDir) {
  const projectsDir = join(configDir, 'projects');

  const listFiles = async () => {
    let entries;

    try {
      entries = await readdir(projectsDir, { recursive: true });
    } catch {
      throw new Error(`no transcripts at ${projectsDir}`);
    }

    return entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => join(projectsDir, entry));
  };

  return createLocalUsageScanner({
    listFiles,
    refreshFile: jsonlRefresher(parseTranscriptChunk),
    toUsage: toClaudeUsage,
  });
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

export const CLAUDE_LOCAL_OPTS = {
  source: 'transcripts',
  shorten: (model) => model.replace(/^claude-/, '').replace(/-\d{8}$/, ''),
  tone: (model) => /fable|mythos/.test(model) ? 'magenta' : /opus/.test(model) ? 'yellow' : 'white',
};

// Full provider view: one block per account, plus the local-usage section in
// the detail view (`d`). Shared with the demo provider (lib/demo.js).
export function renderClaudeSnapshot(snapshot, width, mode = 'detail') {
  if (snapshot.fatal) {
    return `  {red-fg}${escapeBlessed(snapshot.fatal)}{/red-fg}`;
  }

  const compact = mode === 'compact';
  const sections = snapshot.results
    .filter((result) => result.status !== 'DUP')
    .map((result) => renderAccountBlock(result, width, mode));

  if (!compact) {
    sections.push(renderLocalUsage(snapshot.local, CLAUDE_LOCAL_OPTS));
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

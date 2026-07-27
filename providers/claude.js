import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir } from '../lib/claude-settings.js';
import { writeFileAtomic } from '../lib/fsx.js';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed, formatCountdown, formatDateTime, truncateTagged } from '../lib/format.js';
import { parseJson, parseRetryAfterDate } from '../lib/http.js';
import { createLocalUsageScanner, jsonlRefresher, renderLocalUsage } from '../lib/local-usage.js';
import { calculateModelCost } from '../lib/model-pricing.js';
import { COLOR } from '../lib/palette.js';
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

export function resolveRetryAfterAt(value, { now = Date.now(), minimumMs = RATE_LIMIT_BACKOFF_MS } = {}) {
  const parsed = parseRetryAfterDate(value, now);
  const serverTime = parsed instanceof Date ? parsed.getTime() : 0;
  return new Date(Math.max(now + minimumMs, serverTime));
}

export { claudeConfigDir } from '../lib/claude-settings.js';

// On macOS, Claude Code stores its OAuth credentials in the login Keychain
// instead of ~/.claude/.credentials.json — the item holds exactly the JSON the
// file would have. Without this fallback the provider looks logged out on
// every Mac.
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// `security` exits 44 (errSecItemNotFound) when nothing matches — the honest
// "no credential stored" case. Every OTHER non-zero exit is a real failure (a
// locked keychain, a denied or dismissed access prompt) and must never be
// reported as "not signed in", which sends users off to re-run /login for a
// login that is already there.
const KEYCHAIN_ITEM_NOT_FOUND = 44;

function describeSecurityFailure(error, stderr) {
  if (error.killed || error.signal || error.code === 'ETIMEDOUT') {
    return 'timed out — a Keychain access prompt may still be waiting for an answer';
  }

  if (error.code === 'ENOENT') {
    return '/usr/bin/security is missing';
  }

  // `security` explains itself well ("User interaction is not allowed.",
  // "The user name or passphrase you entered is not correct."), so pass its own
  // first line through rather than inventing a worse message.
  const reported = String(stderr || '').trim().split('\n')[0].replace(/^security: /, '');
  return reported || `security exited with ${error.code}`;
}

function runSecurity(args) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ found: true, value: String(stdout).trim() });
        return;
      }

      resolve(error.code === KEYCHAIN_ITEM_NOT_FOUND
        ? { found: false }
        : { found: false, error: describeSecurityFailure(error, stderr) });
    });
  });
}

// Claude Code suffixes the Keychain item with a hash of a non-default config
// directory, so a CLAUDE_CONFIG_DIR install keeps its own item; the unsuffixed
// name stays as a fallback for installs that predate it.
function configDirHash(configDir) {
  return createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
}

export function keychainServiceCandidates(env) {
  if (env.CLAUDE_KEYCHAIN_SERVICE) {
    return [env.CLAUDE_KEYCHAIN_SERVICE];
  }

  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override
    ? [`${KEYCHAIN_SERVICE}-${configDirHash(override)}`, KEYCHAIN_SERVICE]
    : [KEYCHAIN_SERVICE];
}

// Claude Code writes the item under the current user's account, but a login
// left by an older version can carry no account at all. Ask for the scoped item
// first so a service-only match can never hand back somebody else's stale item,
// then fall back to the bare lookup.
export function keychainLookups(env) {
  const account = (env.USER || '').trim() || userInfo().username;

  return keychainServiceCandidates(env).flatMap((service) => (account
    ? [
      { service, args: ['find-generic-password', '-a', account, '-s', service] },
      { service, args: ['find-generic-password', '-s', service] },
    ]
    : [{ service, args: ['find-generic-password', '-s', service] }]));
}

export const keychainCredentials = {
  // `secret: false` reads attributes only, which never touches the stored data
  // and so never raises the macOS access prompt — that is what makes detection
  // silent for people who have no Claude Code login at all. `secret: true` adds
  // `-w` and is the call that can prompt.
  async find(lookups, { secret = false } = {}) {
    let failure = '';

    for (const lookup of lookups) {
      const result = await runSecurity(secret ? [...lookup.args, '-w'] : lookup.args);

      if (result.found) {
        return { found: true, value: result.value, service: lookup.service };
      }

      if (result.error && !failure) {
        failure = result.error;
      }
    }

    return { found: false, error: failure };
  },
};

// `security` prints the secret as hex (sometimes `0x`-prefixed) whenever the
// stored blob is not plain text, which turns an otherwise healthy item into an
// unparseable one. Decode that form before giving up.
export function parseKeychainCredentials(raw) {
  const direct = parseJson(raw);

  if (direct) {
    return direct;
  }

  const hex = String(raw || '').trim().replace(/^0x/i, '');

  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }

  return parseJson(Buffer.from(hex, 'hex').toString('utf8'));
}

// Accounts: the system key is auto-detected from Claude Code's credentials
// file — or, on macOS, its Keychain item — re-read on every refresh because
// Claude Code rotates the token; manual keys come from CLAUDE_CODE_OAUTH_TOKEN
// or CLAUDE_TOKEN_1..N in .env.
export async function readClaudeAccounts(env, { osPlatform = platform(), keychain = keychainCredentials } = {}) {
  const accounts = [];
  const configDir = claudeConfigDir(env);
  const disableSystem = /^(1|true|yes)$/i.test(env.CLAUDE_DISABLE_SYSTEM_KEY || '');
  const disableKeychain = /^(1|true|yes)$/i.test(env.CLAUDE_DISABLE_KEYCHAIN || '');

  if (!disableSystem) {
    const credentialsPath = join(configDir, '.credentials.json');
    const sources = [];

    // Keychain before file: on macOS the Keychain is Claude Code's source of
    // truth, and a re-login there can leave a stale .credentials.json behind
    // that would otherwise shadow the live token with an expired one. The file
    // stays as a fallback, and resolution falls through to it whenever the
    // Keychain cannot produce a usable token.
    if (osPlatform === 'darwin' && !disableKeychain) {
      const lookups = keychainLookups(env);
      const probe = await keychain.find(lookups);

      // A failed probe still counts: a locked keychain or a denied prompt is a
      // credential that exists but could not be read, and saying so beats
      // silently reporting the whole provider as undetected.
      if (probe.found || probe.error) {
        sources.push({
          kind: 'keychain',
          service: probe.service || lookups[0].service,
          read: () => keychain.find(lookups, { secret: true }),
        });
      }
    }

    if (await access(credentialsPath).then(() => true, () => false)) {
      sources.push({ kind: 'file', credentialsPath });
    }

    if (sources.length > 0) {
      accounts.push({
        name: env.CLAUDE_SYSTEM_NAME || 'system',
        source: 'system',
        storage: sources[0].kind,
        sources,
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

// Reads one credential source into { raw, parsed, oauth } — or into a
// user-facing `error` explaining why it could not be used, so the caller can
// try the next source and still report something actionable if none work.
async function loadCredentialSource(source) {
  if (source.kind === 'keychain') {
    const result = await source.read().catch((error) => ({ found: false, error: error.message }));

    if (!result.found) {
      return {
        error: result.error
          ? `cannot read the login Keychain: ${result.error}`
          : `no Claude Code item in the login Keychain — run \`claude\` and /login`,
      };
    }

    const parsed = parseKeychainCredentials(result.value);
    const oauth = parsed?.claudeAiOauth;

    return oauth?.accessToken
      ? { raw: result.value, parsed, oauth }
      : { error: `Keychain item "${result.service || source.service}" has no accessToken — run \`claude\` and /login` };
  }

  let raw;

  try {
    raw = await readFile(source.credentialsPath, 'utf8');
  } catch (error) {
    return { error: `cannot read credentials: ${error.message}` };
  }

  const parsed = parseJson(raw);
  const oauth = parsed?.claudeAiOauth;

  return oauth?.accessToken
    ? { raw, parsed, oauth }
    : { error: 'no accessToken in .credentials.json — run `claude` and /login' };
}

function isExpired(oauth, now) {
  return Number.isFinite(oauth.expiresAt) && oauth.expiresAt < now;
}

async function resolveCredentials(account, readOnly = false, now = Date.now()) {
  if (account.source === 'manual') {
    return { token: account.token, plan: '', expiresAt: null, refresh: null, readOnly, storage: 'env' };
  }

  const problems = [];
  const candidates = [];

  for (const source of account.sources) {
    const loaded = await loadCredentialSource(source);

    if (loaded.oauth) {
      candidates.push({ ...loaded, source });
    } else if (loaded.error) {
      problems.push(loaded.error);
    }
  }

  if (candidates.length === 0) {
    throw new Error(problems[0] || 'no Claude Code credentials found — run `claude` and /login');
  }

  // Fixed source order decides the winner; expiry only skips candidates that
  // are already dead. Ranking by expiry instead would let a stale file outrank
  // a live Keychain just because its token happens to expire later.
  const { raw, parsed, oauth, source } = candidates.find((entry) => !isExpired(entry.oauth, now)) || candidates[0];
  const fromKeychain = source.kind === 'keychain';
  const credentialState = { raw, parsed, oauth };

  return {
    token: oauth.accessToken,
    plan: [oauth.subscriptionType, (oauth.rateLimitTier || '').replace(/^default_/, '')].filter(Boolean).join(' / '),
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    // Keychain credentials are read-only: redeeming the refresh token can
    // rotate it, and tokensleft will not write the replacement back into the
    // user's Keychain — losing that rotation would log them out of Claude Code.
    refresh: oauth.refreshToken && !readOnly && !fromKeychain
      ? () => refreshOAuthToken(source.credentialsPath, credentialState)
      : null,
    readOnly,
    storage: source.kind,
  };
}

// Redeems the refresh token and persists the rotated credentials back to the
// file, exactly as Claude Code itself would (minified JSON, other keys kept).
// Returns the new access token, null on soft failure, throws a user-facing
// string when the refresh token itself is dead (re-login required).
async function refreshOAuthToken(credentialsPath, credentialState) {
  const { parsed, oauth } = credentialState;
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
  const serialized = JSON.stringify(parsed);

  try {
    await writeFileAtomic(credentialsPath, serialized, { expectedContent: credentialState.raw });
  } catch (error) {
    throw new Error(`OAuth token refreshed but could not safely update Claude credentials: ${error.message}`);
  }

  credentialState.raw = serialized;
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

function expiredTokenMessage({ readOnly, storage }) {
  if (storage === 'keychain') {
    return 'OAuth token expired. tokensleft never writes to the macOS Keychain — run any prompt in Claude Code, or /login again.';
  }

  return readOnly
    ? 'OAuth token expired in read-only mode. Run any prompt in Claude Code, or /login again.'
    : 'OAuth token expired and no refresh token available. Run any prompt in Claude Code, or /login again.';
}

async function fetchAccountUsage(account, seenTokens, readOnly = false) {
  const startedAt = Date.now();
  let credentials;

  try {
    credentials = await resolveCredentials(account, readOnly);
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
      error: expiredTokenMessage(credentials),
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
    const retryAfter = response.headers.get('retry-after');
    return {
      name: account.name,
      source: account.source,
      plan: credentials.plan,
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      body: text.slice(0, 300),
      retryAfterAt: response.status === 429
        ? resolveRetryAfterAt(retryAfter)
        : parseRetryAfterDate(retryAfter),
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

export function isZaiModel(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');

  return /^(?:glm(?:[-_.]|$)|(?:zai|z-ai|zhipuai)\/+glm(?:[-_.]|$))/.test(normalized);
}

// Maps a transcript event to the canonical usage-event shape, pricing it at
// public API rates (cache read = 0.1x input, cache write 5m = 1.25x, 1h = 2x).
function toClaudeUsage(event) {
  return {
    model: event.model,
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead,
    cacheWrite: event.cache5m + event.cache1h,
    cost: calculateModelCost(event.model, {
      input: event.input,
      output: event.output,
      cacheRead: event.cacheRead,
      cacheWrite5m: event.cache5m,
      cacheWrite1h: event.cache1h,
      totalInput: event.input + event.cacheRead + event.cache5m + event.cache1h,
    }),
  };
}

// Incremental scanner over ~/.claude/projects/**/*.jsonl transcripts —
// recursive, so subagent transcripts (projects/<slug>/<session>/subagents/…)
// count too.
export function createTranscriptScanner(configDir, { includeModel = () => true } = {}) {
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
    refreshFile: jsonlRefresher((text) => {
      const parsed = parseTranscriptChunk(text);
      return {
        ...parsed,
        events: parsed.events.filter((event) => includeModel(event.model)),
      };
    }),
    toUsage: toClaudeUsage,
  });
}

// --- rendering -------------------------------------------------------------------

function renderAccountBlock(result, width, mode = 'detail') {
  const compact = mode === 'compact';
  const status = result.ok
    ? `{${COLOR.success}-fg}{bold}OK{/bold}{/${COLOR.success}-fg}`
    : `{${COLOR.danger}-fg}{bold}${escapeBlessed(String(result.status))}{/bold}{/${COLOR.danger}-fg}`;
  const metaParts = compact
    ? [result.plan, result.spend ? `spend ${result.spend}` : '']
    : [result.plan, result.source, `${result.ms}ms`];
  const meta = metaParts.filter(Boolean).join(' · ');
  const lines = [
    `{${COLOR.accentSoft}-fg}{bold}${escapeBlessed(result.name)}{/bold}{/${COLOR.accentSoft}-fg}  ${status}  {${COLOR.muted}-fg}${escapeBlessed(meta)}{/${COLOR.muted}-fg}`,
  ];

  if (!result.ok) {
    lines.push(`  {${COLOR.danger}-fg}${escapeBlessed(result.error || 'unknown error')}{/${COLOR.danger}-fg}`);

    if (result.body && !compact) {
      lines.push(`  {${COLOR.muted}-fg}${escapeBlessed(result.body)}{/${COLOR.muted}-fg}`);
    }

    if (result.retryAfterAt) {
      const exactTime = compact ? '' : ` · at ${formatDateTime(result.retryAfterAt)}`;
      lines.push(`  {${COLOR.warning}-fg}retry ${escapeBlessed(formatCountdown(result.retryAfterAt))}${escapeBlessed(exactTime)}{/${COLOR.warning}-fg}`);
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

const LOCAL_ONLY_NOTE = 'No account credentials — local usage only; run `claude` and /login for quotas.';

export const CLAUDE_LOCAL_OPTS = {
  source: 'transcripts',
  shorten: (model) => model.replace(/^claude-/, '').replace(/-\d{8}$/, ''),
  tone: (model) => /fable|mythos/.test(model) ? 'magenta' : /opus/.test(model) ? 'yellow' : 'white',
};

// Full provider view: one block per account, plus the local-usage section in
// the detail view (`d`). Shared with the demo provider (lib/demo.js).
export function renderClaudeSnapshot(snapshot, width, mode = 'detail') {
  if (snapshot.fatal) {
    return `  {${COLOR.danger}-fg}${escapeBlessed(snapshot.fatal)}{/${COLOR.danger}-fg}`;
  }

  const compact = mode === 'compact';
  const sections = snapshot.results
    .filter((result) => result.status !== 'DUP')
    .map((result) => renderAccountBlock(result, width, mode));

  // Local-usage-only mode: transcripts on disk but no usable credentials, so
  // say why the quota bars are missing instead of rendering an empty panel.
  if (sections.length === 0) {
    sections.push(truncateTagged(
      `  {${COLOR.warning}-fg}${escapeBlessed(LOCAL_ONLY_NOTE)}{/${COLOR.warning}-fg}`,
      width,
    ));
  }

  if (!compact) {
    sections.push(renderLocalUsage(snapshot.local, { ...CLAUDE_LOCAL_OPTS, width }));
  }

  return sections.join(compact ? '\n' : '\n\n');
}

// --- provider ---------------------------------------------------------------------

export async function createClaudeProvider(env, options = {}) {
  const accounts = await readClaudeAccounts(env, options);
  const scanner = createTranscriptScanner(claudeConfigDir(env), {
    includeModel: (model) => !isZaiModel(model),
  });

  // No credentials is not the same as nothing to show: the transcripts on disk
  // are a full local usage history. Keep the provider alive whenever they hold
  // real usage (Keychain access denied, logged out, CLAUDE_DISABLE_SYSTEM_KEY);
  // the scan is cached, so the first fetch reuses this work.
  if (accounts.length === 0) {
    const local = await scanner.scan().catch(() => ({ ok: false, models: [] }));

    if (!local.ok || local.models.length === 0) {
      return null;
    }
  }

  const readOnly = /^(1|true|yes)$/i.test(env.TOKENSLEFT_READ_ONLY || '');

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
        results.push(await fetchAccountUsage(account, seenTokens, readOnly));
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

      if (counted.length === 0) {
        return { ok: true, text: 'LOCAL' };
      }

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
        resetAt: item.resetAt,
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

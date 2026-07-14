import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed } from '../lib/format.js';
import { parseJson } from '../lib/http.js';
import { writeFileAtomic } from '../lib/fsx.js';
import { createLocalUsageScanner, jsonlRefresher } from '../lib/local-usage.js';
import { renderSingleAccount } from './codex.js';

const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const PROJECTS_URL = 'https://cloudresourcemanager.googleapis.com/v1/projects';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DAY_PERIOD_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

// Gemini CLI's public OAuth client. These are "installed application"
// credentials, published in the gemini-cli source (the upstream comment
// explicitly notes the client secret is not treated as a secret for this
// client type). Used only to redeem the refresh token already on disk.
const FALLBACK_CLIENT = {
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
};

const IDE_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
  duetProject: 'default',
};

function geminiDir(env) {
  return env.GEMINI_CLI_HOME || join(homedir(), '.gemini');
}

function oauth2JsCandidates() {
  const home = homedir();
  const roots = [
    join(process.env.APPDATA || '', 'npm', 'node_modules'),
    'C:/Program Files/nodejs/node_modules',
    join(home, '.bun', 'install', 'global', 'node_modules'),
    join(home, '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ];
  const suffix = ['dist', 'src', 'code_assist', 'oauth2.js'];

  return roots.flatMap((root) => [
    join(root, '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', ...suffix),
    join(root, '@google', 'gemini-cli-core', ...suffix),
  ]);
}

export function parseOauthClientCreds(text) {
  const idMatch = String(text).match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
  const secretMatch = String(text).match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);

  if (!idMatch || !secretMatch) {
    return null;
  }

  return { clientId: idMatch[1], clientSecret: secretMatch[1] };
}

// Prefer the client credentials of the locally installed gemini-cli (they
// would track upstream rotations); fall back to the published constants.
async function loadOauthClientCreds() {
  for (const candidate of oauth2JsCandidates()) {
    const text = await readFile(candidate, 'utf8').catch(() => '');
    const creds = text && parseOauthClientCreds(text);

    if (creds) {
      return creds;
    }
  }

  return FALLBACK_CLIENT;
}

async function loadSettingsAuthType(dir) {
  const raw = await readFile(join(dir, 'settings.json'), 'utf8').catch(() => '');
  const settings = parseJson(raw);
  return (settings?.authType || settings?.security?.auth?.selectedType || '').trim().toLowerCase();
}

export function credsNeedRefresh(creds, now = Date.now()) {
  if (!creds.access_token) {
    return true;
  }

  const expiry = Number(creds.expiry_date);

  if (!Number.isFinite(expiry)) {
    return false;
  }

  const expiryMs = expiry > 10_000_000_000 ? expiry : expiry * 1000;
  return now + TOKEN_REFRESH_BUFFER_MS >= expiryMs;
}

async function refreshCreds(credsPath, creds) {
  if (!creds.refresh_token) {
    return null;
  }

  const client = await loadOauthClientCreds();
  let response;

  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }

  const body = parseJson(await response.text());

  if (response.status === 400 || response.status === 401) {
    const code = body?.error || response.status;
    throw `token refresh rejected (${code}) — run \`gemini\` and sign in again`;
  }

  if (!response.ok || !body?.access_token) {
    return null;
  }

  creds.access_token = body.access_token;

  if (body.id_token) {
    creds.id_token = body.id_token;
  }

  if (body.refresh_token) {
    creds.refresh_token = body.refresh_token;
  }

  if (typeof body.expires_in === 'number') {
    creds.expiry_date = Date.now() + body.expires_in * 1000;
  }

  await writeFileAtomic(credsPath, JSON.stringify(creds, null, 2)).catch(() => {});
  return creds.access_token;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length < 2) {
    return null;
  }

  try {
    return parseJson(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function readFirstStringDeep(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nested of Object.values(value)) {
    const found = readFirstStringDeep(nested, keys, depth + 1);

    if (found) {
      return found;
    }
  }

  return null;
}

export function mapTierToPlan(tier, idTokenPayload) {
  const normalized = String(tier || '').trim().toLowerCase();

  if (normalized === 'standard-tier') {
    return 'Paid';
  }

  if (normalized === 'legacy-tier') {
    return 'Legacy';
  }

  if (normalized === 'free-tier') {
    return idTokenPayload?.hd ? 'Workspace' : 'Free';
  }

  return '';
}

export function collectQuotaBuckets(value, out = [], depth = 0) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectQuotaBuckets(entry, out, depth + 1);
    }

    return out;
  }

  if (!value || typeof value !== 'object' || depth > 8) {
    return out;
  }

  if (typeof value.remainingFraction === 'number') {
    out.push({
      modelId: value.modelId || value.model_id || 'unknown',
      remainingFraction: value.remainingFraction,
      resetTime: value.resetTime || value.reset_time || null,
    });
  }

  for (const nested of Object.values(value)) {
    collectQuotaBuckets(nested, out, depth + 1);
  }

  return out;
}

export function buildGeminiItems(quotaData, { prefix = 'gemini', now = Date.now() } = {}) {
  const buckets = collectQuotaBuckets(quotaData);
  const groups = [
    { key: 'pro', label: 'Pro', match: (id) => id.includes('gemini') && id.includes('pro') },
    { key: 'flash', label: 'Flash', match: (id) => id.includes('gemini') && id.includes('flash') },
  ];
  const items = [];

  for (const group of groups) {
    const candidates = buckets.filter((bucket) => group.match(String(bucket.modelId).toLowerCase()));
    let lowest = null;

    for (const bucket of candidates) {
      if (!Number.isFinite(bucket.remainingFraction)) {
        continue;
      }

      if (!lowest || bucket.remainingFraction < lowest.remainingFraction) {
        lowest = bucket;
      }
    }

    if (!lowest) {
      continue;
    }

    const remaining = Math.max(0, Math.min(1, lowest.remainingFraction));
    // exhausted buckets sometimes report an epoch-zero resetTime — drop it
    const resetAt = toDate(lowest.resetTime);
    const validReset = resetAt && resetAt.getTime() > now - DAY_PERIOD_MS ? resetAt : null;

    items.push(buildUsageItem({
      key: `${prefix}:${group.key}`,
      label: group.label,
      percent: (1 - remaining) * 100,
      resetAt: validReset,
      periodMs: DAY_PERIOD_MS,
      now,
    }));
  }

  return items;
}

function postJson(url, accessToken, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
}

async function discoverProjectId(accessToken, loadCodeAssistData) {
  const fromAssist = readFirstStringDeep(loadCodeAssistData, ['cloudaicompanionProject']);

  if (fromAssist) {
    return fromAssist;
  }

  let response;

  try {
    response = await fetch(PROJECTS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const projects = parseJson(await response.text())?.projects;

  if (!Array.isArray(projects)) {
    return null;
  }

  for (const project of projects) {
    const projectId = typeof project?.projectId === 'string' ? project.projectId : null;

    if (!projectId) {
      continue;
    }

    if (projectId.startsWith('gen-lang-client') || project.labels?.['generative-language'] !== undefined) {
      return projectId;
    }
  }

  return null;
}

// --- local session-log aggregation ------------------------------------------------

// USD per 1M tokens at public API rates (pro models are tiered by prompt
// size — this is the ≤200k-token tier). Thinking tokens bill at output rate.
export const MODEL_PRICING = [
  { match: /^gemini-3(\.\d+)?-flash-lite/, input: 0.25, cachedInput: 0.025, output: 1.5 },
  { match: /^gemini-3\.5-flash/, input: 1.5, cachedInput: 0.15, output: 9 },
  { match: /^gemini-3(\.\d+)?-pro/, input: 2, cachedInput: 0.2, output: 12 },
  { match: /^gemini-3(\.\d+)?-flash/, input: 0.5, cachedInput: 0.05, output: 3 },
  { match: /^gemini-2\.5-pro/, input: 1.25, cachedInput: 0.125, output: 10 },
  { match: /^gemini-2\.5-flash-lite/, input: 0.1, cachedInput: 0.01, output: 0.4 },
  { match: /^gemini-2\.5-flash/, input: 0.3, cachedInput: 0.03, output: 2.5 },
];

// Gemini CLI checkpoints each session to tmp/<project>/chats/ — monolithic
// session-*.json up to v0.38, one-record-per-line *.jsonl since v0.39; every
// model response records its token counts (one API request each, mirroring
// usageMetadata). `input` includes the cached tokens; `thoughts` (billed as
// output) and `tool` (billed as input) are tracked separately.
function toChatEvent(message) {
  const tokens = message?.tokens;

  if (message?.type !== 'gemini' || !tokens || typeof message.model !== 'string' || !message.model) {
    return null;
  }

  const t = Date.parse(message.timestamp || '');

  if (!Number.isFinite(t)) {
    return null;
  }

  return {
    t,
    id: message.id || '',
    model: message.model,
    input: tokens.input || 0,
    output: tokens.output || 0,
    cached: tokens.cached || 0,
    thoughts: tokens.thoughts || 0,
    tool: tokens.tool || 0,
  };
}

export function parseChatMessages(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return messages.map(toChatEvent).filter(Boolean);
}

// JSONL chats stream message records; a repeated message id is an update
// (tokens are often attached by re-appending the message), so records merge
// last-wins by id. `$set`/`$rewindTo` control records parse to no event —
// correctly so for usage: rewound-away responses still consumed tokens.
export function parseChatJsonlChunk(text, state) {
  const lines = String(text).split('\n');
  const remainder = text.endsWith('\n') ? '' : lines.pop() ?? '';

  for (const line of lines) {
    if (!line || !line.includes('"tokens"')) {
      continue;
    }

    const event = toChatEvent(parseJson(line));

    if (event) {
      state.byId.set(event.id || `line-${state.seq += 1}`, event);
    }
  }

  return { events: [], remainder };
}

function toGeminiUsage(event) {
  const pricing = MODEL_PRICING.find((entry) => entry.match.test(event.model)) || null;
  const input = Math.max(0, event.input - event.cached) + event.tool;
  const output = event.output + event.thoughts;

  return {
    model: event.model,
    input,
    output,
    cacheRead: event.cached,
    cacheWrite: 0,
    cost: pricing
      ? (input * pricing.input + event.cached * pricing.cachedInput + output * pricing.output) / 1e6
      : null,
  };
}

// Scanner over ~/.gemini/tmp/*/chats/**/*.{json,jsonl} (subagent .jsonl files
// nest under the parent session's dir). Legacy .json files are rewritten in
// place as the conversation grows, so a changed one is re-parsed whole; .jsonl
// files append and are read incrementally. Message ids dedupe overlaps (a
// `/chat save` copy or a .json checkpoint migrated to .jsonl on resume).
export function createChatScanner(dir) {
  const tmpDir = join(dir, 'tmp');
  const refreshChatJsonl = jsonlRefresher(parseChatJsonlChunk);

  const listFiles = async () => {
    let projects;

    try {
      projects = await readdir(tmpDir);
    } catch {
      throw new Error(`no session logs at ${tmpDir}`);
    }

    const paths = [];

    for (const project of projects) {
      const chatsDir = join(tmpDir, project, 'chats');
      const entries = await readdir(chatsDir, { recursive: true }).catch(() => []);

      for (const entry of entries) {
        if (entry.endsWith('.json') || entry.endsWith('.jsonl')) {
          paths.push(join(chatsDir, entry));
        }
      }
    }

    return paths;
  };

  return createLocalUsageScanner({
    listFiles,
    initState: () => ({ byId: new Map(), seq: 0 }),

    async refreshFile(filePath, info, cached) {
      if (filePath.endsWith('.jsonl')) {
        await refreshChatJsonl(filePath, info, cached);
        cached.events = [...cached.state.byId.values()];
        return;
      }

      if (cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        return;
      }

      cached.size = info.size;
      cached.mtimeMs = info.mtimeMs;
      cached.events = parseChatMessages(parseJson(await readFile(filePath, 'utf8')));
    },

    toUsage: toGeminiUsage,
  });
}

export const GEMINI_LOCAL_OPTS = {
  source: 'sessions',
  tone: (model) => /pro/.test(model) ? 'magenta' : 'white',
};

async function fetchGeminiQuota(dir, credsPath) {
  const startedAt = Date.now();
  const authType = await loadSettingsAuthType(dir);

  if (authType && authType !== 'oauth-personal') {
    return { ok: false, status: 'AUTH', error: `Gemini auth type "${authType}" is not supported (oauth-personal only).`, ms: Date.now() - startedAt, items: [] };
  }

  const creds = parseJson(await readFile(credsPath, 'utf8').catch(() => ''));

  if (!creds?.access_token && !creds?.refresh_token) {
    return { ok: false, status: 'CRED', error: 'Not logged in. Run `gemini` and sign in.', ms: Date.now() - startedAt, items: [] };
  }

  let token = creds.access_token;

  if (credsNeedRefresh(creds)) {
    try {
      const refreshed = await refreshCreds(credsPath, creds);

      if (refreshed) {
        token = refreshed;
      } else if (!token) {
        return { ok: false, status: 'CRED', error: 'Not logged in. Run `gemini` and sign in.', ms: Date.now() - startedAt, items: [] };
      }
    } catch (message) {
      return { ok: false, status: 'EXPIRED', error: String(message), ms: Date.now() - startedAt, items: [] };
    }
  }

  const callWithRetry = async (makeRequest) => {
    let response = await makeRequest(token);

    if (response.status === 401 || response.status === 403) {
      const refreshed = await refreshCreds(credsPath, creds);

      if (refreshed) {
        token = refreshed;
        response = await makeRequest(token);
      }
    }

    return response;
  };

  try {
    const assistResponse = await callWithRetry((bearer) => postJson(LOAD_CODE_ASSIST_URL, bearer, { metadata: IDE_METADATA }));
    const assistData = assistResponse.ok ? parseJson(await assistResponse.text()) : null;

    if (assistResponse.status === 401 || assistResponse.status === 403) {
      return { ok: false, status: assistResponse.status, error: 'Gemini session expired. Run `gemini` and sign in again.', ms: Date.now() - startedAt, items: [] };
    }

    const idTokenPayload = decodeJwtPayload(creds.id_token);
    const tier = readFirstStringDeep(assistData, ['tier', 'userTier', 'subscriptionTier', 'currentTier', 'id']);
    const projectId = await discoverProjectId(token, assistData);
    const quotaResponse = await callWithRetry((bearer) => postJson(QUOTA_URL, bearer, projectId ? { project: projectId } : {}));
    const quotaText = await quotaResponse.text();
    const ms = Date.now() - startedAt;

    if (quotaResponse.status === 401 || quotaResponse.status === 403) {
      return { ok: false, status: quotaResponse.status, error: 'Gemini session expired. Run `gemini` and sign in again.', ms, items: [] };
    }

    if (!quotaResponse.ok) {
      return { ok: false, status: quotaResponse.status, error: `quota request failed (HTTP ${quotaResponse.status})`, body: quotaText.slice(0, 300), ms, items: [] };
    }

    const quotaData = parseJson(quotaText);

    if (!quotaData) {
      return { ok: false, status: 'ERR', error: 'quota response invalid', ms, items: [] };
    }

    const items = buildGeminiItems(quotaData);
    const email = typeof idTokenPayload?.email === 'string' ? idTokenPayload.email : '';

    return {
      ok: true,
      ms,
      plan: mapTierToPlan(tier, idTokenPayload),
      email, // shown only in the detail view (see renderSingleAccount)
      items,
    };
  } catch (error) {
    const message = typeof error === 'string' ? error : `request failed: ${error.message}`;
    return { ok: false, status: typeof error === 'string' ? 'EXPIRED' : 'ERR', error: message, ms: Date.now() - startedAt, items: [] };
  }
}

export async function createGeminiProvider(env) {
  const dir = geminiDir(env);
  const credsPath = join(dir, 'oauth_creds.json');

  if (!await access(credsPath).then(() => true, () => false)) {
    return null;
  }

  const scanner = createChatScanner(dir);

  return {
    id: 'gemini',
    title: 'Gemini',
    refreshMs: readRefreshMs(env, ['GEMINI_REFRESH_SECONDS', 'GEMINI_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const [local, snapshot] = await Promise.all([
        scanner.scan().catch((error) => ({ ok: false, error: error.message, models: [] })),
        fetchGeminiQuota(dir, credsPath),
      ]);
      snapshot.local = local;
      return snapshot;
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'gemini', GEMINI_LOCAL_OPTS);
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

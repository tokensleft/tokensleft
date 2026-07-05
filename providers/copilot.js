import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { parseJson } from '../lib/http.js';
import { renderSingleAccount } from './codex.js';

const USAGE_URL = 'https://api.github.com/copilot_internal/user';
const MONTH_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

// Token sources, most specific first: explicit env keys, Copilot's own
// credential files (apps.json / hosts.json), then the gh CLI's hosts.yml
// (present when gh uses plain-file storage instead of the OS keyring).
export async function findCopilotToken(env) {
  for (const key of ['COPILOT_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (env[key]?.trim()) {
      return { token: env[key].trim(), source: key };
    }
  }

  const home = homedir();
  const copilotDirs = [
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'github-copilot'),
    join(home, '.config', 'github-copilot'),
  ];

  for (const dir of copilotDirs) {
    for (const file of ['apps.json', 'hosts.json']) {
      const parsed = parseJson(await readFile(join(dir, file), 'utf8').catch(() => ''));

      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      for (const [host, entry] of Object.entries(parsed)) {
        if (host.startsWith('github.com') && typeof entry?.oauth_token === 'string' && entry.oauth_token.trim()) {
          return { token: entry.oauth_token.trim(), source: `${file}` };
        }
      }
    }
  }

  const ghHostsFiles = [
    join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'GitHub CLI', 'hosts.yml'),
    join(home, '.config', 'gh', 'hosts.yml'),
  ];

  for (const file of ghHostsFiles) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const match = text.match(/oauth_token:\s*(\S+)/);

    if (match) {
      return { token: match[1], source: 'gh hosts.yml' };
    }
  }

  return null;
}

export function buildCopilotItems(data, { prefix = 'copilot', now = Date.now() } = {}) {
  const items = [];
  const resetAt = toDate(data?.quota_reset_date);
  const snapshots = data?.quota_snapshots;

  const pushSnapshot = (label, key, snapshot) => {
    if (!snapshot || snapshot.unlimited === true || typeof snapshot.percent_remaining !== 'number') {
      return;
    }

    items.push(buildUsageItem({
      key: `${prefix}:${key}`,
      label,
      percent: Math.min(100, Math.max(0, 100 - snapshot.percent_remaining)),
      resetAt,
      periodMs: MONTH_PERIOD_MS,
      now,
    }));
  };

  pushSnapshot('Premium', 'premium', snapshots?.premium_interactions);
  pushSnapshot('Chat', 'chat', snapshots?.chat);

  // Free tier reports remaining counts instead of percent snapshots.
  if (data?.limited_user_quotas && data?.monthly_quotas) {
    const freeResetAt = toDate(data.limited_user_reset_date);
    const pushLimited = (label, key, remaining, total) => {
      if (typeof remaining !== 'number' || typeof total !== 'number' || total <= 0) {
        return;
      }

      items.push(buildUsageItem({
        key: `${prefix}:${key}`,
        label,
        value: `${Math.round((total - remaining) / total * 100)}% (${total - remaining}/${total})`,
        percent: Math.min(100, Math.max(0, ((total - remaining) / total) * 100)),
        resetAt: freeResetAt,
        periodMs: MONTH_PERIOD_MS,
        now,
      }));
    };

    pushLimited('Chat', 'free-chat', data.limited_user_quotas.chat, data.monthly_quotas.chat);
    pushLimited('Completions', 'free-completions', data.limited_user_quotas.completions, data.monthly_quotas.completions);
  }

  return items;
}

export async function createCopilotProvider(env) {
  const credential = await findCopilotToken(env);

  if (!credential) {
    return null;
  }

  return {
    id: 'copilot',
    title: 'Copilot',
    refreshMs: readRefreshMs(env, ['COPILOT_REFRESH_SECONDS', 'COPILOT_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();
      // Re-resolve every refresh so a re-login (new token on disk) is picked up.
      const current = await findCopilotToken(env) || credential;
      let response;

      try {
        response = await fetch(USAGE_URL, {
          headers: {
            Authorization: `token ${current.token}`,
            Accept: 'application/json',
            'Editor-Version': 'vscode/1.96.2',
            'Editor-Plugin-Version': 'copilot-chat/0.26.7',
            'User-Agent': 'GitHubCopilotChat/0.26.7',
            'X-Github-Api-Version': '2025-04-01',
          },
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return { ok: false, status: 'ERR', error: `request failed: ${error.message}`, ms: Date.now() - startedAt, items: [] };
      }

      const text = await response.text();
      const ms = Date.now() - startedAt;

      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, error: `GitHub token invalid (source: ${current.source}). Run \`gh auth login\` or refresh Copilot login.`, ms, items: [] };
      }

      const data = parseJson(text);

      if (!response.ok || !data) {
        return { ok: false, status: response.status, error: `HTTP ${response.status}`, body: text.slice(0, 300), ms, items: [] };
      }

      return {
        ok: true,
        ms,
        plan: data.copilot_plan || '',
        items: buildCopilotItems(data),
      };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'copilot');
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

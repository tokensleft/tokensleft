import { claudeConfigDir, discoverClaudeSettingsKeys, matchesHost } from '../lib/claude-settings.js';
import { readRefreshMs, splitCsv } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { escapeBlessed, formatNumber, jsonPreview, maskKey } from '../lib/format.js';
import { fetchJsonResult } from '../lib/http.js';
import { renderLocalUsage } from '../lib/local-usage.js';
import { COLOR } from '../lib/palette.js';
import { formatUsageItem, formatUsageItemCompact } from '../lib/render.js';
import { createTranscriptScanner, isZaiModel } from './claude.js';

const BASE_URL = 'https://api.z.ai';
const SUBSCRIPTION_URL = `${BASE_URL}/api/biz/subscription/list`;
const QUOTA_URL = `${BASE_URL}/api/monitor/usage/quota/limit`;
const SESSION_PERIOD_MS = 5 * 60 * 60 * 1000;
const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 60 * 1000;

function addZaiDisplayNames(accounts) {
  const multiple = accounts.length > 1;

  return accounts.map((account, index) => ({
    ...account,
    name: account.name || (multiple ? `Account ${index + 1}` : ''),
  }));
}

export function readZaiAccounts(env) {
  const accounts = [];

  for (let index = 1; ; index += 1) {
    const key = env[`ZAI_KEY_${index}`] || env[`ZAI_API_KEY_${index}`] || env[`GLM_API_KEY_${index}`];

    if (!key) {
      break;
    }

    accounts.push({
      name: env[`ZAI_NAME_${index}`] || '',
      key,
      proxy: env[`ZAI_PROXY_${index}`] || '',
    });
  }

  if (accounts.length > 0) {
    return addZaiDisplayNames(accounts);
  }

  const singleKey = env.ZAI_API_KEY || env.ZAI_KEY || env.GLM_API_KEY;

  if (singleKey) {
    return [{
      name: env.ZAI_NAME || '',
      key: singleKey,
      proxy: env.ZAI_PROXY || '',
    }];
  }

  const keys = splitCsv(env.ZAI_KEYS || env.ZAI_API_KEYS || env.GLM_API_KEYS || '').filter(Boolean);
  const proxies = splitCsv(env.ZAI_PROXIES || '');

  return addZaiDisplayNames(keys.map((key, index) => ({
    name: '',
    key,
    proxy: proxies[index] || '',
  })));
}

export function getPlanName(subscription) {
  const list = subscription?.data;

  if (Array.isArray(list) && list.length > 0) {
    return list[0]?.productName || list[0]?.name || '';
  }

  return subscription?.data?.productName || subscription?.productName || '';
}

// Keep proxy credentials out of snapshots, TUI output, and --json. Only the
// scheme and network address are useful diagnostics; paths, query strings,
// and userinfo can all contain secrets.
export function displayProxy(proxy) {
  if (!proxy) {
    return 'direct';
  }

  try {
    const parsed = new URL(proxy);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : 'configured proxy';
  } catch {
    return 'configured proxy';
  }
}

export function findLimit(limits, type, unit) {
  let fallback = null;

  for (const item of limits) {
    if (item.type !== type && item.name !== type) {
      continue;
    }

    if (unit === undefined || item.unit === unit) {
      return item;
    }

    if (fallback === null && item.unit === undefined) {
      fallback = item;
    }
  }

  return fallback;
}

export function buildZaiItems(quota, { prefix = 'zai', now = Date.now() } = {}) {
  const container = quota?.data || quota;
  const limits = Array.isArray(container?.limits) ? container.limits : Array.isArray(container) ? container : [];

  if (limits.length === 0) {
    return [{ kind: 'empty', key: `${prefix}:none`, label: 'Quota', message: 'no usage data' }];
  }

  const items = [];
  const session = findLimit(limits, 'TOKENS_LIMIT', 3);
  const weekly = findLimit(limits, 'TOKENS_LIMIT', 6);
  const webSearches = findLimit(limits, 'TIME_LIMIT');

  if (session) {
    items.push(percentItem('Session', `${prefix}:session`, session, SESSION_PERIOD_MS, now));
  }

  if (weekly) {
    items.push(percentItem('Weekly', `${prefix}:weekly`, weekly, WEEKLY_PERIOD_MS, now));
  }

  if (webSearches) {
    items.push(countItem('Web Searches', `${prefix}:web`, webSearches, MONTHLY_PERIOD_MS, now));
  }

  return items.length > 0 ? items : [{ kind: 'empty', key: `${prefix}:none`, label: 'Quota', message: 'no usage data' }];
}

function percentItem(label, key, limit, periodMs, now) {
  const percent = Number.isFinite(limit.percentage) ? limit.percentage : 0;
  const hasValue = Number.isFinite(limit.currentValue) && Number.isFinite(limit.usage);
  const value = hasValue
    ? `${Math.round(percent)}% (${formatNumber(limit.currentValue)}/${formatNumber(limit.usage)})`
    : `${Math.round(percent)}%`;

  return buildUsageItem({
    key,
    label,
    value,
    percent,
    resetAt: toDate(limit.nextResetTime),
    periodMs,
    now,
  });
}

function countItem(label, key, limit, periodMs, now) {
  const used = Number.isFinite(limit.currentValue) ? limit.currentValue : 0;
  const max = Number.isFinite(limit.usage) ? limit.usage : 0;
  const percent = Number.isFinite(limit.percentage)
    ? limit.percentage
    : max > 0
      ? (used / max) * 100
      : 0;
  const details = Array.isArray(limit.usageDetails)
    ? limit.usageDetails.map((detail) => ({
      label: detail.modelCode || 'detail',
      value: formatNumber(detail.usage),
    }))
    : [];

  return buildUsageItem({
    key,
    label,
    value: `${formatNumber(used)}/${formatNumber(max)} ${Math.round(percent)}%`,
    percent,
    resetAt: toDate(limit.nextResetTime),
    periodMs,
    now,
    details,
  });
}

async function fetchAccountUsage(account) {
  const startedAt = Date.now();
  const options = { key: account.key, proxy: account.proxy };
  const [subscription, quota] = await Promise.all([
    fetchJsonResult(SUBSCRIPTION_URL, options),
    fetchJsonResult(QUOTA_URL, options),
  ]);
  // Quota is the provider's primary payload. A working subscription endpoint
  // must not make a failed quota request look healthy; subscription metadata
  // is optional and may be reported as partial when quota itself succeeded.
  const ok = quota.ok;
  const quotaError = quota.ok ? null : quota;
  const subscriptionError = subscription.ok ? null : subscription;

  return {
    account: { name: account.name, key: maskKey(account.key), proxy: displayProxy(account.proxy) },
    ok,
    ms: Date.now() - startedAt,
    plan: subscription.ok ? getPlanName(subscription.data) : '',
    items: quota.ok ? buildZaiItems(quota.data, { prefix: account.name }) : [],
    status: ok ? 'OK' : quotaError?.status || 'ERR',
    error: ok ? '' : quotaError?.error || 'quota request failed',
    body: ok ? '' : quotaError?.body?.slice(0, 500) || '',
    url: ok ? '' : quotaError?.url || '',
    partial: ok && subscriptionError ? `subscription ${subscriptionError.status || 'ERR'}` : '',
    quotaSample: quota.ok && buildZaiItems(quota.data).every((item) => item.kind === 'empty')
      ? jsonPreview(quota.data)
      : '',
  };
}

export function renderAccountBlock(result, width, mode = 'detail') {
  const compact = mode === 'compact';
  const status = result.ok
    ? `{${COLOR.success}-fg}{bold}OK{/bold}{/${COLOR.success}-fg}`
    : `{${COLOR.danger}-fg}{bold}${escapeBlessed(String(result.status))}{/bold}{/${COLOR.danger}-fg}`;
  // The masked key is identifying, so it only shows in the detail view.
  const meta = compact
    ? [result.plan].filter(Boolean).join(' · ')
    : `${result.account.key} | ${result.ms}ms | via ${result.account.proxy}`;
  const accountText = result.account.name
    ? `{${COLOR.accentSoft}-fg}{bold}${escapeBlessed(result.account.name)}{/bold}{/${COLOR.accentSoft}-fg}  `
    : '  ';
  const metaText = meta ? `  {${COLOR.muted}-fg}${escapeBlessed(meta)}{/${COLOR.muted}-fg}` : '';
  const lines = [
    `${accountText}${status}${metaText}`,
  ];

  if (result.partial) {
    lines.push(`  {${COLOR.warning}-fg}partial data: ${escapeBlessed(result.partial)}{/${COLOR.warning}-fg}`);
  }

  if (!result.ok) {
    lines.push(`  {${COLOR.danger}-fg}${escapeBlessed(result.error || 'Unknown error')}{/${COLOR.danger}-fg}`);

    if (result.url && !compact) {
      lines.push(`  {${COLOR.secondary}-fg}url{/${COLOR.secondary}-fg} ${escapeBlessed(result.url)}`);
    }

    if (result.body && !compact) {
      lines.push(`  {${COLOR.secondary}-fg}body{/${COLOR.secondary}-fg} ${escapeBlessed(result.body)}`);
    }

    return lines.join('\n');
  }

  if (result.plan && !compact) {
    lines.push(`  {${COLOR.secondary}-fg}plan{/${COLOR.secondary}-fg} {${COLOR.accentSoft}-fg}${escapeBlessed(result.plan)}{/${COLOR.accentSoft}-fg}`);
  }

  const itemFormatter = compact ? formatUsageItemCompact : formatUsageItem;
  lines.push(...result.items.map((item) => itemFormatter(item, width)));

  if (result.quotaSample) {
    lines.push(`  {${COLOR.secondary}-fg}quota sample{/${COLOR.secondary}-fg} ${escapeBlessed(result.quotaSample)}`);
  }

  return lines.join('\n');
}

export const ZAI_LOCAL_OPTS = {
  source: 'Claude Code transcripts',
  shorten: (model) => model.replace(/^(?:zai|z-ai|zhipuai)\/+/, ''),
  tone: () => 'cyan',
  note: 'in includes cache writes; cached in = cache reads; $ estimates z.ai API cost, not subscription billing',
};

export function renderZaiSnapshot(snapshot, width, mode = 'detail') {
  if (snapshot.fatal) {
    return `  {${COLOR.danger}-fg}${escapeBlessed(snapshot.fatal)}{/${COLOR.danger}-fg}`;
  }

  const compact = mode === 'compact';
  const sections = snapshot.results.map((result) => renderAccountBlock(result, width, mode));

  if (!compact && snapshot.local?.ok && snapshot.local.models.length > 0) {
    sections.push(renderLocalUsage(snapshot.local, { ...ZAI_LOCAL_OPTS, width }));
  }

  return sections.join(compact ? '\n' : '\n\n');
}

// Appends keys auto-discovered from Claude Code settings profiles whose base
// URL points at the given host, skipping ones already configured in .env.
export async function appendDiscoveredAccounts(accounts, env, hostFragment, disableVar) {
  if (/^(0|false|no)$/i.test(env[disableVar] || '')) {
    return accounts;
  }

  for (const entry of await discoverClaudeSettingsKeys(claudeConfigDir(env))) {
    if (!matchesHost(entry.baseUrl, hostFragment)) {
      continue;
    }

    if (accounts.some((account) => account.key === entry.key)) {
      continue;
    }

    accounts.push({ name: `${entry.name} (auto)`, key: entry.key, proxy: '' });
  }

  return accounts;
}

export async function createZaiProvider(env) {
  const accounts = addZaiDisplayNames(
    await appendDiscoveredAccounts(readZaiAccounts(env), env, 'z.ai', 'ZAI_AUTO_DISCOVER'),
  );

  if (accounts.length === 0) {
    return null;
  }

  const scanner = createTranscriptScanner(claudeConfigDir(env), {
    includeModel: isZaiModel,
  });

  return {
    id: 'zai',
    title: 'z.ai',
    refreshMs: readRefreshMs(env, ['ZAI_REFRESH_SECONDS', 'ZAI_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const [local, results] = await Promise.all([
        scanner.scan().catch((error) => ({ ok: false, error: error.message, models: [] })),
        Promise.all(accounts.map((account) => fetchAccountUsage(account))),
      ]);
      return { results, local };
    },

    render(snapshot, width, mode = 'detail') {
      return renderZaiSnapshot(snapshot, width, mode);
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
          label: [result.account.name, item.label].filter(Boolean).join(' '),
          percent: item.percent,
          resetAt: item.resetAt,
        })));
    },
  };
}

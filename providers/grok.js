import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRefreshMs } from '../lib/env.js';
import { buildUsageItem, toDate } from '../lib/forecast.js';
import { formatNumber } from '../lib/format.js';
import { parseJson } from '../lib/http.js';
import { renderSingleAccount } from './codex.js';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
const TOKEN_AUTH_HEADER = 'xai-grok-cli';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const MONTH_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

function grokAuthPath(env) {
  return env.GROK_AUTH_PATH || join(homedir(), '.grok', 'auth.json');
}

// auth.json maps entry names to { key, expires_at } objects; pick the first
// non-expired key. GROK_TOKEN in .env overrides.
export function pickGrokToken(auth, now = Date.now(), envToken = '') {
  if (envToken.trim()) {
    return { token: envToken.trim() };
  }

  if (!auth || typeof auth !== 'object') {
    return { error: 'Grok not logged in. Run `grok login`.' };
  }

  let sawExpired = false;

  for (const entry of Object.values(auth)) {
    const token = typeof entry?.key === 'string' ? entry.key.trim() : '';

    if (!token) {
      continue;
    }

    const expiresAtMs = entry.expires_at ? Date.parse(entry.expires_at) : NaN;

    if (Number.isFinite(expiresAtMs) && now + EXPIRY_BUFFER_MS >= expiresAtMs) {
      sawExpired = true;
      continue;
    }

    return { token };
  }

  return { error: sawExpired ? 'Grok auth expired. Run `grok login` again.' : 'Grok auth invalid. Run `grok login` again.' };
}

export function buildGrokItems(billing, { prefix = 'grok', now = Date.now() } = {}) {
  const config = billing?.config;
  const used = Number(config?.used?.val);
  const limit = Number(config?.monthlyLimit?.val);
  const onDemandCap = Number(config?.onDemandCap?.val);

  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const details = [];

  if (Number.isFinite(onDemandCap)) {
    details.push({ label: 'pay-as-you-go', value: onDemandCap > 0 ? `${formatNumber(onDemandCap)} cap` : 'disabled' });
  }

  return [buildUsageItem({
    key: `${prefix}:credits`,
    label: 'Credits',
    value: `${Math.round((used / limit) * 100)}% (${formatNumber(used)}/${formatNumber(limit)})`,
    percent: Math.min(100, Math.max(0, (used / limit) * 100)),
    resetAt: toDate(config.billingPeriodEnd),
    periodMs: MONTH_PERIOD_MS,
    now,
    details,
  })];
}

function grokHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': TOKEN_AUTH_HEADER,
    Accept: 'application/json',
    'User-Agent': 'tokensleft',
  };
}

export async function createGrokProvider(env) {
  const authPath = grokAuthPath(env);
  const hasAuthFile = !!parseJson(await readFile(authPath, 'utf8').catch(() => ''));

  if (!hasAuthFile && !env.GROK_TOKEN) {
    return null;
  }

  return {
    id: 'grok',
    title: 'Grok',
    refreshMs: readRefreshMs(env, ['GROK_REFRESH_SECONDS', 'GROK_REFRESH_SEC'], DEFAULT_REFRESH_MS),

    async fetch() {
      const startedAt = Date.now();
      const auth = parseJson(await readFile(authPath, 'utf8').catch(() => ''));
      const picked = pickGrokToken(auth, Date.now(), env.GROK_TOKEN || '');

      if (picked.error) {
        return { ok: false, status: 'CRED', error: picked.error, ms: Date.now() - startedAt, items: [] };
      }

      let billingResponse;

      try {
        billingResponse = await fetch(BILLING_URL, { headers: grokHeaders(picked.token), signal: AbortSignal.timeout(15000) });
      } catch (error) {
        return { ok: false, status: 'ERR', error: `request failed: ${error.message}`, ms: Date.now() - startedAt, items: [] };
      }

      const text = await billingResponse.text();
      const ms = Date.now() - startedAt;

      if (billingResponse.status === 401 || billingResponse.status === 403) {
        return { ok: false, status: billingResponse.status, error: 'Grok auth expired. Run `grok login` again.', ms, items: [] };
      }

      const billing = parseJson(text);

      if (!billingResponse.ok || !billing) {
        return { ok: false, status: billingResponse.status, error: `HTTP ${billingResponse.status}`, body: text.slice(0, 300), ms, items: [] };
      }

      const items = buildGrokItems(billing);

      if (items.length === 0) {
        return { ok: false, status: 'ERR', error: 'billing response shape changed', body: text.slice(0, 300), ms, items: [] };
      }

      let plan = '';

      try {
        const settingsResponse = await fetch(SETTINGS_URL, { headers: grokHeaders(picked.token), signal: AbortSignal.timeout(10000) });

        if (settingsResponse.ok) {
          plan = parseJson(await settingsResponse.text())?.subscription_tier_display || '';
        }
      } catch {
        // plan is optional
      }

      return { ok: true, ms: Date.now() - startedAt, plan, items };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, 'grok');
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems(snapshot) {
      return (snapshot.items || []).map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
    },
  };
}

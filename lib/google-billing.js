import { readFile } from 'node:fs/promises';
import { parseJson } from './http.js';

export function googleAccountStatus(data) {
  const tier = data?.paidTier || data?.currentTier;
  const id = typeof tier?.id === 'string' ? tier.id : '';
  const free = id === 'free-tier';
  // A rejected upgrade tier does not revoke an existing working free/paid tier.
  const restriction = !data?.currentTier && !data?.paidTier
    ? data?.ineligibleTiers?.find((entry) => entry?.reasonCode)
    : null;
  return {
    id, free,
    plan: free ? 'Free / Starter' : tier?.name || id || 'Unknown plan',
    blocked: !!restriction,
    reason: restriction?.reasonCode || '',
  };
}

export function googleCreditItems(data, { prefix, strategy = 'unknown' }) {
  const entries = data?.paidTier?.availableCredits ?? data?.currentTier?.availableCredits;
  const credits = Array.isArray(entries) ? entries.filter((entry) => entry?.creditType === 'GOOGLE_ONE_AI') : [];
  const valid = credits.length > 0 && credits.every((entry) => /^\d+$/.test(String(entry.creditAmount))
    && Number.isSafeInteger(Number(entry.creditAmount)));
  const sum = valid ? credits.reduce((total, entry) => total + Number(entry.creditAmount), 0) : null;
  const balance = Number.isSafeInteger(sum) ? sum : null;
  return [
    {
      kind: 'info', key: `${prefix}:ai-credits`, label: 'AI credits',
      value: balance === null ? 'unavailable' : `${balance.toLocaleString('en-US')} left`,
      ...(balance !== null && balance < 50 ? { note: 'low balance', details: ['Low AI credit balance'] } : {}),
    },
    { kind: 'info', key: `${prefix}:overage`, label: 'Overage', value: strategy },
  ];
}

export async function readGoogleOverageSettings(path, { antigravity = false } = {}) {
  const settings = parseJson(await readFile(path, 'utf8').catch(() => ''));
  if (antigravity) {
    const enabled = settings?.useG1Credits ?? settings?.['antigravity.useG1Credits'];
    return typeof enabled === 'boolean' ? (enabled ? 'always' : 'never') : 'unknown';
  }
  const strategy = settings?.billing?.overageStrategy;
  return ['ask', 'always', 'never'].includes(strategy) ? strategy : settings ? 'ask (default)' : 'unknown';
}

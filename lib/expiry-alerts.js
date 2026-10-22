const HOUR_MS = 60 * 60 * 1000;

export function collectExpiryAlerts(snapshot, seen, { providerId, providerTitle, now = Date.now() }) {
  const candidates = [];
  const addItems = (items, prefix = '') => {
    for (const item of items || []) {
      if (item.kind === 'info' && item.expiresAt && item.remaining !== 0) {
        candidates.push({ key: `${prefix}${item.key}`, label: [prefix.trim(), item.label].filter(Boolean).join(' '), expiresAt: item.expiresAt });
      }
    }
  };
  if (!snapshot || snapshot.fatal) return [];
  if (snapshot.ok) addItems(snapshot.items);
  for (const result of snapshot.results || []) {
    if (!result.ok) continue;
    addItems(result.items, `${result.name} `);
    for (const grant of result.resetCredits?.grants || []) {
      if (grant.remaining <= 0 || grant.paused || !grant.endsAt
        || (grant.startsAt && new Date(grant.startsAt).getTime() > now)) continue;
      candidates.push({ key: `${result.name}:reset:${new Date(grant.endsAt).getTime()}`, label: `${result.name} saved reset`, expiresAt: grant.endsAt });
    }
  }
  const alerts = [];
  for (const candidate of candidates) {
    const deadline = new Date(candidate.expiresAt).getTime();
    const remaining = deadline - now;
    if (!Number.isFinite(deadline) || remaining <= 0 || remaining > 24 * HOUR_MS) continue;
    const threshold = remaining <= HOUR_MS ? '1h' : '24h';
    const key = `${providerId}:${candidate.key}:${deadline}:${threshold}`;
    if (seen.has(key)) continue;
    seen.set(key, deadline);
    alerts.push({ at: now, text: `${providerTitle} · ${candidate.label} expires within ${threshold}` });
  }
  for (const [key, deadline] of seen) if (deadline <= now) seen.delete(key);
  return alerts;
}

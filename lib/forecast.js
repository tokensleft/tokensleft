export function toDate(value) {
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// How much of the current window has elapsed, in percent (null without a reset).
export function elapsedPercent({ resetAt, periodMs, now = Date.now() }) {
  const resetMs = resetAt?.getTime();

  if (!Number.isFinite(resetMs) || !Number.isFinite(periodMs) || periodMs <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, ((now - (resetMs - periodMs)) / periodMs) * 100));
}

// Cross-refresh memory of when each quota window went dry. Keyed by the usage
// item's stable `key`, it records the moment we first observed a window at
// 100% having seen it below 100% earlier in the same process — i.e. we caught
// it run dry, so we can anchor a "dry 5m ago" to that real moment instead of
// resetting it to `now` on every refresh. A window that is already at 100% the
// first time we ever see it has no such moment, so it just reads "exhausted".
const usageHistory = new Map(); // key -> { lastPercent, exhaustedSince }

// Test seam: forget all observed usage history.
export function resetUsageHistory() {
  usageHistory.clear();
}

function trackExhaustion(key, percent, now) {
  if (!key) {
    return null;
  }

  const record = usageHistory.get(key) || { lastPercent: null, exhaustedSince: null };

  if (percent < 100) {
    record.exhaustedSince = null;
  } else if (record.exhaustedSince === null && record.lastPercent !== null && record.lastPercent < 100) {
    // caught the crossing on this observation
    record.exhaustedSince = now;
  }

  record.lastPercent = percent;
  usageHistory.set(key, record);
  return percent >= 100 ? record.exhaustedSince : null;
}

// Builds the standard usage item consumed by lib/render.js.
//
// Forecast: plain linear extrapolation of the window so far — if you used
// percent% in elapsed% of the window, you land at percent/elapsed*100 by
// reset. One model for every window; it answers a single question: does the
// quota last until the reset? When the line is projected to cross 100% before
// the reset, depletesAt marks that future crossing time.
//
// A quota already at 100% is `exhausted`. If we caught it cross into that
// state while running, depletesAt holds the (past) moment we saw it happen, so
// it reads "dry 5m ago"; if it was already exhausted the first time we saw it,
// depletesAt stays null and it reads "exhausted".
export function buildUsageItem({
  key,
  label,
  value,
  percent,
  resetAt = null,
  periodMs,
  severity = '',
  active = false,
  details = [],
  now = Date.now(),
}) {
  const elapsed = elapsedPercent({ resetAt, periodMs, now });
  const paceDelta = elapsed === null ? null : percent - elapsed;
  const resetMs = resetAt?.getTime();
  let projectedPercent = null;

  // Guard the very start of a window, where the ratio is all noise.
  if (elapsed !== null && elapsed >= 1 && percent > 0) {
    projectedPercent = Math.min(999, (percent / elapsed) * 100);
  }

  const exhausted = percent >= 100;
  const exhaustedSince = trackExhaustion(key, percent, now);
  let depletesAt = null;

  if (exhausted) {
    // Only when we actually caught it run dry; otherwise it reads "exhausted".
    if (exhaustedSince !== null) {
      depletesAt = new Date(exhaustedSince);
    }
  } else if (Number.isFinite(resetMs) && projectedPercent > 100) {
    const windowStartMs = resetMs - periodMs;
    depletesAt = new Date(windowStartMs + ((now - windowStartMs) * 100) / percent);
  }

  return {
    kind: 'usage',
    key,
    label,
    value: value ?? `${Math.round(percent)}%`,
    percent,
    elapsedPercent: elapsed,
    paceDelta,
    projectedPercent,
    forecastMethod: projectedPercent === null ? null : 'linear',
    severity,
    active,
    resetAt,
    exhausted,
    depletesAt,
    details,
  };
}

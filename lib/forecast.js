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

// Builds the standard usage item consumed by lib/render.js.
//
// Forecast: plain linear extrapolation of the window so far — if you used
// percent% in elapsed% of the window, you land at percent/elapsed*100 by
// reset. One model for every window; it answers a single question: does the
// quota last until the reset? When the line crosses 100% before the reset,
// depletesAt marks the crossing time.
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

  let depletesAt = null;

  if (Number.isFinite(resetMs) && percent >= 100) {
    depletesAt = new Date(now);
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
    depletesAt,
    details,
  };
}

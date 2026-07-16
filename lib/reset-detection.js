const MIN_RESET_DROP = 10;
const NEAR_FRESH_PERCENT = 5;
const LARGE_RESET_DROP = 40;
const MOSTLY_FRESH_PERCENT = 25;
const MOSTLY_FRESH_RATIO = 0.4;
const SCHEDULE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;

function timestamp(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    return Date.parse(value);
  }

  return Number(value);
}

// A reset is considered unexpected only when a recently observed quota drops
// back to (almost) fresh while its previously advertised reset is not due.
// The two shapes cover both an immediate 0% snapshot and a reset that already
// accumulated a little usage before the next poll.
export function isUnexpectedQuotaReset(previous, current, {
  now = Date.now(),
  maxObservationAgeMs = DEFAULT_MAX_OBSERVATION_AGE_MS,
} = {}) {
  const previousPercent = Number(previous?.percent);
  const currentPercent = Number(current?.percent);
  const observedAt = Number(previous?.observedAt);
  const age = now - observedAt;

  if (
    !Number.isFinite(previousPercent)
    || !Number.isFinite(currentPercent)
    || !Number.isFinite(observedAt)
    || age < 0
    || age > maxObservationAgeMs
  ) {
    return false;
  }

  const previousResetAt = timestamp(previous?.resetAt);

  // Clock skew and delayed polls can make a normal scheduled reset appear a
  // little early, so suppress anything already inside the countdown grace.
  if (Number.isFinite(previousResetAt) && previousResetAt <= now + SCHEDULE_GRACE_MS) {
    return false;
  }

  const drop = previousPercent - currentPercent;
  const nearlyFresh = previousPercent >= MIN_RESET_DROP
    && drop >= MIN_RESET_DROP
    && currentPercent <= NEAR_FRESH_PERCENT;
  const mostlyFresh = drop >= LARGE_RESET_DROP
    && currentPercent <= MOSTLY_FRESH_PERCENT
    && currentPercent <= previousPercent * MOSTLY_FRESH_RATIO;

  return nearlyFresh || mostlyFresh;
}

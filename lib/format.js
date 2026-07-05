export function formatRelativeTime(date, suffix = '') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  if (absMs < 1000) {
    return `now${suffix}`;
  }

  const seconds = Math.floor(absMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours % 24 > 0 && parts.length < 2) {
    parts.push(`${hours % 24}h`);
  }

  if (minutes % 60 > 0 && parts.length < 2) {
    parts.push(`${minutes % 60}m`);
  }

  if (parts.length === 0) {
    parts.push(`${seconds % 60}s`);
  }

  const body = parts.join(' ');
  return diffMs >= 0 ? `in ${body}${suffix}` : `${body} ago${suffix}`;
}

export function formatDateTime(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : '?';
}

export function formatTokens(value) {
  if (!Number.isFinite(value) || value === 0) {
    return '0';
  }

  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(1)}B`;
  }

  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }

  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}k`;
  }

  return String(value);
}

export function maskKey(key) {
  const text = String(key);

  if (text.length <= 12) {
    return `${text.slice(0, 3)}...`;
  }

  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function escapeBlessed(value) {
  return String(value).replace(/[{}]/g, '');
}

export function stripBlessedTags(value) {
  return String(value).replace(/\{\/?[a-z0-9-]*\}/gi, '');
}

export function padVisible(value, width) {
  const text = String(value);
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export function padStart(value, width) {
  return String(value).padStart(width);
}

export function jsonPreview(value, limit = 600) {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value).slice(0, limit);
}

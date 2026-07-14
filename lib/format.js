import { stripVTControlCharacters } from 'node:util';
import blessed from 'blessed';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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

// Like formatRelativeTime, but under an hour it drops to a seconds-inclusive
// countdown ("45m 3s", "9s") so the value visibly ticks each second when the
// dashboard re-renders. An hour or more out, it stays on the coarse day/hour
// format (nothing worth ticking that far away).
export function formatCountdown(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  if (absMs >= 60 * 60 * 1000) {
    return formatRelativeTime(date);
  }

  if (absMs < 1000) {
    return 'now';
  }

  const totalSeconds = Math.floor(absMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const body = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  return diffMs >= 0 ? `in ${body}` : `${body} ago`;
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
  return sanitizeTerminalText(value).replace(/[{}]/g, '');
}

export function sanitizeTerminalText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\p{Bidi_Control}/gu, '');
}

export function stripBlessedTags(value) {
  return String(value).replace(/\{\/?[a-z0-9-]*\}/gi, '');
}

export function stripBlessedColorTags(value) {
  return String(value).replace(/\{\/?(?:#[0-9a-f]{3,8}|[a-z0-9-]+)-(?:fg|bg)\}/gi, '');
}

export function cellWidth(value) {
  const plain = stripVTControlCharacters(stripBlessedTags(String(value ?? '')));
  return blessed.unicode.strWidth(plain);
}

function graphemes(value) {
  return [...graphemeSegmenter.segment(String(value ?? ''))].map((entry) => entry.segment);
}

export function truncateVisible(value, width, ellipsis = '…') {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(width) || 0));

  if (cellWidth(text) <= limit) {
    return text;
  }

  const marker = cellWidth(ellipsis) <= limit ? ellipsis : '';
  const target = Math.max(0, limit - cellWidth(marker));
  let used = 0;
  let output = '';

  for (const grapheme of graphemes(text)) {
    const nextWidth = cellWidth(grapheme);

    if (used + nextWidth > target) {
      break;
    }

    output += grapheme;
    used += nextWidth;
  }

  return output + marker;
}

// Truncates Blessed-tagged content without leaking an open style into the
// remainder of the line. Dynamic values are escaped before reaching here, so
// every recognized tag is application-owned markup.
export function truncateTagged(value, width, ellipsis = '…') {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(width) || 0));

  if (cellWidth(text) <= limit) {
    return text;
  }

  const marker = cellWidth(ellipsis) <= limit ? ellipsis : '';
  const target = Math.max(0, limit - cellWidth(marker));
  const tagPattern = /\{(\/)?([a-z0-9-]*)\}/gi;
  const openTags = [];
  let output = '';
  let used = 0;
  let cursor = 0;
  let match;
  let truncated = false;

  const appendText = (segment) => {
    for (const grapheme of graphemes(segment)) {
      const nextWidth = cellWidth(grapheme);

      if (used + nextWidth > target) {
        truncated = true;
        return;
      }

      output += grapheme;
      used += nextWidth;
    }
  };

  while ((match = tagPattern.exec(text)) !== null) {
    appendText(text.slice(cursor, match.index));

    if (truncated) {
      break;
    }

    output += match[0];
    const closing = Boolean(match[1]);
    const name = match[2];

    if (!closing && name) {
      openTags.push(name);
    } else if (closing) {
      const index = name ? openTags.lastIndexOf(name) : openTags.length - 1;

      if (index >= 0) {
        openTags.splice(index, 1);
      }
    }

    cursor = tagPattern.lastIndex;
  }

  if (!truncated) {
    appendText(text.slice(cursor));
  }

  return output + marker + [...openTags].reverse().map((name) => `{/${name}}`).join('');
}

export function padVisible(value, width) {
  const text = String(value);
  const fitted = truncateVisible(text, width);
  return fitted + ' '.repeat(Math.max(0, width - cellWidth(fitted)));
}

export function padStart(value, width) {
  const text = truncateVisible(value, width);
  return ' '.repeat(Math.max(0, width - cellWidth(text))) + text;
}

export function jsonPreview(value, limit = 600) {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value).slice(0, limit);
}

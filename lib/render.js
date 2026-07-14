import {
  cellWidth,
  clamp,
  escapeBlessed,
  formatCountdown,
  padVisible,
  truncateTagged,
} from './format.js';
import { COLOR, resolveUiColor } from './palette.js';

const RESET_SOON_MS = 60 * 60 * 1000;

function isDateSoon(date) {
  if (!(date instanceof Date)) {
    return false;
  }

  const delta = date.getTime() - Date.now();
  return delta > 0 && delta < RESET_SOON_MS;
}

// A reset landing within the hour is worth flagging — the quota is about to
// refresh. Only future resets count (a lapsed one is already resetting).
function isResetSoon(item) {
  return isDateSoon(item.resetAt);
}

function isInfoExpirySoon(item) {
  return isDateSoon(item.expiresAt);
}

export function usageTone(percent, severity = '') {
  if (severity === 'exceeded' || severity === 'critical' || percent >= 90) {
    return 'red';
  }

  if (severity === 'warning' || percent >= 70) {
    return 'yellow';
  }

  return 'green';
}

// Solid bar with a forecast "ghost" tail: █ is what's already used, and a
// faint ░ tail extends to the projected level at reset. The tail is colored
// by where the projection lands (green/yellow/red), so a red tail reads as
// "heading into the red zone" at a glance. No projection → plain fill.
export function solidProgressBar(percent, forecastPercent, width, tone) {
  const filled = Math.round((clamp(percent, 0, 100) / 100) * width);
  const forecast = Number.isFinite(forecastPercent)
    ? Math.max(filled, Math.round((clamp(forecastPercent, 0, 100) / 100) * width))
    : filled;
  const forecastTone = usageTone(clamp(forecastPercent, 0, 100));
  const parts = ['['];
  let segmentStyle = null;
  let segment = '';

  for (let index = 0; index < width; index += 1) {
    const [char, styleName] = index < filled
      ? ['█', tone]
      : index < forecast
        ? ['░', forecastTone]
        : [' ', 'white'];

    if (styleName !== segmentStyle && segment) {
      parts.push(colorSegment(segment, segmentStyle));
      segment = '';
    }

    segmentStyle = styleName;
    segment += char;
  }

  if (segment) {
    parts.push(colorSegment(segment, segmentStyle));
  }

  parts.push(']');
  return parts.join('');
}

function colorSegment(value, styleName) {
  const color = resolveUiColor(styleName);
  return `{${color}-fg}${value}{/${color}-fg}`;
}

export function labelWidthFor(contentWidth, mode = 'detail') {
  const width = Math.max(1, Number(contentWidth) || 1);
  const target = Math.floor(width * (mode === 'compact' ? 0.2 : 0.22));
  const maximum = mode === 'compact' ? 20 : 24;
  return Math.max(6, Math.min(maximum, Math.max(12, target), Math.max(6, width - 24)));
}

export function barWidthFor(contentWidth) {
  return Math.max(12, Math.min(72, contentWidth - 10));
}

export function compactBarWidthFor(contentWidth, labelWidth = labelWidthFor(contentWidth, 'compact')) {
  const width = Math.max(1, Number(contentWidth) || 1);
  return Math.max(10, Math.min(34, Math.floor(width * 0.27), width - labelWidth - 10));
}

function fitLines(lines, width) {
  return lines.map((line) => truncateTagged(line, width)).join('\n');
}

// Pace indicator: how used% compares to elapsed%. A fact, not a forecast.
function paceText(item, padWidth = 0) {
  if (!Number.isFinite(item.paceDelta)) {
    return ' '.repeat(padWidth);
  }

  const ahead = item.paceDelta > 2;
  const plain = (ahead ? `▲+${Math.round(item.paceDelta)}%` : '✓ pace').padEnd(padWidth);
  const tone = ahead ? (item.depletesAt || item.exhausted ? 'red' : 'yellow') : 'green';
  const color = resolveUiColor(tone);
  return `{${color}-fg}${plain}{/${color}-fg}`;
}

// Renders one usage item (see lib/forecast.js buildUsageItem for the shape).
export function formatUsageItem(item, width) {
  if (item.kind === 'empty') {
    return fitLines([
      `  {${COLOR.warning}-fg}${escapeBlessed(item.label)}{/${COLOR.warning}-fg} ${escapeBlessed(item.message || 'no data')}`,
    ], width);
  }

  const labelWidth = labelWidthFor(width, 'detail');

  if (item.kind === 'info') {
    const urgent = isInfoExpirySoon(item);
    const header = `  {bold}${escapeBlessed(padVisible(item.label, labelWidth))}{/bold} {${COLOR.secondary}-fg}${escapeBlessed(item.value)}{/${COLOR.secondary}-fg}`;
    const lines = item.details?.length
      ? item.details.map((detail, index) => urgent && index === 0
        ? `  {${COLOR.warning}-fg}{bold}  ⚠ ${escapeBlessed(detail)}{/bold}{/${COLOR.warning}-fg}`
        : `  {${COLOR.muted}-fg}  ${escapeBlessed(detail)}{/${COLOR.muted}-fg}`)
      : [];
    return fitLines([header, ...lines], width);
  }

  const tone = usageTone(item.percent, item.severity);
  const toneColor = resolveUiColor(tone);
  const active = item.active ? ` {${COLOR.success}-fg}●{/${COLOR.success}-fg}` : '';
  const predicted = Number.isFinite(item.projectedPercent)
    ? `  {${COLOR.muted}-fg}→${Math.round(item.projectedPercent)}% @ reset at current pace{/${COLOR.muted}-fg}`
    : '';
  const lines = [
    `  {bold}${escapeBlessed(padVisible(item.label, labelWidth))}{/bold} ${escapeBlessed(item.value)}${active}${predicted}`,
    `  ${solidProgressBar(item.percent, item.projectedPercent, barWidthFor(width), tone)} {${toneColor}-fg}${Math.round(clamp(item.percent, 0, 100))}%{/${toneColor}-fg}`,
  ];
  const resetSoon = isResetSoon(item);
  const meta = [];

  if (item.resetAt && !resetSoon) {
    meta.push(`reset ${formatCountdown(item.resetAt)}`);
  }

  if (Number.isFinite(item.elapsedPercent)) {
    meta.push(`pace ${Math.round(item.percent)}% used vs ${Math.round(item.elapsedPercent)}% elapsed`);
  }

  if (meta.length > 0) {
    lines.push(`  {${COLOR.muted}-fg}${escapeBlessed(meta.join('  |  '))}{/${COLOR.muted}-fg}`);
  }

  if (resetSoon) {
    lines.push(`  {${COLOR.warning}-fg}{bold}◷ resets ${escapeBlessed(formatCountdown(item.resetAt))}{/bold}{/${COLOR.warning}-fg}`);
  }

  if (item.exhausted) {
    lines.push(item.depletesAt
      ? `  {${COLOR.danger}-fg}{bold}⚠ ran dry ${escapeBlessed(formatCountdown(item.depletesAt))} — waiting for reset{/bold}{/${COLOR.danger}-fg}`
      : `  {${COLOR.danger}-fg}{bold}⚠ quota exhausted — waiting for reset{/bold}{/${COLOR.danger}-fg}`);
  } else if (item.depletesAt) {
    lines.push(`  {${COLOR.danger}-fg}{bold}⚠ on track to run dry ${escapeBlessed(formatCountdown(item.depletesAt))} (before reset){/bold}{/${COLOR.danger}-fg}`);
  }

  if (item.details?.length) {
    lines.push(...item.details.map((detail) => `  {${COLOR.secondary}-fg}${escapeBlessed(detail.label)}{/${COLOR.secondary}-fg} ${escapeBlessed(detail.value)}`));
  }

  return fitLines(lines, width);
}

// One-line variant: label, bar (solid used fill plus the projected-at-reset
// ghost tail), current %, pace indicator, the →n% linear projection, reset
// countdown, and the dry warning when the projection crosses 100% before
// the reset.
// Per-service details, when present, become a second line under the bar.
export function formatUsageItemCompact(item, width) {
  if (item.kind === 'empty') {
    return fitLines([
      `  {${COLOR.warning}-fg}${escapeBlessed(item.label)}{/${COLOR.warning}-fg} ${escapeBlessed(item.message || 'no data')}`,
    ], width);
  }

  const labelWidth = labelWidthFor(width, 'compact');

  if (item.kind === 'info') {
    const urgent = isInfoExpirySoon(item);
    const note = !item.note
      ? ''
      : urgent
        ? ` {${COLOR.warning}-fg}{bold}· ⚠ ${escapeBlessed(item.note)}{/bold}{/${COLOR.warning}-fg}`
        : ` {${COLOR.muted}-fg}· ${escapeBlessed(item.note)}{/${COLOR.muted}-fg}`;
    return fitLines([
      `  {bold}${escapeBlessed(padVisible(item.label, labelWidth))}{/bold} {${COLOR.secondary}-fg}${escapeBlessed(item.value)}{/${COLOR.secondary}-fg}${note}`,
    ], width);
  }

  const tone = usageTone(item.percent, item.severity);
  const toneColor = resolveUiColor(tone);
  const barWidth = compactBarWidthFor(width, labelWidth);
  const percentText = `${Math.round(clamp(item.percent, 0, 100))}%`.padStart(4);
  const pace = paceText(item, 7);
  const projected = Number.isFinite(item.projectedPercent)
    ? ` {${COLOR.muted}-fg}→${Math.round(item.projectedPercent)}%{/${COLOR.muted}-fg}`
    : '';
  const active = item.active ? `{${COLOR.success}-fg}●{/${COLOR.success}-fg}` : ' ';
  const reset = item.resetAt ? `reset ${formatCountdown(item.resetAt).replace(/^in /, '')}` : '';
  const resetChunk = !reset
    ? ' '
    : isResetSoon(item)
      ? ` {${COLOR.warning}-fg}{bold}◷ ${escapeBlessed(reset)}{/bold}{/${COLOR.warning}-fg}`
      : ` {${COLOR.muted}-fg}${escapeBlessed(reset)}{/${COLOR.muted}-fg}`;
  // exhausted with a caught crossing → "dry 5m ago"; exhausted but never seen
  // crossing → "exhausted"; still under 100 but forecast to cross → "dry 30m".
  const dry = item.exhausted && !item.depletesAt
    ? ` {${COLOR.danger}-fg}{bold}⚠ exhausted{/bold}{/${COLOR.danger}-fg}`
    : item.depletesAt
      ? ` {${COLOR.danger}-fg}{bold}⚠ dry ${escapeBlessed(formatCountdown(item.depletesAt).replace(/^in /, ''))}{/bold}{/${COLOR.danger}-fg}`
      : '';
  const plainValue = `${Math.round(item.percent)}%`;
  const extras = [];

  if (item.value && item.value !== plainValue) {
    // the percent is already on the line — keep only the extra part (e.g. counts)
    const extra = item.value.replace(/\s*\d+%\s*(\(|$)/, '$1').trim();

    if (extra) {
      extras.push(extra);
    }
  }

  const extraText = extras.length > 0 ? ` {${COLOR.muted}-fg}· ${escapeBlessed(extras.join(' · '))}{/${COLOR.muted}-fg}` : '';
  const head = [
    `  {bold}${escapeBlessed(padVisible(item.label, labelWidth))}{/bold}${active}`,
    solidProgressBar(item.percent, item.projectedPercent, barWidth, tone),
    ` {${toneColor}-fg}${percentText}{/${toneColor}-fg}`,
  ].join('');
  const chunks = [
    { key: 'pace', text: Number.isFinite(item.paceDelta) ? ` ${pace}` : '', priority: 60 },
    { key: 'projected', text: projected, priority: 40 },
    { key: 'reset', text: resetChunk.trim() ? resetChunk : '', priority: dry ? 30 : 70 },
    { key: 'dry', text: dry, priority: 100 },
    { key: 'extra', text: extraText, priority: 80 },
  ].filter((chunk) => chunk.text);
  const selected = new Set();
  let usedWidth = cellWidth(head);

  for (const chunk of [...chunks].sort((a, b) => b.priority - a.priority)) {
    const chunkWidth = cellWidth(chunk.text);

    if (usedWidth + chunkWidth <= width) {
      selected.add(chunk.key);
      usedWidth += chunkWidth;
    }
  }

  const line = head + chunks
    .filter((chunk) => selected.has(chunk.key))
    .map((chunk) => chunk.text)
    .join('');

  if (!item.details?.length) {
    return fitLines([line], width);
  }

  // Per-service breakdowns on the main line get clipped at the box edge, so
  // they go on their own line aligned under the bar.
  const breakdown = item.details.map((detail) => `${detail.label} ${detail.value}`).join(' · ');
  return fitLines([
    line,
    `${' '.repeat(labelWidth + 3)}{${COLOR.muted}-fg}${escapeBlessed(breakdown)}{/${COLOR.muted}-fg}`,
  ], width);
}

export function sectionSeparator(width) {
  return `{${COLOR.frame}-fg}${'─'.repeat(Math.max(0, width))}{/${COLOR.frame}-fg}`;
}

export function contentWidthFor(screenWidth) {
  return Math.max(1, Math.min((screenWidth || 90) - 8, 120));
}

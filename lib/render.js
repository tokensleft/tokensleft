import { clamp, escapeBlessed, formatRelativeTime } from './format.js';

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
  return `{${styleName}-fg}${value}{/${styleName}-fg}`;
}

export function barWidthFor(contentWidth) {
  return Math.max(24, Math.min(48, contentWidth - 34));
}

// Pace indicator: how used% compares to elapsed%. A fact, not a forecast.
function paceText(item, padWidth = 0) {
  if (!Number.isFinite(item.paceDelta)) {
    return ' '.repeat(padWidth);
  }

  const ahead = item.paceDelta > 2;
  const plain = (ahead ? `▲+${Math.round(item.paceDelta)}%` : '✓ pace').padEnd(padWidth);
  const tone = ahead ? (item.depletesAt ? 'red' : 'yellow') : 'green';
  return `{${tone}-fg}${plain}{/${tone}-fg}`;
}

// Renders one usage item (see lib/forecast.js buildUsageItem for the shape).
export function formatUsageItem(item, width) {
  if (item.kind === 'empty') {
    return `  {yellow-fg}${escapeBlessed(item.label)}{/yellow-fg} ${escapeBlessed(item.message || 'no data')}`;
  }

  const tone = usageTone(item.percent, item.severity);
  const active = item.active ? ' {green-fg}●{/green-fg}' : '';
  const predicted = Number.isFinite(item.projectedPercent)
    ? `  {white-fg}→${Math.round(item.projectedPercent)}% @ reset at current pace{/white-fg}`
    : '';
  const lines = [
    `  {bold}${escapeBlessed(item.label.padEnd(12))}{/bold} ${escapeBlessed(item.value)}${active}${predicted}`,
    `  ${solidProgressBar(item.percent, item.projectedPercent, barWidthFor(width), tone)} {${tone}-fg}${Math.round(clamp(item.percent, 0, 100))}%{/${tone}-fg}`,
  ];
  const meta = [];

  if (item.resetAt) {
    meta.push(`reset ${formatRelativeTime(item.resetAt)}`);
  }

  if (Number.isFinite(item.elapsedPercent)) {
    meta.push(`pace ${Math.round(item.percent)}% used vs ${Math.round(item.elapsedPercent)}% elapsed`);
  }

  if (meta.length > 0) {
    lines.push(`  {white-fg}${escapeBlessed(meta.join('  |  '))}{/white-fg}`);
  }

  if (item.depletesAt) {
    lines.push(`  {red-fg}{bold}⚠ on track to run dry ${escapeBlessed(formatRelativeTime(item.depletesAt))} (before reset){/bold}{/red-fg}`);
  }

  if (item.details?.length) {
    lines.push(...item.details.map((detail) => `  {white-fg}${escapeBlessed(detail.label)}{/white-fg} ${escapeBlessed(detail.value)}`));
  }

  return lines.join('\n');
}

// One-line variant: label, bar (solid used fill plus the projected-at-reset
// ghost tail), current %, pace indicator, the →n% linear projection, reset
// countdown, and the dry warning when the projection crosses 100% before
// the reset.
// Per-service details, when present, become a second line under the bar.
export function formatUsageItemCompact(item, width) {
  if (item.kind === 'empty') {
    return `  {yellow-fg}${escapeBlessed(item.label)}{/yellow-fg} ${escapeBlessed(item.message || 'no data')}`;
  }

  const tone = usageTone(item.percent, item.severity);
  const barWidth = Math.max(14, Math.min(26, width - 52));
  const percentText = `${Math.round(clamp(item.percent, 0, 100))}%`.padStart(4);
  const pace = paceText(item, 7);
  const projected = Number.isFinite(item.projectedPercent)
    ? ` {white-fg}→${Math.round(item.projectedPercent)}%{/white-fg}`
    : '';
  const active = item.active ? '{green-fg}●{/green-fg}' : ' ';
  const reset = item.resetAt ? `reset ${formatRelativeTime(item.resetAt).replace(/^in /, '')}` : '';
  const dry = item.depletesAt
    ? ` {red-fg}{bold}⚠ dry ${escapeBlessed(formatRelativeTime(item.depletesAt).replace(/^in /, ''))}{/bold}{/red-fg}`
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

  const extraText = extras.length > 0 ? ` {white-fg}· ${escapeBlessed(extras.join(' · '))}{/white-fg}` : '';
  const line = [
    `  {bold}${escapeBlessed(item.label.padEnd(12))}{/bold}${active}`,
    `${solidProgressBar(item.percent, item.projectedPercent, barWidth, tone)}`,
    ` {${tone}-fg}${percentText}{/${tone}-fg} ${pace}${projected}`,
    ` {white-fg}${escapeBlessed(reset)}{/white-fg}${dry}${extraText}`,
  ].join('');

  if (!item.details?.length) {
    return line;
  }

  // Per-service breakdowns on the main line get clipped at the box edge, so
  // they go on their own line aligned under the bar.
  const breakdown = item.details.map((detail) => `${detail.label} ${detail.value}`).join(' · ');
  return `${line}\n${' '.repeat(15)}{white-fg}${escapeBlessed(breakdown)}{/white-fg}`;
}

export function sectionSeparator(width) {
  return `{white-fg}${'-'.repeat(Math.min(width, 100))}{/white-fg}`;
}

export function contentWidthFor(screenWidth) {
  return Math.max(64, Math.min((screenWidth || 90) - 8, 120));
}

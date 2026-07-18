import blessed from 'blessed';
import {
  cellWidth,
  escapeBlessed,
  formatDateTime,
  formatRelativeTime,
  stripBlessedColorTags,
  truncateTagged,
  truncateVisible,
} from './format.js';
import { COLOR } from './palette.js';
import { contentWidthFor, sectionSeparator } from './render.js';
import { isUnexpectedQuotaReset } from './reset-detection.js';

const ALERT_THRESHOLDS = [80, 90];
const ALERT_SHOW_MS = 5 * 60 * 1000;
const SINGLE_DASHBOARD_WIDTH = 132;
const WIDE_DASHBOARD_WIDTH = 212;
const DASHBOARD_CHROME_WIDTH = 8;
const COLUMN_GAP_WIDTH = 4;
const COMPACT_COLUMN_WIDTH = 74;
const DETAIL_COLUMN_WIDTH = 98;
const RESET_HISTORY_MIN_AGE_MS = 15 * 60 * 1000;
const CELEBRATION_ANIMATION_FRAME_MS = 80;
const RAINBOW_BAND_WIDTH = 2;
const OCEAN_WAVE_SPEED = 0.03;
const OCEAN_WAVE_PERIOD = 20;
const OCEAN_WAVE_Y_ASPECT = 2;
const OCEAN_WAVE_UNDULATION = 1.75;
const OCEAN_WAVE_CROSS_SCALE = 5;
const OCEAN_WAVE_DRIFT_SCALE = 12;
const OCEAN_WAVE_BASE_LEVELS = 8;
const OCEAN_WAVE_CREST_THRESHOLD = 0.8;
const CELEBRATION_FRAME_HORIZONTAL_PADDING = 2;
const CELEBRATION_FRAME_VERTICAL_PADDING = 1;
const CELEBRATION_FRAME_CHROME_WIDTH = 2 + CELEBRATION_FRAME_HORIZONTAL_PADDING * 2;
const CELEBRATION_FRAME_CHROME_HEIGHT = 2 + CELEBRATION_FRAME_VERTICAL_PADDING * 2;
const CELEBRATION_BELL_PATTERN_MS = [0, 90, 180, 450, 540];
const RAINBOW_COLORS = [
  COLOR.danger,
  COLOR.orange,
  COLOR.warning,
  COLOR.lime,
  COLOR.success,
  COLOR.accentSoft,
  COLOR.accent,
  COLOR.blue,
  141,
  COLOR.magenta,
];
// Deep ocean blue rises through cyan into pale sea foam at each crest.
const OCEAN_WAVE_RAMP = [
  24, 25, 31, 32, 37, 38, 44, 74,
  75, 81, 87, 123, 159, 195, 231, 231,
];
const CELEBRATION_GLYPHS = Object.freeze({
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
});
const BORDER_CHARACTERS = new Set(['─', '│', '┌', '┐', '└', '┘', '╭', '╮', '╰', '╯']);
const FOREGROUND_MASK = 0x1ff << 9;

export const DASHBOARD_TITLE = 'TokensLeft';
export const DASHBOARD_SUBTITLE = 'Know What’s Left. Keep Creating.';
export const DASHBOARD_BACKGROUND = 'default';
export const DEFAULT_TERMINAL_PROFILE = 'xterm-256color';
export const MIN_DASHBOARD_WIDTH = 72;

export function uiColorMode(env = process.env) {
  if (String(env.NO_COLOR || '').length > 0 || String(env.TOKENSLEFT_COLOR || '').toLowerCase() === 'none') {
    return 'none';
  }

  return String(env.TOKENSLEFT_COLOR || '').toLowerCase() === 'basic' ? 'basic' : '256';
}

export function terminalProfile(env = process.env) {
  const override = String(env.TOKENSLEFT_TERM || '').trim();

  if (override) {
    return override;
  }

  if (uiColorMode(env) === 'basic') {
    return String(env.TERM || '').trim() || 'xterm';
  }

  // TokensLeft targets modern terminal frontends. TERM is frequently
  // under-reported (`xterm`, `linux`) and Blessed 0.1.x also lacks several
  // current tmux/screen entries, causing a silent fallback to eight colors.
  // Use the common 256-color profile consistently; TOKENSLEFT_TERM remains an
  // escape hatch for genuinely limited consoles and unusual terminfo setups.
  return DEFAULT_TERMINAL_PROFILE;
}

// Blessed only ships square line-border corners. Swap those four cells after
// the box is rendered so the dashboard shell matches Codex's rounded frame.
export function applyRoundedCorners(lines, coords) {
  if (!coords || coords.xl - coords.xi < 2 || coords.yl - coords.yi < 2) {
    return;
  }

  const corners = [
    [coords.yi, coords.xi, '╭'],
    [coords.yi, coords.xl - 1, '╮'],
    [coords.yl - 1, coords.xi, '╰'],
    [coords.yl - 1, coords.xl - 1, '╯'],
  ];

  for (const [y, x, char] of corners) {
    const cell = lines?.[y]?.[x];

    if (cell) {
      cell[1] = char;
      lines[y].dirty = true;
    }
  }
}

// Repeat narrow rainbow bands around the entire perimeter. Advancing phase
// shifts every band clockwise, making the motion obvious even on large frames
// while preserving label text and its colors.
export function applyRainbowBorder(lines, coords, phase = 0) {
  if (!coords || coords.xl - coords.xi < 2 || coords.yl - coords.yi < 2) {
    return;
  }

  const cells = [];

  for (let x = coords.xi; x < coords.xl; x += 1) {
    cells.push([coords.yi, x]);
  }

  for (let y = coords.yi + 1; y < coords.yl; y += 1) {
    cells.push([y, coords.xl - 1]);
  }

  for (let x = coords.xl - 2; x >= coords.xi; x -= 1) {
    cells.push([coords.yl - 1, x]);
  }

  for (let y = coords.yl - 2; y > coords.yi; y -= 1) {
    cells.push([y, coords.xi]);
  }

  const normalizedPhase = Number.isFinite(Number(phase)) ? Math.trunc(Number(phase)) : 0;

  cells.forEach(([y, x], index) => {
    const cell = lines?.[y]?.[x];

    if (!cell || !BORDER_CHARACTERS.has(cell[1])) {
      return;
    }

    const cycleLength = RAINBOW_COLORS.length * RAINBOW_BAND_WIDTH;
    const position = ((index - normalizedPhase) % cycleLength + cycleLength) % cycleLength;
    const color = RAINBOW_COLORS[Math.floor(position / RAINBOW_BAND_WIDTH)];
    const attr = (cell[0] & ~FOREGROUND_MASK) | (color << 9);

    if (cell[0] !== attr) {
      cell[0] = attr;
      lines[y].dirty = true;
    }
  });
}

// Sweep a gently undulating wave from upper-left to lower-right, clipping the
// color to the large block-letter title while supporting text remains still.
export function applyOceanTextWave(lines, phase = 0, bounds = null) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const firstY = Number.isFinite(Number(bounds?.yi))
    ? Math.max(0, Math.floor(Number(bounds.yi)))
    : 0;
  const lastY = Number.isFinite(Number(bounds?.yl))
    ? Math.min(lines?.length || 0, Math.ceil(Number(bounds.yl)))
    : lines?.length || 0;

  for (let y = firstY; y < lastY; y += 1) {
    const line = lines[y];
    const firstX = Number.isFinite(Number(bounds?.xi))
      ? Math.max(0, Math.floor(Number(bounds.xi)))
      : 0;
    const lastX = Number.isFinite(Number(bounds?.xl))
      ? Math.min(line?.length || 0, Math.ceil(Number(bounds.xl)))
      : line?.length || 0;

    for (let x = firstX; x < lastX; x += 1) {
      if (!line[x] || line[x][1] !== '█') {
        continue;
      }

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX)) {
    return;
  }

  const numericPhase = Number(phase);
  const travel = Number.isFinite(numericPhase) ? Math.max(0, numericPhase) : 0;

  for (let y = minY; y <= maxY; y += 1) {
    const line = lines[y];

    if (!line) {
      continue;
    }

    for (let x = minX; x <= Math.min(maxX, line.length - 1); x += 1) {
      const cell = line[x];

      if (!cell || cell[1] !== '█') {
        continue;
      }

      const horizontal = x - minX;
      const vertical = (y - minY) * OCEAN_WAVE_Y_ASPECT;
      const along = (horizontal + vertical) / Math.SQRT2;
      const across = (horizontal - vertical) / Math.SQRT2;
      const distance = along + Math.sin(
        across / OCEAN_WAVE_CROSS_SCALE
        + travel / OCEAN_WAVE_DRIFT_SCALE,
      ) * OCEAN_WAVE_UNDULATION;
      let level = null;

      if (distance <= travel) {
        const offset = (
          (distance - travel) % OCEAN_WAVE_PERIOD
          + OCEAN_WAVE_PERIOD
        ) % OCEAN_WAVE_PERIOD;
        const intensity = (1 + Math.cos(
          Math.PI * 2 * offset / OCEAN_WAVE_PERIOD,
        )) / 2;
        if (intensity < OCEAN_WAVE_CREST_THRESHOLD) {
          level = Math.round(
            intensity / OCEAN_WAVE_CREST_THRESHOLD
            * (OCEAN_WAVE_BASE_LEVELS - 1),
          );
        } else {
          const crestProgress = (
            intensity - OCEAN_WAVE_CREST_THRESHOLD
          ) / (1 - OCEAN_WAVE_CREST_THRESHOLD);
          level = OCEAN_WAVE_BASE_LEVELS + Math.round(
            crestProgress
            * (OCEAN_WAVE_RAMP.length - OCEAN_WAVE_BASE_LEVELS - 1),
          );
        }
      }

      const foreground = level === null ? COLOR.bright : OCEAN_WAVE_RAMP[level];
      const attr = (cell[0] & ~FOREGROUND_MASK) | (foreground << 9);

      if (cell[0] !== attr) {
        cell[0] = attr;
        line.dirty = true;
      }
    }
  }
}

// Blessed's focus/grabKeys path is terminal-dependent. Intercept at the
// program level instead, briefly locking the downstream screen handler so a
// celebration key cannot also trigger dashboard commands.
export function installCelebrationKeyInterceptor(
  program,
  screen,
  isActive,
  dismiss,
  navigate = () => false,
) {
  const intercept = (ch, key) => {
    if (!isActive()) {
      return;
    }

    const previousLock = screen.lockKeys;
    screen.lockKeys = true;

    try {
      const keyName = String(key?.name || key?.full || '').toLowerCase();
      const navigated = (keyName === 'left' || keyName === 'right')
        && navigate(keyName) === true;

      if (!navigated) {
        dismiss();
      }
    } finally {
      queueMicrotask(() => {
        if (!screen.destroyed) {
          screen.lockKeys = previousLock;
        }
      });
    }
  };

  program.prependListener('keypress', intercept);
  return () => program.removeListener('keypress', intercept);
}

export function playCelebrationBell(program, setTimer = setTimeout) {
  return CELEBRATION_BELL_PATTERN_MS.map((delay) => setTimer(() => {
    try {
      program.bell();
    } catch {
      // Terminal bells are best-effort and may be disabled by the terminal.
    }
  }, delay));
}

export function dashboardGeometry(screenWidth, providerCount = 1) {
  const screen = Math.max(1, Number(screenWidth) || 80);
  const maxWidth = providerCount > 1 ? WIDE_DASHBOARD_WIDTH : SINGLE_DASHBOARD_WIDTH;
  const width = Math.min(screen, maxWidth);
  return {
    width,
    left: Math.floor((screen - width) / 2),
  };
}

export function dashboardContentLayout(shellWidth, { mode = 'compact', providerCount = 1 } = {}) {
  const contentWidth = Math.max(1, (Number(shellWidth) || 80) - DASHBOARD_CHROME_WIDTH);
  const minColumnWidth = mode === 'detail' ? DETAIL_COLUMN_WIDTH : COMPACT_COLUMN_WIDTH;
  const canUseColumns = providerCount > 1
    && contentWidth >= minColumnWidth * 2 + COLUMN_GAP_WIDTH;

  if (canUseColumns) {
    const columnWidth = Math.floor((contentWidth - COLUMN_GAP_WIDTH) / 2);
    const usedWidth = columnWidth * 2 + COLUMN_GAP_WIDTH;
    return {
      columns: 2,
      contentWidth,
      columnWidth,
      gapWidth: COLUMN_GAP_WIDTH,
      indent: Math.floor((contentWidth - usedWidth) / 2),
      // Keep provider placement stable while asynchronous snapshots load.
      // Detail puts fewer (and usually taller) local-usage blocks on the left.
      splitIndex: mode === 'detail'
        ? Math.max(1, Math.floor(providerCount / 2))
        : Math.ceil(providerCount / 2),
    };
  }

  const columnWidth = contentWidthFor(shellWidth);
  return {
    columns: 1,
    contentWidth,
    columnWidth,
    gapWidth: 0,
    indent: Math.max(0, Math.floor((contentWidth - columnWidth) / 2)),
    splitIndex: providerCount,
  };
}

export function visibleCellWidth(value) {
  return cellWidth(value);
}

function blockLines(block) {
  const normalized = String(block ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalized.split('\n');
}

function padTaggedLine(line, width) {
  const fitted = truncateTagged(line, width);
  return fitted + ' '.repeat(Math.max(0, width - visibleCellWidth(fitted)));
}

export function providerBlocksFitColumn(blocks, width) {
  return blocks.every((block) => blockLines(block).every((line) => visibleCellWidth(line) <= width));
}

export function fitProviderBlock(block, width) {
  return blockLines(block).map((line) => truncateTagged(line, width)).join('\n');
}

function joinProviderBlocks(blocks, width, mode) {
  const separator = mode === 'compact' ? '\n\n' : `\n${sectionSeparator(width)}\n`;
  return blocks.join(separator);
}

function indentProviderContent(content, indent) {
  if (indent <= 0) {
    return content;
  }

  const padding = ' '.repeat(indent);
  return blockLines(content).map((line) => padding + line).join('\n');
}

export function composeProviderColumns(blocks, layout, mode = 'compact') {
  const split = Math.max(1, Math.min(blocks.length - 1, layout.splitIndex));
  const left = blockLines(joinProviderBlocks(blocks.slice(0, split), layout.columnWidth, mode));
  const right = blockLines(joinProviderBlocks(blocks.slice(split), layout.columnWidth, mode));
  const height = Math.max(left.length, right.length);
  const divider = ` {${COLOR.frame}-fg}│{/${COLOR.frame}-fg}  `;
  const indent = ' '.repeat(layout.indent || 0);
  const lines = [];

  for (let index = 0; index < height; index += 1) {
    lines.push(
      indent
      + padTaggedLine(left[index] || '', layout.columnWidth)
      + divider
      + padTaggedLine(right[index] || '', layout.columnWidth),
    );
  }

  return lines.join('\n');
}

export function rainbowText(value, phase = 0) {
  const offset = Number.isFinite(Number(phase)) ? Math.trunc(Number(phase)) : 0;
  return [...String(value)].map((char, index) => {
    const colorIndex = ((index - offset) % RAINBOW_COLORS.length + RAINBOW_COLORS.length) % RAINBOW_COLORS.length;
    const color = RAINBOW_COLORS[colorIndex];
    return `{${color}-fg}${escapeBlessed(char)}{/${color}-fg}`;
  }).join('');
}

export function rainbowTitle(title = DASHBOARD_TITLE) {
  return rainbowText(title);
}

export function formatProviderSectionTitle({
  title,
  index = 0,
  providerCount = 1,
  celebrating = false,
  phase = 0,
} = {}) {
  if (providerCount <= 1 && !celebrating) {
    return '';
  }

  const number = providerCount > 1 ? ` [${index + 1}]` : '';
  const marker = `{${COLOR.accent}-fg}{bold}▌${number}{/bold}{/${COLOR.accent}-fg}`;
  const name = celebrating
    ? `{bold}${rainbowText(title, phase)}{/bold}`
    : `{${COLOR.accent}-fg}{bold}${escapeBlessed(title)}{/bold}{/${COLOR.accent}-fg}`;
  return `${marker} ${name}\n`;
}

export function dashboardLabel({
  title = DASHBOARD_TITLE,
  subtitle = DASHBOARD_SUBTITLE,
  commandPrefix = '',
  width = 80,
} = {}) {
  const available = Math.max(0, width - 4);
  const fittedPrefix = truncateVisible(String(commandPrefix).trim(), available);
  const prefixWidth = cellWidth(fittedPrefix);
  const fittedTitle = truncateVisible(title, Math.max(0, available - prefixWidth - (fittedPrefix ? 1 : 0)));
  const prefix = fittedPrefix
    ? `{${COLOR.muted}-fg}${escapeBlessed(fittedPrefix)}{/${COLOR.muted}-fg}${fittedTitle ? ' ' : ''}`
    : '';
  const tagline = width >= 64 && subtitle
    ? ` {${COLOR.muted}-fg}· ${escapeBlessed(subtitle)}{/${COLOR.muted}-fg}`
    : '';
  return available > 0 ? ` ${prefix}${rainbowTitle(fittedTitle)}${tagline} ` : '';
}

export function syncDashboardLabel(dashboard, label) {
  dashboard.setLabel(label);
}

export function selectResetHistoryEntry(events, index = 0) {
  const history = Array.isArray(events) ? events : [];

  if (history.length === 0) {
    return null;
  }

  const numericIndex = Number(index);
  const requestedIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0;
  const normalizedIndex = (
    (requestedIndex % history.length) + history.length
  ) % history.length;

  return {
    event: history[normalizedIndex],
    index: normalizedIndex,
    count: history.length,
  };
}

export function formatResetHistory(events, { width = 72 } = {}) {
  const available = Math.max(1, Math.floor(Number(width) || 72));
  const lines = [
    `{${COLOR.muted}-fg}Detected time (local) · newest first{/${COLOR.muted}-fg}`,
    '',
  ];

  for (const event of Array.isArray(events) ? events : []) {
    const detectedAt = new Date(event?.detectedAt);
    const timestamp = Number.isNaN(detectedAt.getTime()) ? 'unknown' : formatDateTime(detectedAt);
    const provider = escapeBlessed(event?.provider || event?.providerId || 'Unknown provider');
    const labels = [...new Set((Array.isArray(event?.windows) ? event.windows : [])
      .map((window) => String(window?.label || window?.key || '').trim())
      .filter(Boolean))];
    const windows = labels.length > 0
      ? ` {${COLOR.muted}-fg}· ${escapeBlessed(labels.join(', '))}{/${COLOR.muted}-fg}`
      : '';
    lines.push(truncateTagged(
      `{${COLOR.secondary}-fg}${escapeBlessed(timestamp)}{/${COLOR.secondary}-fg}  {bold}${provider}{/bold}${windows}`,
      available,
    ));
  }

  lines.push(
    '',
    truncateTagged(`{${COLOR.accent}-fg}{bold}↑/↓/PgUp/PgDn{/bold}{/${COLOR.accent}-fg} scroll · {${COLOR.accent}-fg}{bold}t/Esc{/bold}{/${COLOR.accent}-fg} close`, available),
  );
  return lines.join('\n');
}

function renderBlockText(value, scale = 1) {
  const glyphs = [...String(value || '').toUpperCase()]
    .map((character) => CELEBRATION_GLYPHS[character] || CELEBRATION_GLYPHS[' ']);
  const horizontalScale = Math.max(1, Math.floor(Number(scale) || 1));

  return Array.from({ length: 7 }, (_, row) => glyphs
    .map((glyph) => [...glyph[row]]
      .map((pixel) => (pixel === '1' ? '█' : ' ').repeat(horizontalScale))
      .join(''))
    .join(' '));
}

function blockTextWidth(value, scale = 1) {
  const lines = renderBlockText(value, scale);
  return lines.length > 0 ? Math.max(...lines.map(cellWidth)) : 0;
}

function largestBlockScale(value, width) {
  for (let scale = 3; scale >= 1; scale -= 1) {
    if (blockTextWidth(value, scale) <= width) {
      return scale;
    }
  }

  return 0;
}

function celebrationTitleLines(width, height, trailingLineCount) {
  const fullScale = largestBlockScale('FREE RESET!', width);
  const splitScale = Math.min(
    largestBlockScale('FREE', width),
    largestBlockScale('RESET!', width),
  );
  const compactScale = largestBlockScale('RESET!', width);
  const singleRowFits = height >= 7 + trailingLineCount;
  const splitRowsFit = height >= 15 + trailingLineCount;

  if (splitRowsFit && splitScale > fullScale) {
    return [
      ...renderBlockText('FREE', splitScale),
      '',
      ...renderBlockText('RESET!', splitScale),
    ];
  }

  if (singleRowFits && compactScale > fullScale) {
    return renderBlockText('RESET!', compactScale);
  }

  if (singleRowFits && fullScale > 0) {
    return renderBlockText('FREE RESET!', fullScale);
  }

  return null;
}

export function formatResetAlert(resetNotice, { width = 60, height = 24 } = {}) {
  const available = Math.max(1, Math.floor(Number(width) || 60));
  const availableHeight = Math.max(1, Math.floor(Number(height) || 24));
  const names = [...new Set((Array.isArray(resetNotice?.providers) ? resetNotice.providers : [])
    .map((provider) => String(provider || '').trim())
    .filter(Boolean))];
  const subject = names.length === 0
    ? 'Your quota'
    : names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} +${names.length - 2} providers`;
  const resetText = names.length <= 1 ? 'got a free reset!' : 'got free resets!';
  const detectedAt = resetNotice?.detectedAt ? new Date(resetNotice.detectedAt) : null;
  const validDetectedAt = detectedAt && !Number.isNaN(detectedAt.getTime()) ? detectedAt : null;
  const numericHistoryIndex = Number(resetNotice?.historyIndex);
  const historyCount = Math.max(0, Math.trunc(Number(resetNotice?.historyCount) || 0));
  const browsingHistory = historyCount > 0 && Number.isInteger(numericHistoryIndex);
  const trailingLineCount = validDetectedAt ? 5 : 4;
  const titleLines = celebrationTitleLines(available, availableHeight, trailingLineCount);
  const lines = titleLines
    ? titleLines.map((line) => line
      ? `{${COLOR.bright}-fg}${line}{/${COLOR.bright}-fg}`
      : '')
    : [`{${COLOR.bright}-fg}{bold}FREE RESET DETECTED!{/bold}{/${COLOR.bright}-fg}`];

  lines.push('', `{${COLOR.bright}-fg}{bold}${escapeBlessed(`${subject} ${resetText}`)}{/bold}{/${COLOR.bright}-fg}`);

  if (validDetectedAt) {
    lines.push(`{${COLOR.bright}-fg}{bold}Detected at ${escapeBlessed(formatDateTime(validDetectedAt))}{/bold}{/${COLOR.bright}-fg}`);
  }

  if (browsingHistory) {
    lines.push(
      '',
      `{${COLOR.bright}-fg}{bold}PRESS ANY OTHER KEY TO KEEP CREATING{/bold}{/${COLOR.bright}-fg}`,
    );
  } else {
    lines.push(
      '',
      `{${COLOR.bright}-fg}{bold}PRESS ANY KEY TO KEEP CREATING{/bold}{/${COLOR.bright}-fg}`,
    );
  }

  return lines.map((line) => truncateTagged(line, available)).join('\n');
}

export function resetCelebrationLayout(
  resetNotice,
  { screenWidth = 80, screenHeight = 24 } = {},
) {
  const terminalWidth = Math.max(1, Math.floor(Number(screenWidth) || 80));
  const terminalHeight = Math.max(1, Math.floor(Number(screenHeight) || 24));
  const maxFrameWidth = Math.max(1, Math.min(SINGLE_DASHBOARD_WIDTH, terminalWidth - 2));
  const maxFrameHeight = Math.max(1, terminalHeight - 2);
  const content = formatResetAlert(resetNotice, {
    width: Math.max(1, maxFrameWidth - CELEBRATION_FRAME_CHROME_WIDTH),
    height: Math.max(1, maxFrameHeight - CELEBRATION_FRAME_CHROME_HEIGHT),
  });
  const lines = content.split('\n');
  const contentWidth = Math.max(1, ...lines.map(visibleCellWidth));

  return {
    width: Math.min(maxFrameWidth, contentWidth + CELEBRATION_FRAME_CHROME_WIDTH),
    height: Math.min(maxFrameHeight, lines.length + CELEBRATION_FRAME_CHROME_HEIGHT),
    content,
  };
}

// Generic dashboard shell. Each provider supplies:
//   { id, title, refreshMs, fetch(), render(snapshot, width),
//     headerStatus(snapshot) -> {ok, text}, alertItems?(snapshot) -> [{key,label,percent,resetAt?}],
//     nextDelayMs?(snapshot, refreshMs) -> ms }
export function runDashboard({
  screenTitle,
  title = DASHBOARD_TITLE,
  subtitle = DASHBOARD_SUBTITLE,
  commandPrefix = '',
  terminal,
  providers,
  colorMode = uiColorMode(),
  initialResetHistory = [],
  saveResetEvent = async (event) => [event],
}) {
  const FOOTER_HEIGHT = 2;
  const useColor = colorMode !== 'none';
  const themed = (content) => useColor ? content : stripBlessedColorTags(content);
  // Preserve the terminal's configured background instead of painting a
  // black panel that clashes with dark-gray and custom terminal themes.
  const background = DASHBOARD_BACKGROUND;
  const foreground = useColor ? COLOR.text : 'default';
  const frame = useColor ? COLOR.frame : 'default';

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    terminal: terminal || terminalProfile(),
    title: screenTitle,
  });
  const shell = dashboardGeometry(screen.width, providers.length);
  let resetCelebration = null;
  let resetAnimationTimer = null;
  let celebrationBellTimers = [];
  let celebrationPhase = 0;

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: shell.left,
    width: shell.width,
    height: FOOTER_HEIGHT,
    tags: true,
    wrap: false,
    padding: { left: 2, right: 2 },
    style: { bg: background, fg: foreground },
  });

  const dashboard = blessed.box({
    parent: screen,
    label: themed(dashboardLabel({ title, subtitle, commandPrefix, width: shell.width })),
    top: 0,
    left: shell.left,
    width: shell.width,
    bottom: FOOTER_HEIGHT,
    tags: true,
    border: 'line',
    padding: { left: 2, right: 2, top: 1, bottom: 1 },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    wrap: false,
    scrollbar: {
      ch: ' ',
      track: { bg: background },
      style: { bg: useColor ? COLOR.muted : 'default' },
    },
    content: themed(`{${COLOR.secondary}-fg}Loading usage data...{/${COLOR.secondary}-fg}`),
    style: {
      bg: background,
      border: { fg: frame },
      label: { fg: frame, bold: true },
      fg: foreground,
    },
  });

  dashboard.on('render', (coords) => {
    applyRoundedCorners(screen.lines, coords);
  });

  const renderDashboardLabel = () => {
    const label = themed(dashboardLabel({
      title,
      subtitle,
      commandPrefix,
      width: dashboardGeometry(screen.width, providers.length).width,
    }));
    syncDashboardLabel(dashboard, label);
  };

  const states = providers.map((provider) => ({
    provider,
    snapshot: null,
    updatedAt: null,
    refreshing: false,
    timer: null,
  }));
  const quotaObservations = new Map();
  const alerts = [];
  let clockTimer = null;
  let mode = 'compact';
  let resetHistory = (Array.isArray(initialResetHistory) ? initialResetHistory : [])
    .slice()
    .sort((left, right) => Date.parse(right?.detectedAt) - Date.parse(left?.detectedAt));

  const helpGeometry = () => {
    const width = Math.max(4, Math.min(74, screen.width - 2));
    const content = themed(formatHelp({
      npxMode: commandPrefix === 'npx',
      resetHistoryAvailable: resetHistory.length > 0,
      width: Math.max(1, width - DASHBOARD_CHROME_WIDTH),
    }));
    const contentHeight = content.split('\n').length;
    return {
      width,
      height: Math.max(4, Math.min(contentHeight + 4, screen.height - 2)),
      content,
    };
  };
  const initialHelp = helpGeometry();
  const help = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: initialHelp.width,
    height: initialHelp.height,
    label: ' Help ',
    tags: true,
    border: 'line',
    padding: { left: 2, right: 2, top: 1, bottom: 1 },
    wrap: false,
    content: initialHelp.content,
    style: {
      bg: background,
      fg: foreground,
      border: { fg: frame },
      label: { fg: frame, bold: true },
    },
  });

  help.on('render', (coords) => {
    applyRoundedCorners(screen.lines, coords);
  });

  const renderHelp = () => {
    const geometry = helpGeometry();
    help.width = geometry.width;
    help.height = geometry.height;
    help.setContent(geometry.content);
  };

  const resetHistoryGeometry = () => {
    const width = Math.max(4, Math.min(92, screen.width - 2));
    const content = themed(formatResetHistory(resetHistory, {
      width: Math.max(1, width - DASHBOARD_CHROME_WIDTH - 1),
    }));
    const contentHeight = content.split('\n').length;
    return {
      width,
      height: Math.max(4, Math.min(contentHeight + 4, screen.height - 2)),
      content,
    };
  };
  const initialResetHistoryGeometry = resetHistoryGeometry();
  const resetHistoryView = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: initialResetHistoryGeometry.width,
    height: initialResetHistoryGeometry.height,
    label: ' Reset History ',
    tags: true,
    border: 'line',
    padding: { left: 2, right: 2, top: 1, bottom: 1 },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    wrap: false,
    scrollbar: {
      ch: ' ',
      track: { bg: background },
      style: { bg: useColor ? COLOR.muted : 'default' },
    },
    content: initialResetHistoryGeometry.content,
    style: {
      bg: background,
      fg: foreground,
      border: { fg: frame },
      label: { fg: frame, bold: true },
    },
  });

  resetHistoryView.on('render', (coords) => {
    applyRoundedCorners(screen.lines, coords);
  });

  const renderResetHistory = () => {
    const geometry = resetHistoryGeometry();
    resetHistoryView.width = geometry.width;
    resetHistoryView.height = geometry.height;
    resetHistoryView.setContent(geometry.content);
  };

  const initialResetFrame = resetCelebrationLayout({}, {
    screenWidth: screen.width,
    screenHeight: screen.height,
  });
  const resetFrame = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: initialResetFrame.width,
    height: initialResetFrame.height,
    label: themed(dashboardLabel({ title, subtitle, commandPrefix, width: initialResetFrame.width })),
    tags: true,
    border: 'line',
    padding: {
      left: CELEBRATION_FRAME_HORIZONTAL_PADDING,
      right: CELEBRATION_FRAME_HORIZONTAL_PADDING,
      top: CELEBRATION_FRAME_VERTICAL_PADDING,
      bottom: CELEBRATION_FRAME_VERTICAL_PADDING,
    },
    align: 'center',
    valign: 'middle',
    wrap: false,
    style: {
      bg: useColor ? COLOR.black : background,
      fg: useColor ? COLOR.bright : foreground,
      border: { fg: frame },
      label: { fg: frame, bold: true },
    },
  });

  resetFrame.on('render', (coords) => {
    applyRoundedCorners(screen.lines, coords);

    if (resetCelebration && useColor) {
      applyOceanTextWave(screen.lines, celebrationPhase, {
        xi: coords.xi + 1,
        xl: coords.xl - 1,
        yi: coords.yi + 1,
        yl: coords.yl - 1,
      });
    }
  });

  const renderResetCelebration = () => {
    if (!resetCelebration) {
      return;
    }

    const notice = {
      providers: [...resetCelebration.providers],
      detectedAt: resetCelebration.detectedAt,
      windows: resetCelebration.windows,
      historyIndex: resetCelebration.historyIndex,
      historyCount: resetCelebration.historyCount,
    };
    const layout = resetCelebrationLayout(notice, {
      screenWidth: screen.width,
      screenHeight: screen.height,
    });
    resetFrame.width = layout.width;
    resetFrame.height = layout.height;
    resetFrame.setLabel(themed(dashboardLabel({
      title,
      subtitle,
      commandPrefix,
      width: layout.width,
    })));
    resetFrame.setContent(themed(layout.content));
  };

  const renderFooter = () => {
    footer.setContent(themed(formatFooter({
      states,
      alerts,
      mode,
      hasResetHistory: resetHistory.length > 0,
      width: dashboardGeometry(screen.width, states.length).width,
    })));
  };

  const dismissResetCelebration = () => {
    if (!resetCelebration) {
      return false;
    }

    const restoreHelp = resetCelebration.restoreHelp;
    const restoreResetHistory = resetCelebration.restoreResetHistory;
    resetCelebration = null;
    clearInterval(resetAnimationTimer);
    resetAnimationTimer = null;
    celebrationBellTimers.forEach(clearTimeout);
    celebrationBellTimers = [];
    celebrationPhase = 0;
    resetFrame.hide();
    dashboard.show();
    footer.show();

    renderDashboardLabel();
    renderContent();
    renderFooter();

    if (restoreHelp) {
      help.show();
      help.setFront();
      help.focus();
    } else if (restoreResetHistory) {
      resetHistoryView.show();
      resetHistoryView.setFront();
      resetHistoryView.focus();
    } else {
      dashboard.focus();
      footer.setFront();
    }

    screen.render();
    return true;
  };

  const beginResetCelebration = () => {
    if (!resetCelebration) {
      resetCelebration = {
        providers: new Set(),
        rainbowProviders: new Set(),
        rainbowAll: false,
        detectedAt: null,
        windows: [],
        historyIndex: null,
        historyCount: 0,
        restoreHelp: !help.hidden,
        restoreResetHistory: !resetHistoryView.hidden,
      };
      dashboard.hide();
      footer.hide();
      help.hide();
      resetHistoryView.hide();
      renderDashboardLabel();

      if (useColor) {
        const animationStartedAt = Date.now();
        resetAnimationTimer = setInterval(() => {
          celebrationPhase = (Date.now() - animationStartedAt) * OCEAN_WAVE_SPEED;
          screen.render();
        }, CELEBRATION_ANIMATION_FRAME_MS);
      }

      celebrationBellTimers = playCelebrationBell(screen.program);
    }
  };

  const presentResetCelebration = () => {
    renderContent();
    renderFooter();
    renderResetCelebration();
    resetFrame.show();
    resetFrame.setFront();
    screen.render();
  };

  const showResetCelebration = (providerTitle, { rainbowAll = false, detectedAt = null } = {}) => {
    beginResetCelebration();

    if (resetCelebration.historyIndex !== null) {
      resetCelebration.providers.clear();
      resetCelebration.rainbowProviders.clear();
      resetCelebration.rainbowAll = false;
      resetCelebration.detectedAt = null;
    }

    resetCelebration.windows = [];
    resetCelebration.historyIndex = null;
    resetCelebration.historyCount = 0;

    resetCelebration.providers.add(providerTitle);
    resetCelebration.rainbowAll ||= rainbowAll;

    if (detectedAt && !Number.isNaN(new Date(detectedAt).getTime())) {
      resetCelebration.detectedAt = new Date(detectedAt).toISOString();
    }

    if (!rainbowAll) {
      resetCelebration.rainbowProviders.add(providerTitle);
    }

    presentResetCelebration();
  };

  const showResetHistoryCelebration = (index = 0) => {
    const selection = selectResetHistoryEntry(resetHistory, index);

    if (!selection) {
      return false;
    }

    beginResetCelebration();
    const { event } = selection;
    const providerTitle = String(event?.provider || event?.providerId || 'Unknown provider');
    const detectedAt = event?.detectedAt ? new Date(event.detectedAt) : null;

    resetCelebration.providers = new Set([providerTitle]);
    resetCelebration.rainbowProviders = new Set([providerTitle]);
    resetCelebration.rainbowAll = false;
    resetCelebration.detectedAt = detectedAt && !Number.isNaN(detectedAt.getTime())
      ? detectedAt.toISOString()
      : null;
    resetCelebration.windows = Array.isArray(event?.windows) ? event.windows : [];
    resetCelebration.historyIndex = selection.index;
    resetCelebration.historyCount = selection.count;
    presentResetCelebration();
    return true;
  };

  const navigateResetHistory = (direction) => {
    if (!Number.isInteger(resetCelebration?.historyIndex)) {
      return false;
    }

    const offset = direction === 'left' ? -1 : 1;
    return showResetHistoryCelebration(resetCelebration.historyIndex + offset);
  };

  const removeCelebrationKeyInterceptor = installCelebrationKeyInterceptor(
    screen.program,
    screen,
    () => !!resetCelebration,
    dismissResetCelebration,
    navigateResetHistory,
  );

  let lastContent = null;
  let lastLineCount = 0;
  let lastLineWidths = [];

  // Force blessed to repaint every cell of the dashboard region on the next
  // render. Its render() skips any line whose `dirty` flag is false, and for
  // the rest only writes cells that differ from the shadow buffer (olines).
  // When content reflows — blocks shifting as providers load in at different
  // times — a moved line's old glyphs can be left stranded on screen. Marking
  // the region's lines dirty and invalidating their shadow cells makes the
  // next render re-emit the whole region, wiping the residue. Only done on a
  // structural change (line count), so live countdown ticks (same shape) still
  // update through the cheap diff with no full repaint.
  const invalidateDashboardRegion = () => {
    const { lines, olines } = screen;

    for (let y = 0; y < screen.height - FOOTER_HEIGHT; y += 1) {
      if (lines?.[y]) {
        lines[y].dirty = true;
      }

      if (olines?.[y]) {
        for (const cell of olines[y]) {
          cell[0] = -1; // an attr no real cell matches → forces a re-emit
        }
      }
    }
  };

  // Rebuilds the body and only pushes it to the box when the text actually
  // changed. Called every second (for live sub-hour countdowns) as well as on
  // refresh/resize/mode-toggle; the string compare keeps the common
  // nothing-changed second cheap and leaves the scroll position untouched.
  const renderContent = () => {
    const shell = dashboardGeometry(screen.width, states.length);
    let content;

    if (shell.width < MIN_DASHBOARD_WIDTH) {
      const width = Math.max(1, shell.width - DASHBOARD_CHROME_WIDTH);
      content = [
        truncateTagged(`{${COLOR.warning}-fg}{bold}Terminal too narrow{/bold}{/${COLOR.warning}-fg}`, width),
        truncateTagged(
          `{${COLOR.muted}-fg}Resize to at least ${MIN_DASHBOARD_WIDTH} columns (${shell.width} now).{/${COLOR.muted}-fg}`,
          width,
        ),
      ].join('\n');
    } else {
      const layout = dashboardContentLayout(shell.width, { mode, providerCount: states.length });
      const renderBlocks = (width) => states.map((state, index) => {
        const celebrating = !!resetCelebration && (
          resetCelebration.rainbowAll
          || resetCelebration.rainbowProviders.has(state.provider.title)
        );
        const sectionTitle = formatProviderSectionTitle({
          title: state.provider.title,
          index,
          providerCount: states.length,
          celebrating,
          phase: celebrationPhase,
        });

        if (!state.snapshot) {
          return fitProviderBlock(`${sectionTitle}  {${COLOR.secondary}-fg}loading...{/${COLOR.secondary}-fg}`, width);
        }

        return fitProviderBlock(sectionTitle + state.provider.render(state.snapshot, width, mode), width);
      });
      const blocks = renderBlocks(layout.columnWidth);

      content = layout.columns === 2
        ? composeProviderColumns(blocks, layout, mode)
        : indentProviderContent(joinProviderBlocks(blocks, layout.columnWidth, mode), layout.indent);
    }

    content = themed(content);

    if (content === lastContent) {
      return;
    }

    const contentLines = blockLines(content);
    const lineCount = contentLines.length;
    const lineWidths = contentLines.map(visibleCellWidth);
    const reflowed = lineCount !== lastLineCount
      || lineWidths.some((lineWidth, index) => lineWidth !== lastLineWidths[index]);
    lastContent = content;
    lastLineCount = lineCount;
    lastLineWidths = lineWidths;
    dashboard.setContent(content);

    if (reflowed) {
      invalidateDashboardRegion();
    }
  };

  const processAlerts = async (state) => {
    if (!state.provider.alertItems || !state.snapshot) {
      return;
    }

    const now = Date.now();
    const maxObservationAgeMs = Math.max(
      RESET_HISTORY_MIN_AGE_MS,
      (Number(state.provider.refreshMs) || 0) * 3,
    );
    const unexpectedResetWindows = [];

    for (const item of state.provider.alertItems(state.snapshot)) {
      const key = `${state.provider.id}:${item.key}`;
      const current = {
        percent: Number(item.percent),
        resetAt: item.resetAt ?? null,
        observedAt: now,
      };
      const previous = quotaObservations.get(key);

      if (!Number.isFinite(current.percent)) {
        continue;
      }

      quotaObservations.set(key, current);

      if (isUnexpectedQuotaReset(previous, current, { now, maxObservationAgeMs })) {
        unexpectedResetWindows.push({
          key: item.key,
          label: item.label || item.key,
        });
      }

      if (!Number.isFinite(previous?.percent)) {
        continue;
      }

      for (const threshold of ALERT_THRESHOLDS) {
        if (previous.percent < threshold && current.percent >= threshold) {
          alerts.push({
            at: now,
            text: `${state.provider.title} · ${item.label} crossed ${threshold}% (now ${Math.round(current.percent)}%)`,
          });

          try {
            screen.program.bell();
          } catch {
            // bell is best-effort
          }
        }
      }
    }

    if (unexpectedResetWindows.length > 0) {
      const event = {
        providerId: state.provider.id,
        provider: state.provider.title,
        windows: unexpectedResetWindows,
        detectedAt: new Date(now).toISOString(),
      };
      resetHistory = [event, ...resetHistory].slice(0, 100);

      try {
        const persisted = await saveResetEvent(event);

        if (Array.isArray(persisted)) {
          resetHistory = persisted;
        }
      } catch {
        alerts.push({
          at: now,
          text: 'Reset detected, but its history could not be saved',
        });
      }

      renderHelp();
      renderResetHistory();
      showResetCelebration(state.provider.title, { detectedAt: event.detectedAt });
    }

    while (alerts.length > 5) {
      alerts.shift();
    }
  };

  const scheduleNext = (state) => {
    const base = state.provider.refreshMs;
    const delayMs = state.provider.nextDelayMs
      ? state.provider.nextDelayMs(state.snapshot, base)
      : base;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => refresh(state), delayMs);
  };

  const refresh = async (state) => {
    if (state.refreshing) {
      return;
    }

    state.refreshing = true;
    renderFooter();
    screen.render();

    try {
      state.snapshot = await state.provider.fetch();
      state.updatedAt = new Date();
      await processAlerts(state);
    } catch (error) {
      state.snapshot = { fatal: error?.message || String(error) };
      state.updatedAt = new Date();
    }

    state.refreshing = false;
    renderContent();
    renderFooter();
    scheduleNext(state);
    screen.render();
  };

  const overlaysHidden = () => help.hidden && resetHistoryView.hidden;

  screen.key(['r'], () => {
    if (!overlaysHidden()) {
      return;
    }

    states.forEach((state) => refresh(state));
  });

  screen.key(['d'], () => {
    if (!overlaysHidden()) {
      return;
    }

    mode = mode === 'compact' ? 'detail' : 'compact';
    dashboard.setScroll(0);
    renderContent();
    renderFooter();
    screen.render();
  });

  screen.key(['?', 'h'], () => {
    if (help.hidden) {
      if (!resetHistoryView.hidden) {
        resetHistoryView.hide();
      }

      renderHelp();
      help.show();
      help.setFront();
      help.focus();
    } else {
      help.hide();
      dashboard.focus();
      footer.setFront();
    }

    screen.render();
  });

  screen.key(['t'], () => {
    if (!overlaysHidden()) {
      return;
    }

    if (!showResetHistoryCelebration(0)) {
      showResetCelebration('You', { rainbowAll: true });
    }
  });

  // blessed's keys/vi only bind arrows and ctrl-b/ctrl-f; page keys scroll a
  // full page like ctrl-f/ctrl-b do.
  dashboard.key(['pageup', 'pagedown'], (ch, key) => {
    dashboard.scroll(key.name === 'pageup' ? -(dashboard.height || 1) : dashboard.height || 1);
    screen.render();
  });
  resetHistoryView.key(['pageup', 'pagedown'], (ch, key) => {
    resetHistoryView.scroll(key.name === 'pageup'
      ? -(resetHistoryView.height || 1)
      : resetHistoryView.height || 1);
    screen.render();
  });
  states.forEach((state, index) => {
    if (index < 9) {
      screen.key([String(index + 1)], () => {
        if (overlaysHidden()) {
          refresh(state);
        }
      });
    }
  });

  const exitDashboard = () => {
    states.forEach((state) => clearTimeout(state.timer));
    clearInterval(clockTimer);
    clearInterval(resetAnimationTimer);
    celebrationBellTimers.forEach(clearTimeout);
    removeCelebrationKeyInterceptor();
    screen.destroy();
    process.exit(0);
  };

  screen.key(['escape'], () => {
    if (!help.hidden) {
      help.hide();
      dashboard.focus();
      footer.setFront();
      screen.render();
      return;
    }

    if (!resetHistoryView.hidden) {
      resetHistoryView.hide();
      dashboard.focus();
      footer.setFront();
      screen.render();
      return;
    }

    exitDashboard();
  });
  screen.key(['q', 'C-c'], exitDashboard);

  screen.on('resize', () => {
    const nextShell = dashboardGeometry(screen.width, states.length);
    dashboard.left = nextShell.left;
    dashboard.width = nextShell.width;
    renderDashboardLabel();
    footer.left = nextShell.left;
    footer.width = nextShell.width;
    renderHelp();
    renderResetHistory();
    renderResetCelebration();
    renderContent();
    renderFooter();

    if (!resetFrame.hidden) {
      resetFrame.setFront();
    }

    screen.render();
  });

  footer.setFront();
  dashboard.focus();
  renderHelp();
  renderResetHistory();
  renderFooter();
  screen.render();
  states.forEach((state) => refresh(state));

  clockTimer = setInterval(() => {
    renderFooter();
    renderContent(); // ticks live sub-hour countdowns; a no-op when nothing changed
    screen.render();
  }, 1000);
}

export function formatHelp({ npxMode = false, resetHistoryAvailable = false, width = 64 } = {}) {
  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const lines = [
    '{bold}Keyboard{/bold}',
    `  ${key('r')}        refresh all providers`,
    `  ${key('1-9')}      refresh the numbered provider`,
    `  ${key('d')}        toggle compact / detail`,
    `  ${key('↑↓/PgUp')} scroll dashboard`,
    `  ${key('?/h')}      toggle this help`,
    `  ${key('q/Esc')}    exit (Esc closes a window first)`,
    '',
    '{bold}Legend{/bold}',
    `  {${COLOR.success}-fg}█{/${COLOR.success}-fg} used  {${COLOR.muted}-fg}░ projected{/${COLOR.muted}-fg}  {${COLOR.warning}-fg}▲ ahead of pace{/${COLOR.warning}-fg}`,
  ];

  if (resetHistoryAvailable) {
    lines.splice(5, 0, `  ${key('t')}        replay detected resets`);
  }

  if (npxMode) {
    lines.push(
      '',
      '{bold}Install as a command{/bold}',
      `  ${key('npm i -g tokensleft')}`,
    );
  }

  return lines.map((line) => truncateTagged(line, width)).join('\n');
}

export function formatFooter({
  states,
  alerts,
  mode,
  hasResetHistory = false,
  width = 100,
}) {
  const innerWidth = Math.max(1, Number(width) - 4);
  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const dot = `{${COLOR.muted}-fg}·{/${COLOR.muted}-fg}`;

  if (width < MIN_DASHBOARD_WIDTH) {
    const summary = `{${COLOR.warning}-fg}{bold}Resize terminal · ${width}/${MIN_DASHBOARD_WIDTH} columns{/bold}{/${COLOR.warning}-fg}`;
    const controls = `${key('?/h')} help ${dot} ${key('q')} exit`;
    return `${truncateTagged(summary, innerWidth)}\n${truncateTagged(controls, innerWidth)}`;
  }

  const recentAlert = alerts.length > 0 && Date.now() - alerts[alerts.length - 1].at < ALERT_SHOW_MS
    ? alerts[alerts.length - 1]
    : null;
  const failed = states.filter((state) => {
    if (state.snapshot?.fatal) {
      return true;
    }

    return state.snapshot && state.provider.headerStatus?.(state.snapshot)?.ok === false;
  });
  const loaded = states.filter((state) => state.snapshot).length;
  const refreshing = states.filter((state) => state.refreshing).length;
  let summary;

  if (recentAlert) {
    summary = `{${COLOR.danger}-fg}{bold}⚠ ${escapeBlessed(recentAlert.text)}{/bold}{/${COLOR.danger}-fg}`;
  } else if (failed.length > 0) {
    const names = failed.slice(0, 3).map((state) => state.provider.title).join(', ');
    const extra = failed.length > 3 ? ` +${failed.length - 3}` : '';
    summary = `{${COLOR.danger}-fg}{bold}● ${failed.length} provider${failed.length === 1 ? '' : 's'} need attention{/bold}{/${COLOR.danger}-fg} {${COLOR.muted}-fg}· ${escapeBlessed(names)}${extra}{/${COLOR.muted}-fg}`;
  } else if (loaded < states.length) {
    summary = `{${COLOR.warning}-fg}◌ Loading providers ${loaded}/${states.length}{/${COLOR.warning}-fg}`;
  } else if (refreshing > 0) {
    summary = `{${COLOR.warning}-fg}↻ Refreshing ${refreshing}/${states.length}{/${COLOR.warning}-fg} {${COLOR.muted}-fg}· previous data remains visible{/${COLOR.muted}-fg}`;
  } else {
    const oldestUpdate = states.reduce((oldest, state) => {
      const value = state.updatedAt?.getTime();
      return Number.isFinite(value) ? Math.min(oldest, value) : oldest;
    }, Infinity);
    const age = Number.isFinite(oldestUpdate)
      ? formatRelativeTime(new Date(oldestUpdate)).replace(' ago', '')
      : 'now';
    summary = `{${COLOR.success}-fg}●{/${COLOR.success}-fg} {bold}${states.length}/${states.length} providers healthy{/bold} {${COLOR.muted}-fg}· updated ${escapeBlessed(age)}{/${COLOR.muted}-fg}`;
  }

  const toggle = mode === 'compact' ? 'details' : 'compact';
  const providerRange = states.length > 1 ? key(`1-${Math.min(9, states.length)}`) : '';
  let controls;

  if (width >= 108) {
    controls = [
      `${key('r')} refresh all`,
      providerRange ? `${providerRange} provider` : '',
      `${key('d')} ${toggle}`,
      `${key('↑↓')} scroll`,
      hasResetHistory ? `${key('t')} reset replay` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(`  ${dot}  `);
  } else if (width >= 78) {
    controls = [
      `${key('r')} refresh`,
      providerRange ? `${providerRange} provider` : '',
      `${key('d')} ${toggle}`,
      hasResetHistory ? `${key('t')} replay` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(` ${dot} `);
  } else {
    controls = [
      `${key('r')} refresh`,
      `${key('d')} ${toggle}`,
      hasResetHistory ? `${key('t')} replay` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(` ${dot} `);
  }

  return `${truncateTagged(summary, innerWidth)}\n${truncateTagged(controls, innerWidth)}`;
}

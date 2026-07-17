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
const RAINBOW_FRAME_MS = 90;
const RAINBOW_BAND_WIDTH = 2;
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
const BORDER_CHARACTERS = new Set(['─', '│', '┌', '┐', '└', '┘', '╭', '╮', '╰', '╯']);
const FOREGROUND_MASK = 0x1ff << 9;

export const DASHBOARD_TITLE = 'TokensLeft';
export const DASHBOARD_SUBTITLE = 'Know What’s Left. Keep Creating.';
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

// Blessed's focus/grabKeys path is terminal-dependent. Intercept at the
// program level instead, briefly locking the downstream screen handler so the
// dismissal key cannot also trigger q/r/d or another dashboard command.
export function installCelebrationKeyInterceptor(program, screen, isActive, dismiss) {
  const intercept = () => {
    if (!isActive()) {
      return;
    }

    const previousLock = screen.lockKeys;
    screen.lockKeys = true;

    try {
      dismiss();
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

export function syncDashboardLabel(dashboard, label, hidden = false) {
  if (hidden) {
    dashboard.removeLabel();
    return;
  }

  dashboard.setLabel(label);
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
  const background = useColor ? 'black' : 'default';
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
  let rainbowPhase = 0;

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
      // Distinct but subdued against Codex's dark terminal background.
      bg: background,
      border: { fg: frame },
      label: { fg: frame, bold: true },
      fg: foreground,
    },
  });

  dashboard.on('render', (coords) => {
    applyRoundedCorners(screen.lines, coords);

    if (resetCelebration && useColor) {
      applyRainbowBorder(screen.lines, coords, rainbowPhase);
    }
  });

  const renderDashboardLabel = () => {
    const label = themed(dashboardLabel({
      title,
      subtitle,
      commandPrefix,
      width: dashboardGeometry(screen.width, providers.length).width,
    }));
    syncDashboardLabel(dashboard, label, !!resetCelebration);
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

  const renderFooter = () => {
    footer.setContent(themed(formatFooter({
      states,
      alerts,
      mode,
      resetNotice: resetCelebration
        ? {
            providers: [...resetCelebration.providers],
            detectedAt: resetCelebration.detectedAt,
          }
        : null,
      hasResetHistory: resetHistory.length > 0,
      width: dashboardGeometry(screen.width, states.length).width,
    })));
  };

  const dismissResetCelebration = () => {
    if (!resetCelebration) {
      return false;
    }

    resetCelebration = null;
    clearInterval(resetAnimationTimer);
    resetAnimationTimer = null;
    celebrationBellTimers.forEach(clearTimeout);
    celebrationBellTimers = [];
    rainbowPhase = 0;

    footer.setFront();
    renderDashboardLabel();
    renderContent();
    renderFooter();
    screen.render();
    return true;
  };

  const showResetCelebration = (providerTitle, { rainbowAll = false, detectedAt = null } = {}) => {
    if (!resetCelebration) {
      resetCelebration = {
        providers: new Set(),
        rainbowProviders: new Set(),
        rainbowAll: false,
        detectedAt: null,
      };
      footer.setFront();
      renderDashboardLabel();

      if (useColor) {
        resetAnimationTimer = setInterval(() => {
          rainbowPhase += 2;
          renderContent();
          renderFooter();
          screen.render();
        }, RAINBOW_FRAME_MS);
      }

      celebrationBellTimers = playCelebrationBell(screen.program);
    }

    resetCelebration.providers.add(providerTitle);
    resetCelebration.rainbowAll ||= rainbowAll;

    if (detectedAt && !Number.isNaN(new Date(detectedAt).getTime())) {
      resetCelebration.detectedAt = new Date(detectedAt).toISOString();
    }

    if (!rainbowAll) {
      resetCelebration.rainbowProviders.add(providerTitle);
    }

    renderContent();
    renderFooter();
    screen.render();
  };

  const removeCelebrationKeyInterceptor = installCelebrationKeyInterceptor(
    screen.program,
    screen,
    () => !!resetCelebration,
    dismissResetCelebration,
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
          phase: rainbowPhase,
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
    if (resetHistory.length === 0 || !help.hidden) {
      return;
    }

    if (resetHistoryView.hidden) {
      renderResetHistory();
      resetHistoryView.setScroll(0);
      resetHistoryView.show();
      resetHistoryView.setFront();
      resetHistoryView.focus();
    } else {
      resetHistoryView.hide();
      dashboard.focus();
      footer.setFront();
    }

    screen.render();
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

  // Easter egg: zero is where a freshly reset quota starts.
  screen.key(['0'], () => {
    if (overlaysHidden()) {
      showResetCelebration('You', { rainbowAll: true });
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
    renderContent();
    renderFooter();
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
    lines.splice(5, 0, `  ${key('t')}        show detected reset history`);
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
  resetNotice = null,
  hasResetHistory = false,
  width = 100,
}) {
  const innerWidth = Math.max(1, Number(width) - 4);
  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const dot = `{${COLOR.muted}-fg}·{/${COLOR.muted}-fg}`;

  if (resetNotice?.providers?.length > 0) {
    const names = resetNotice.providers.map(String);
    const subject = names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} +${names.length - 2} providers`;
    const resetText = names.length === 1 ? 'a free reset' : 'free resets';
    const detectedAt = resetNotice.detectedAt ? new Date(resetNotice.detectedAt) : null;
    const summaryText = detectedAt && !Number.isNaN(detectedAt.getTime())
      ? `${subject}: ${names.length === 1 ? 'free reset' : 'free resets'} detected at ${formatDateTime(detectedAt)}!`
      : `${subject} just got ${resetText}!`;
    const summary = `{${COLOR.success}-fg}{bold}${escapeBlessed(summaryText)}{/bold}{/${COLOR.success}-fg}`;
    const prompt = `{${COLOR.accent}-fg}{bold}Press any key to keep creating.{/bold}{/${COLOR.accent}-fg}`;
    return `${truncateTagged(summary, innerWidth)}\n${truncateTagged(prompt, innerWidth)}`;
  }

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
      hasResetHistory ? `${key('t')} reset history` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(`  ${dot}  `);
  } else if (width >= 78) {
    controls = [
      `${key('r')} refresh`,
      providerRange ? `${providerRange} provider` : '',
      `${key('d')} ${toggle}`,
      hasResetHistory ? `${key('t')} resets` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(` ${dot} `);
  } else {
    controls = [
      `${key('r')} refresh`,
      `${key('d')} ${toggle}`,
      hasResetHistory ? `${key('t')} resets` : '',
      `${key('?/h')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(` ${dot} `);
  }

  return `${truncateTagged(summary, innerWidth)}\n${truncateTagged(controls, innerWidth)}`;
}

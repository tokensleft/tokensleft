import blessed from 'blessed';
import {
  cellWidth,
  escapeBlessed,
  formatRelativeTime,
  stripBlessedColorTags,
  truncateTagged,
  truncateVisible,
} from './format.js';
import { COLOR } from './palette.js';
import { contentWidthFor, sectionSeparator } from './render.js';

const ALERT_THRESHOLDS = [80, 90];
const ALERT_SHOW_MS = 5 * 60 * 1000;
const SINGLE_DASHBOARD_WIDTH = 132;
const WIDE_DASHBOARD_WIDTH = 212;
const DASHBOARD_CHROME_WIDTH = 8;
const COLUMN_GAP_WIDTH = 4;
const COMPACT_COLUMN_WIDTH = 74;
const DETAIL_COLUMN_WIDTH = 98;
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

export const DASHBOARD_TITLE = 'TokensLeft';
export const DASHBOARD_SUBTITLE = 'Know your limits before they limit you.';
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

export function rainbowTitle(title = DASHBOARD_TITLE) {
  return [...title].map((char, index) => {
    const color = RAINBOW_COLORS[index % RAINBOW_COLORS.length];
    return `{${color}-fg}${escapeBlessed(char)}{/${color}-fg}`;
  }).join('');
}

export function dashboardLabel({ title = DASHBOARD_TITLE, subtitle = DASHBOARD_SUBTITLE, width = 80 } = {}) {
  const available = Math.max(0, width - 4);
  const fittedTitle = truncateVisible(title, available);
  const tagline = width >= 64 && subtitle
    ? ` {${COLOR.muted}-fg}· ${escapeBlessed(subtitle)}{/${COLOR.muted}-fg}`
    : '';
  return available > 0 ? ` ${rainbowTitle(fittedTitle)}${tagline} ` : '';
}

// Generic dashboard shell. Each provider supplies:
//   { id, title, refreshMs, fetch(), render(snapshot, width),
//     headerStatus(snapshot) -> {ok, text}, alertItems?(snapshot) -> [{key,label,percent}],
//     nextDelayMs?(snapshot, refreshMs) -> ms }
export function runDashboard({
  screenTitle,
  title = DASHBOARD_TITLE,
  subtitle = DASHBOARD_SUBTITLE,
  terminal,
  providers,
  colorMode = uiColorMode(),
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
    label: themed(dashboardLabel({ title, subtitle, width: shell.width })),
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
  });

  const states = providers.map((provider) => ({
    provider,
    snapshot: null,
    updatedAt: null,
    refreshing: false,
    timer: null,
  }));
  const previousPercents = new Map();
  const alerts = [];
  let clockTimer = null;
  let mode = 'compact';

  const helpGeometry = () => ({
    width: Math.max(4, Math.min(74, screen.width - 2)),
    height: Math.max(4, Math.min(16, screen.height - 2)),
  });
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
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    wrap: false,
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
    help.setContent(themed(formatHelp({
      providers,
      width: Math.max(1, Number(help.width) - DASHBOARD_CHROME_WIDTH),
    })));
  };

  const renderFooter = () => {
    footer.setContent(themed(formatFooter({
      states,
      alerts,
      mode,
      width: dashboardGeometry(screen.width, states.length).width,
    })));
  };

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
      const sectionTitle = states.length > 1
          ? `{${COLOR.accent}-fg}{bold}▌ [${index + 1}] ${escapeBlessed(state.provider.title)}{/bold}{/${COLOR.accent}-fg}\n`
        : '';

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

  const processAlerts = (state) => {
    if (!state.provider.alertItems || !state.snapshot) {
      return;
    }

    const now = Date.now();

    for (const item of state.provider.alertItems(state.snapshot)) {
      const key = `${state.provider.id}:${item.key}`;
      const previous = previousPercents.get(key);
      previousPercents.set(key, item.percent);

      if (!Number.isFinite(previous)) {
        continue;
      }

      for (const threshold of ALERT_THRESHOLDS) {
        if (previous < threshold && item.percent >= threshold) {
          alerts.push({
            at: now,
            text: `${state.provider.title} · ${item.label} crossed ${threshold}% (now ${Math.round(item.percent)}%)`,
          });

          try {
            screen.program.bell();
          } catch {
            // bell is best-effort
          }
        }
      }
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
      processAlerts(state);
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

  screen.key(['r'], () => {
    if (!help.hidden) {
      return;
    }

    states.forEach((state) => refresh(state));
  });

  screen.key(['d'], () => {
    if (!help.hidden) {
      return;
    }

    mode = mode === 'compact' ? 'detail' : 'compact';
    dashboard.setScroll(0);
    renderContent();
    renderFooter();
    screen.render();
  });

  screen.key(['?'], () => {
    if (help.hidden) {
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

  // blessed's keys/vi only bind arrows and ctrl-b/ctrl-f; page keys scroll a
  // full page like ctrl-f/ctrl-b do.
  dashboard.key(['pageup', 'pagedown'], (ch, key) => {
    dashboard.scroll(key.name === 'pageup' ? -(dashboard.height || 1) : dashboard.height || 1);
    screen.render();
  });
  help.key(['pageup', 'pagedown'], (ch, key) => {
    help.scroll(key.name === 'pageup' ? -(help.height || 1) : help.height || 1);
    screen.render();
  });

  states.forEach((state, index) => {
    if (index < 9) {
      screen.key([String(index + 1)], () => {
        if (help.hidden) {
          refresh(state);
        }
      });
    }
  });

  const exitDashboard = () => {
    states.forEach((state) => clearTimeout(state.timer));
    clearInterval(clockTimer);
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

    exitDashboard();
  });
  screen.key(['q', 'C-c'], exitDashboard);

  screen.on('resize', () => {
    const nextShell = dashboardGeometry(screen.width, states.length);
    dashboard.left = nextShell.left;
    dashboard.width = nextShell.width;
    dashboard.setLabel(themed(dashboardLabel({ title, subtitle, width: nextShell.width })));
    footer.left = nextShell.left;
    footer.width = nextShell.width;
    const nextHelp = helpGeometry();
    help.width = nextHelp.width;
    help.height = nextHelp.height;
    renderHelp();
    renderContent();
    renderFooter();
    screen.render();
  });

  footer.setFront();
  dashboard.focus();
  renderHelp();
  renderFooter();
  screen.render();
  states.forEach((state) => refresh(state));

  clockTimer = setInterval(() => {
    renderFooter();
    renderContent(); // ticks live sub-hour countdowns; a no-op when nothing changed
    screen.render();
  }, 1000);
}

export function formatHelp({ providers = [], width = 64 } = {}) {
  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const lines = [
    '{bold}Keyboard{/bold}',
    `  ${key('r')}        refresh all providers`,
    `  ${key('1-9')}      refresh the numbered provider`,
    `  ${key('d')}        toggle compact / detail`,
    `  ${key('↑↓/PgUp')} scroll dashboard`,
    `  ${key('?')}        toggle this help`,
    `  ${key('q/Esc')}    exit (Esc closes help first)`,
    '',
    '{bold}Legend{/bold}',
    `  {${COLOR.success}-fg}█{/${COLOR.success}-fg} used  {${COLOR.muted}-fg}░ projected{/${COLOR.muted}-fg}  {${COLOR.warning}-fg}▲ ahead of pace{/${COLOR.warning}-fg}`,
  ];

  if (providers.length > 1) {
    lines.push('', '{bold}Provider shortcuts{/bold}');
    providers.slice(0, 9).forEach((provider, index) => {
      lines.push(`  ${key(String(index + 1))}  ${escapeBlessed(provider.title)}`);
    });
  }

  return lines.map((line) => truncateTagged(line, width)).join('\n');
}

export function formatFooter({ states, alerts, mode, width = 100 }) {
  const innerWidth = Math.max(1, Number(width) - 4);
  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const dot = `{${COLOR.muted}-fg}·{/${COLOR.muted}-fg}`;

  if (width < MIN_DASHBOARD_WIDTH) {
    const summary = `{${COLOR.warning}-fg}{bold}Resize terminal · ${width}/${MIN_DASHBOARD_WIDTH} columns{/bold}{/${COLOR.warning}-fg}`;
    const controls = `${key('?')} help ${dot} ${key('q')} exit`;
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
      `${key('?')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(`  ${dot}  `);
  } else if (width >= 78) {
    controls = [
      `${key('r')} refresh`,
      providerRange ? `${providerRange} provider` : '',
      `${key('d')} ${toggle}`,
      `${key('?')} help`,
      `${key('q')} exit`,
    ].filter(Boolean).join(` ${dot} `);
  } else {
    controls = [
      `${key('r')} refresh`,
      `${key('d')} ${toggle}`,
      `${key('?')} help`,
      `${key('q')} exit`,
    ].join(` ${dot} `);
  }

  return `${truncateTagged(summary, innerWidth)}\n${truncateTagged(controls, innerWidth)}`;
}

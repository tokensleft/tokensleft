import blessed from 'blessed';
import { escapeBlessed, formatRelativeTime, stripBlessedTags } from './format.js';
import { COLOR } from './palette.js';
import { contentWidthFor, sectionSeparator } from './render.js';

const ALERT_THRESHOLDS = [80, 90];
const ALERT_SHOW_MS = 5 * 60 * 1000;
const MAX_DASHBOARD_WIDTH = 132;
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

export function terminalProfile(env = process.env) {
  const override = String(env.TOKENSLEFT_TERM || '').trim();

  if (override) {
    return override;
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

export function dashboardGeometry(screenWidth) {
  const screen = Math.max(1, Number(screenWidth) || 80);
  const width = Math.min(screen, MAX_DASHBOARD_WIDTH);
  return {
    width,
    left: Math.floor((screen - width) / 2),
  };
}

export function rainbowTitle(title = DASHBOARD_TITLE) {
  return [...title].map((char, index) => {
    const color = RAINBOW_COLORS[index % RAINBOW_COLORS.length];
    return `{${color}-fg}${escapeBlessed(char)}{/${color}-fg}`;
  }).join('');
}

export function dashboardLabel({ title = DASHBOARD_TITLE, subtitle = DASHBOARD_SUBTITLE, width = 80 } = {}) {
  const tagline = width >= 64 && subtitle
    ? ` {${COLOR.muted}-fg}· ${escapeBlessed(subtitle)}{/${COLOR.muted}-fg}`
    : '';
  return ` ${rainbowTitle(title)}${tagline} `;
}

// Generic dashboard shell. Each provider supplies:
//   { id, title, refreshMs, fetch(), render(snapshot, width),
//     headerStatus(snapshot) -> {ok, text}, alertItems?(snapshot) -> [{key,label,percent}],
//     nextDelayMs?(snapshot, refreshMs) -> ms }
export function runDashboard({ screenTitle, title = DASHBOARD_TITLE, subtitle = DASHBOARD_SUBTITLE, terminal, providers }) {
  const FOOTER_HEIGHT = 2;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    terminal: terminal || terminalProfile(),
    title: screenTitle,
  });
  const shell = dashboardGeometry(screen.width);

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: shell.left,
    width: shell.width,
    height: FOOTER_HEIGHT,
    tags: true,
    wrap: false,
    padding: { left: 2, right: 2 },
    style: { bg: 'black', fg: COLOR.text },
  });

  const dashboard = blessed.box({
    parent: screen,
    label: dashboardLabel({ title, subtitle, width: shell.width }),
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
      track: { bg: 'black' },
      style: { bg: COLOR.muted },
    },
    content: `{${COLOR.secondary}-fg}Loading usage data...{/${COLOR.secondary}-fg}`,
    style: {
      // Distinct but subdued against Codex's dark terminal background.
      border: { fg: COLOR.frame },
      label: { fg: COLOR.frame, bold: true },
      fg: COLOR.text,
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

  const renderFooter = () => {
    footer.setContent(formatFooter({ states, alerts, mode, width: dashboardGeometry(screen.width).width }));
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
    const width = contentWidthFor(dashboardGeometry(screen.width).width);
    const compact = mode === 'compact';
    const blocks = states.map((state) => {
      const sectionTitle = states.length > 1
        ? `{${COLOR.accent}-fg}{bold}▌ ${escapeBlessed(state.provider.title)}{/bold}{/${COLOR.accent}-fg}\n`
        : '';

      if (!state.snapshot) {
        return `${sectionTitle}  {${COLOR.secondary}-fg}loading...{/${COLOR.secondary}-fg}`;
      }

      return sectionTitle + state.provider.render(state.snapshot, width, mode);
    });

    const content = blocks.join(compact ? '\n\n' : `\n${sectionSeparator(width)}\n`);

    if (content === lastContent) {
      return;
    }

    const plainLines = stripBlessedTags(content).split('\n');
    const lineCount = plainLines.length;
    const lineWidths = plainLines.map((line) => line.length);
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
    states.forEach((state) => refresh(state));
  });

  screen.key(['d'], () => {
    mode = mode === 'compact' ? 'detail' : 'compact';
    renderContent();
    renderFooter();
    screen.render();
  });

  // blessed's keys/vi only bind arrows and ctrl-b/ctrl-f; page keys scroll a
  // full page like ctrl-f/ctrl-b do.
  dashboard.key(['pageup', 'pagedown'], (ch, key) => {
    dashboard.scroll(key.name === 'pageup' ? -(dashboard.height || 1) : dashboard.height || 1);
    screen.render();
  });

  states.forEach((state, index) => {
    if (index < 9) {
      screen.key([String(index + 1)], () => refresh(state));
    }
  });

  screen.key(['escape', 'q', 'C-c'], () => {
    states.forEach((state) => clearTimeout(state.timer));
    clearInterval(clockTimer);
    process.exit(0);
  });

  screen.on('resize', () => {
    const nextShell = dashboardGeometry(screen.width);
    dashboard.left = nextShell.left;
    dashboard.width = nextShell.width;
    dashboard.setLabel(dashboardLabel({ title, subtitle, width: nextShell.width }));
    footer.left = nextShell.left;
    footer.width = nextShell.width;
    renderContent();
    renderFooter();
    screen.render();
  });

  footer.setFront();
  dashboard.focus();
  renderFooter();
  screen.render();
  states.forEach((state) => refresh(state));

  clockTimer = setInterval(() => {
    renderFooter();
    renderContent(); // ticks live sub-hour countdowns; a no-op when nothing changed
    screen.render();
  }, 1000);
}

export function formatFooter({ states, alerts, mode, width = 100 }) {
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

  const key = (value) => `{${COLOR.accent}-fg}{bold}${value}{/bold}{/${COLOR.accent}-fg}`;
  const dot = `{${COLOR.muted}-fg}·{/${COLOR.muted}-fg}`;
  const toggle = mode === 'compact' ? 'details' : 'compact';
  const providerRange = states.length > 1 ? key(`1-${Math.min(9, states.length)}`) : '';
  let controls;

  if (width >= 108) {
    controls = [
      `${key('r')} refresh all`,
      providerRange ? `${providerRange} refresh provider` : '',
      `${key('d')} ${toggle}`,
      `${key('q')} exit`,
      `{${COLOR.success}-fg}█{/${COLOR.success}-fg} used`,
      `{${COLOR.muted}-fg}░ projected{/${COLOR.muted}-fg}`,
      `{${COLOR.warning}-fg}▲{/${COLOR.warning}-fg} ahead`,
    ].filter(Boolean).join(`  ${dot}  `);
  } else if (width >= 78) {
    controls = [
      `${key('r')} refresh`,
      providerRange ? `${providerRange} refresh` : '',
      `${key('d')} ${toggle}`,
      `${key('q')} exit`,
      `{${COLOR.success}-fg}█{/${COLOR.success}-fg} used`,
      `{${COLOR.muted}-fg}░ projected{/${COLOR.muted}-fg}`,
    ].filter(Boolean).join(` ${dot} `);
  } else {
    controls = [
      `${key('r')} refresh`,
      `${key('d')} ${toggle}`,
      `${key('q')} exit`,
    ].join(` ${dot} `);
  }

  return `${summary}\n${controls}`;
}

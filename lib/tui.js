import blessed from 'blessed';
import { escapeBlessed, formatRelativeTime } from './format.js';
import { contentWidthFor, sectionSeparator } from './render.js';

const ALERT_THRESHOLDS = [80, 90];
const ALERT_SHOW_MS = 5 * 60 * 1000;

// Generic dashboard shell. Each provider supplies:
//   { id, title, refreshMs, fetch(), render(snapshot, width),
//     headerStatus(snapshot) -> {ok, text}, alertItems?(snapshot) -> [{key,label,percent}],
//     nextDelayMs?(snapshot, refreshMs) -> ms }
export function runDashboard({ screenTitle, title, providers }) {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    title: screenTitle,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    tags: true,
    padding: { left: 2, right: 2 },
    style: { bg: 'black', fg: 'white' },
  });

  const dashboard = blessed.box({
    parent: screen,
    label: ` ${title} `,
    top: 4,
    left: 0,
    width: '100%',
    bottom: 0,
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
      style: { bg: 'blue' },
    },
    content: '{white-fg}Loading usage data...{/white-fg}',
    style: {
      border: { fg: 'white', bold: true },
      label: { fg: 'cyan', bold: true },
      fg: 'white',
    },
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

  const renderHeader = () => {
    header.setContent(formatHeader({ title, states, alerts, mode }));
  };

  const renderContent = () => {
    const width = contentWidthFor(screen.width);
    const compact = mode === 'compact';
    const blocks = states.map((state) => {
      const sectionTitle = states.length > 1
        ? `{cyan-fg}{bold}▌ ${escapeBlessed(state.provider.title)}{/bold}{/cyan-fg}\n`
        : '';

      if (!state.snapshot) {
        return `${sectionTitle}  {white-fg}loading...{/white-fg}`;
      }

      return sectionTitle + state.provider.render(state.snapshot, width, mode);
    });

    dashboard.setContent(blocks.join(compact ? '\n\n' : `\n${sectionSeparator(width)}\n`));
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
    renderHeader();
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
    renderHeader();
    scheduleNext(state);
    screen.render();
  };

  screen.key(['r'], () => {
    states.forEach((state) => refresh(state));
  });

  screen.key(['d'], () => {
    mode = mode === 'compact' ? 'detail' : 'compact';
    renderContent();
    renderHeader();
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
    renderContent();
    renderHeader();
    screen.render();
  });

  header.setFront();
  dashboard.focus();
  renderHeader();
  screen.render();
  states.forEach((state) => refresh(state));

  clockTimer = setInterval(() => {
    renderHeader();
    screen.render();
  }, 1000);
}

function formatHeader({ title, states, alerts, mode }) {
  const chips = states.map((state, index) => {
    const prefix = states.length > 1 ? `[${index + 1}]` : '';
    const status = state.refreshing
      ? '{yellow-fg}...{/yellow-fg}'
      : !state.snapshot
        ? '{yellow-fg}load{/yellow-fg}'
        : state.snapshot.fatal
          ? '{red-fg}ERR{/red-fg}'
          : formatChipStatus(state);
    const age = state.updatedAt ? ` {white-fg}${formatRelativeTime(state.updatedAt).replace(' ago', '')}{/white-fg}` : '';

    return `${prefix}${escapeBlessed(state.provider.title)} ${status}${age}`;
  }).join('  {white-fg}|{/white-fg}  ');

  const recentAlert = alerts.length > 0 && Date.now() - alerts[alerts.length - 1].at < ALERT_SHOW_MS
    ? `{red-fg}{bold}⚠ ${escapeBlessed(alerts[alerts.length - 1].text)}{/bold}{/red-fg}`
    : `{cyan-fg}r refresh | d ${mode === 'compact' ? 'detail' : 'compact'} | 1-9 one | q exit | █ used ░ projected by reset | ▲ ahead of pace{/cyan-fg}`;

  return [
    `{magenta-fg}{bold}${escapeBlessed(title)}{/bold}{/magenta-fg}`,
    chips,
    recentAlert,
  ].join('\n');
}

function formatChipStatus(state) {
  const status = state.provider.headerStatus?.(state.snapshot);

  if (!status) {
    return '{green-fg}OK{/green-fg}';
  }

  const color = status.ok ? 'green' : 'red';
  return `{${color}-fg}${escapeBlessed(status.text)}{/${color}-fg}`;
}

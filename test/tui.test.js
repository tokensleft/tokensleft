import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import blessed from 'blessed';
import { cellWidth, stripBlessedColorTags, stripBlessedTags } from '../lib/format.js';
import { COLOR } from '../lib/palette.js';
import {
  applyRoundedCorners,
  applyRainbowBorder,
  composeProviderColumns,
  dashboardContentLayout,
  dashboardGeometry,
  dashboardLabel,
  DEFAULT_TERMINAL_PROFILE,
  DASHBOARD_SUBTITLE,
  fitProviderBlock,
  formatFooter,
  formatHelp,
  formatProviderSectionTitle,
  formatResetHistory,
  installCelebrationKeyInterceptor,
  MIN_DASHBOARD_WIDTH,
  playCelebrationBell,
  rainbowTitle,
  syncDashboardLabel,
  terminalProfile,
  uiColorMode,
  visibleCellWidth,
  providerBlocksFitColumn,
} from '../lib/tui.js';

test('terminalProfile defaults every detected terminal to the 256-color profile', () => {
  assert.equal(DEFAULT_TERMINAL_PROFILE, 'xterm-256color');
  assert.equal(terminalProfile({}), DEFAULT_TERMINAL_PROFILE);
  assert.equal(terminalProfile({ WT_SESSION: 'session-id' }), DEFAULT_TERMINAL_PROFILE);
  assert.equal(terminalProfile({ TERM: 'xterm' }), DEFAULT_TERMINAL_PROFILE);
  assert.equal(terminalProfile({ TERM: 'linux' }), DEFAULT_TERMINAL_PROFILE);
  assert.equal(terminalProfile({ TERM: 'screen-256color' }), DEFAULT_TERMINAL_PROFILE);
});

test('terminalProfile supports an explicit compatibility override', () => {
  assert.equal(terminalProfile({ TERM: 'xterm', TOKENSLEFT_TERM: 'xterm' }), 'xterm');
  assert.equal(terminalProfile({ TOKENSLEFT_TERM: 'linux' }), 'linux');
});

test('terminal color mode supports NO_COLOR and an explicit basic profile', () => {
  assert.equal(uiColorMode({ NO_COLOR: '1' }), 'none');
  assert.equal(uiColorMode({ TOKENSLEFT_COLOR: 'none' }), 'none');
  assert.equal(uiColorMode({ TOKENSLEFT_COLOR: 'basic' }), 'basic');
  assert.equal(uiColorMode({}), '256');
  assert.equal(terminalProfile({ TOKENSLEFT_COLOR: 'basic', TERM: 'linux' }), 'linux');
});

test('normalized xterm profiles give Blessed the full palette', () => {
  const profile = terminalProfile({ TERM: 'xterm' });
  assert.equal(blessed.tput({ terminal: profile }).colors, 256);
});

test('dashboardGeometry expands multi-provider dashboards but keeps single-provider views readable', () => {
  assert.deepEqual(dashboardGeometry(100), { width: 100, left: 0 });
  assert.deepEqual(dashboardGeometry(160), { width: 132, left: 14 });
  assert.deepEqual(dashboardGeometry(160, 5), { width: 160, left: 0 });
  assert.deepEqual(dashboardGeometry(260, 5), { width: 212, left: 24 });
});

test('dashboardContentLayout uses mode-aware two-column thresholds', () => {
  assert.deepEqual(
    dashboardContentLayout(50, { mode: 'compact', providerCount: 5 }),
    { columns: 1, contentWidth: 42, columnWidth: 42, gapWidth: 0, indent: 0, splitIndex: 5 },
  );
  assert.equal(dashboardContentLayout(159, { mode: 'compact', providerCount: 5 }).columns, 1);
  assert.deepEqual(
    dashboardContentLayout(160, { mode: 'compact', providerCount: 5 }),
    { columns: 2, contentWidth: 152, columnWidth: 74, gapWidth: 4, indent: 0, splitIndex: 3 },
  );

  assert.equal(dashboardContentLayout(207, { mode: 'detail', providerCount: 5 }).columns, 1);
  assert.deepEqual(
    dashboardContentLayout(208, { mode: 'detail', providerCount: 5 }),
    { columns: 2, contentWidth: 200, columnWidth: 98, gapWidth: 4, indent: 0, splitIndex: 2 },
  );

  assert.deepEqual(
    dashboardContentLayout(212, { mode: 'compact', providerCount: 1 }),
    { columns: 1, contentWidth: 204, columnWidth: 120, gapWidth: 0, indent: 42, splitIndex: 1 },
  );
});

test('provider block fitting truncates only the overflowing line', () => {
  const block = `{203-fg}${'error '.repeat(30)}{/203-fg}\nshort line`;
  const fitted = fitProviderBlock(block, 24);
  const lines = fitted.split('\n');

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => visibleCellWidth(line) <= 24));
  assert.match(stripBlessedTags(lines[0]), /…$/);
  assert.equal(stripBlessedTags(lines[1]), 'short line');
});

test('wide columns compose tagged Unicode blocks without overlap', () => {
  const blocks = [
    '{81-fg}{bold}A{/bold}{/81-fg}\nA second',
    'B',
    '{203-fg}中文🙂é{/203-fg}\nC second',
    'D\nD second',
  ];
  const layout = {
    columns: 2,
    contentWidth: 24,
    columnWidth: 10,
    gapWidth: 4,
    indent: 0,
    splitIndex: 2,
  };
  const content = composeProviderColumns(blocks, layout, 'compact');
  const lines = content.split('\n');

  assert.ok(lines.every((line) => visibleCellWidth(line) === 24));
  assert.equal((stripBlessedTags(content).match(/A second/g) || []).length, 1);
  assert.equal((stripBlessedTags(content).match(/中文/g) || []).length, 1);
  assert.equal(visibleCellWidth('{81-fg}中文🙂é{/81-fg}'), 6);
  assert.equal(providerBlocksFitColumn(blocks, 10), true);
  assert.equal(providerBlocksFitColumn([...blocks, 'x'.repeat(11)], 10), false);
});

test('dashboardLabel renders a rainbow TokensLeft title with a responsive subtitle', () => {
  assert.equal(stripBlessedTags(rainbowTitle()), 'TokensLeft');
  assert.equal(
    stripBlessedTags(dashboardLabel({ width: 132 })).trim(),
    `TokensLeft · ${DASHBOARD_SUBTITLE}`,
  );
  assert.equal(stripBlessedTags(dashboardLabel({ width: 50 })).trim(), 'TokensLeft');
});

test('dashboard title is detached during celebration instead of leaving a blank cell', () => {
  const calls = [];
  const dashboard = {
    removeLabel: () => calls.push(['remove']),
    setLabel: (label) => calls.push(['set', label]),
  };

  syncDashboardLabel(dashboard, ' TokensLeft ', true);
  syncDashboardLabel(dashboard, ' TokensLeft ', false);
  assert.deepEqual(calls, [['remove'], ['set', ' TokensLeft ']]);
});

test('dashboardLabel shows a muted npx prefix when launched through npx', () => {
  const label = dashboardLabel({ commandPrefix: 'npx', width: 132 });

  assert.equal(
    stripBlessedTags(label).trim(),
    `npx TokensLeft · ${DASHBOARD_SUBTITLE}`,
  );
  assert.ok(label.includes(`{${COLOR.muted}-fg}npx{/${COLOR.muted}-fg}`));
});

test('formatFooter stays at two concise lines and aggregates healthy providers', () => {
  const states = Array.from({ length: 8 }, (_, index) => ({
    provider: {
      title: `Provider ${index + 1}`,
      headerStatus: () => ({ ok: true, text: 'OK' }),
    },
    snapshot: { ok: true },
    updatedAt: new Date(),
    refreshing: false,
  }));
  const footer = stripBlessedTags(formatFooter({ states, alerts: [], mode: 'compact', width: 132 }));
  const lines = footer.split('\n');

  assert.equal(lines.length, 2);
  assert.match(lines[0], /8\/8 providers healthy/);
  assert.match(lines[1], /1-8 provider/);
  assert.match(lines[1], /\?\/h help/);
  assert.match(lines[1], /↑↓ scroll/);
  assert.ok(lines.every((line) => cellWidth(line) <= 128));
  assert.ok(!lines[0].includes('Provider 1'), 'healthy state is summarized instead of listing every provider');
});

test('formatFooter gives a free reset the two-line notification area', () => {
  const footer = stripBlessedTags(formatFooter({
    states: [],
    alerts: [],
    mode: 'compact',
    resetNotice: { providers: ['Codex'], detectedAt: '2026-07-17T08:15:30.000Z' },
    width: 100,
  }));
  const lines = footer.split('\n');

  assert.match(lines[0], /^Codex: free reset detected at .+!$/);
  assert.equal(lines[1], 'Press any key to keep creating.');
  assert.ok(lines.every((line) => cellWidth(line) <= 96));
});

test('provider usage heading animates only when that provider is celebrating', () => {
  assert.equal(formatProviderSectionTitle({ title: 'Codex' }), '');

  const first = formatProviderSectionTitle({
    title: 'Codex',
    index: 1,
    providerCount: 3,
    celebrating: true,
    phase: 0,
  });
  const next = formatProviderSectionTitle({
    title: 'Codex',
    index: 1,
    providerCount: 3,
    celebrating: true,
    phase: 1,
  });

  assert.equal(stripBlessedTags(first), '▌ [2] Codex\n');
  assert.notEqual(first, next);
  assert.match(stripBlessedTags(formatProviderSectionTitle({
    title: 'Codex',
    celebrating: true,
  })), /Codex/);
});

test('narrow footer stays inside its padded width and asks for a resize', () => {
  const footer = formatFooter({ states: [], alerts: [], mode: 'compact', width: 40 });
  const lines = footer.split('\n');

  assert.equal(MIN_DASHBOARD_WIDTH, 72);
  assert.match(stripBlessedTags(lines[0]), /Resize terminal/);
  assert.ok(lines.every((line) => visibleCellWidth(line) <= 36));
});

test('help lists controls without a provider shortcut table', () => {
  const help = formatHelp({ width: 48 });

  assert.match(stripBlessedTags(help), /1-9\s+refresh the numbered provider/);
  assert.match(stripBlessedTags(help), /\?\/h\s+toggle this help/);
  assert.doesNotMatch(stripBlessedTags(help), /Provider shortcuts/);
  assert.ok(help.split('\n').every((line) => visibleCellWidth(line) <= 48));
  assert.doesNotThrow(() => stripBlessedColorTags(help));
});

test('reset history controls only appear after a reset has been detected', () => {
  const helpWithoutHistory = stripBlessedTags(formatHelp({ width: 64 }));
  const helpWithHistory = stripBlessedTags(formatHelp({ resetHistoryAvailable: true, width: 64 }));
  const footerWithoutHistory = stripBlessedTags(formatFooter({
    states: [],
    alerts: [],
    mode: 'compact',
    width: 100,
  }));
  const footerWithHistory = stripBlessedTags(formatFooter({
    states: [],
    alerts: [],
    mode: 'compact',
    hasResetHistory: true,
    width: 100,
  }));

  assert.doesNotMatch(helpWithoutHistory, /reset history/);
  assert.match(helpWithHistory, /t\s+show detected reset history/);
  assert.doesNotMatch(footerWithoutHistory, /t resets/);
  assert.match(footerWithHistory, /t resets/);
});

test('reset history lists local detection times, providers, and quota windows', () => {
  const content = stripBlessedTags(formatResetHistory([
    {
      provider: 'Codex',
      detectedAt: '2026-07-17T08:15:30.000Z',
      windows: [
        { key: 'session', label: 'Session' },
        { key: 'weekly', label: 'Weekly' },
      ],
    },
  ], { width: 72 }));

  assert.match(content, /Detected time \(local\) · newest first/);
  assert.match(content, /Codex · Session, Weekly/);
  assert.match(content, /t\/Esc close/);
  assert.ok(content.split('\n').every((line) => cellWidth(line) <= 72));
});

test('npx help explains how to install TokensLeft as a command', () => {
  const regular = stripBlessedTags(formatHelp({ width: 64 }));
  const npx = stripBlessedTags(formatHelp({ npxMode: true, width: 64 }));

  assert.doesNotMatch(regular, /npm i -g tokensleft/);
  assert.match(npx, /Install as a command/);
  assert.match(npx, /npm i -g tokensleft/);
  assert.doesNotMatch(npx, /then run/);
});

test('applyRoundedCorners replaces all four frame corners', () => {
  const lines = Array.from({ length: 4 }, () => {
    const line = Array.from({ length: 6 }, () => [0, ' ']);
    line.dirty = false;
    return line;
  });

  applyRoundedCorners(lines, { xi: 1, xl: 5, yi: 1, yl: 4 });

  assert.equal(lines[1][1][1], '╭');
  assert.equal(lines[1][4][1], '╮');
  assert.equal(lines[3][1][1], '╰');
  assert.equal(lines[3][4][1], '╯');
  assert.equal(lines[1].dirty, true);
  assert.equal(lines[3].dirty, true);
});

test('applyRoundedCorners ignores missing or collapsed frames', () => {
  assert.doesNotThrow(() => applyRoundedCorners([], null));
  assert.doesNotThrow(() => applyRoundedCorners([], { xi: 1, xl: 1, yi: 1, yl: 1 }));
});

test('applyRainbowBorder paints a moving perimeter without recoloring its label', () => {
  const lines = Array.from({ length: 6 }, () => {
    const line = Array.from({ length: 10 }, () => [0, ' ']);
    line.dirty = false;
    return line;
  });
  const coords = { xi: 1, xl: 9, yi: 1, yl: 5 };

  for (let x = coords.xi; x < coords.xl; x += 1) {
    lines[coords.yi][x][1] = '─';
    lines[coords.yl - 1][x][1] = '─';
  }

  for (let y = coords.yi; y < coords.yl; y += 1) {
    lines[y][coords.xi][1] = '│';
    lines[y][coords.xl - 1][1] = '│';
  }

  applyRoundedCorners(lines, coords);
  lines[coords.yi][4] = [0, 'T'];
  applyRainbowBorder(lines, coords, 0);

  const foregrounds = () => lines.flatMap((line) => line
    .filter((cell) => /[─│╭╮╰╯]/u.test(cell[1]))
    .map((cell) => (cell[0] >> 9) & 0x1ff));
  const firstFrame = foregrounds();
  const transitions = firstFrame.reduce(
    (count, color, index) => count + (index > 0 && color !== firstFrame[index - 1] ? 1 : 0),
    0,
  );

  assert.ok(new Set(firstFrame).size >= 4);
  assert.ok(transitions >= firstFrame.length / 3, 'the perimeter contains many narrow color bands');
  assert.equal(lines[coords.yi][4][0], 0, 'the title label keeps its own color');
  assert.equal(lines[2][2][0], 0, 'interior cells are untouched');

  applyRainbowBorder(lines, coords, 5);
  assert.notDeepEqual(foregrounds(), firstFrame);
  assert.ok(lines.some((line) => line.dirty));
});

test('celebration key interceptor dismisses and consumes exactly one keypress', async () => {
  const program = new EventEmitter();
  const screen = { lockKeys: false, destroyed: false };
  let active = true;
  let dismissals = 0;
  let downstream = 0;

  program.on('keypress', () => {
    if (!screen.lockKeys) {
      downstream += 1;
    }
  });
  const remove = installCelebrationKeyInterceptor(
    program,
    screen,
    () => active,
    () => {
      active = false;
      dismissals += 1;
    },
  );

  program.emit('keypress', 'x', { full: 'x' });
  assert.equal(dismissals, 1);
  assert.equal(downstream, 0, 'the dismissal key does not reach dashboard commands');

  await Promise.resolve();
  assert.equal(screen.lockKeys, false);
  program.emit('keypress', 'r', { full: 'r' });
  assert.equal(downstream, 1, 'later keys work normally after dismissal');
  remove();
});

test('celebration bell uses a playful three-beat pause two-beat rhythm', () => {
  const scheduled = [];
  let bells = 0;
  const timers = playCelebrationBell(
    { bell: () => { bells += 1; } },
    (callback, delay) => {
      scheduled.push({ callback, delay });
      return `timer-${delay}`;
    },
  );

  assert.deepEqual(scheduled.map((entry) => entry.delay), [0, 90, 180, 450, 540]);
  assert.deepEqual(timers, ['timer-0', 'timer-90', 'timer-180', 'timer-450', 'timer-540']);
  scheduled.forEach((entry) => entry.callback());
  assert.equal(bells, 5);
});

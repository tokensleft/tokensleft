import assert from 'node:assert/strict';
import { test } from 'node:test';
import blessed from 'blessed';
import { cellWidth, stripBlessedColorTags, stripBlessedTags } from '../lib/format.js';
import {
  applyRoundedCorners,
  composeProviderColumns,
  dashboardContentLayout,
  dashboardGeometry,
  dashboardLabel,
  DEFAULT_TERMINAL_PROFILE,
  DASHBOARD_SUBTITLE,
  fitProviderBlock,
  formatFooter,
  formatHelp,
  MIN_DASHBOARD_WIDTH,
  rainbowTitle,
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
  assert.match(lines[1], /\? help/);
  assert.match(lines[1], /↑↓ scroll/);
  assert.ok(lines.every((line) => cellWidth(line) <= 128));
  assert.ok(!lines[0].includes('Provider 1'), 'healthy state is summarized instead of listing every provider');
});

test('narrow footer stays inside its padded width and asks for a resize', () => {
  const footer = formatFooter({ states: [], alerts: [], mode: 'compact', width: 40 });
  const lines = footer.split('\n');

  assert.equal(MIN_DASHBOARD_WIDTH, 72);
  assert.match(stripBlessedTags(lines[0]), /Resize terminal/);
  assert.ok(lines.every((line) => visibleCellWidth(line) <= 36));
});

test('help lists controls and numbered provider mappings concisely', () => {
  const providers = [{ title: 'Claude Code' }, { title: 'Codex' }];
  const help = formatHelp({ providers, width: 48 });

  assert.match(stripBlessedTags(help), /1  Claude Code/);
  assert.match(stripBlessedTags(help), /2  Codex/);
  assert.match(stripBlessedTags(help), /\?\s+toggle this help/);
  assert.ok(help.split('\n').every((line) => visibleCellWidth(line) <= 48));
  assert.doesNotThrow(() => stripBlessedColorTags(help));
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

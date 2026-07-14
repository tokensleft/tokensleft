import assert from 'node:assert/strict';
import { test } from 'node:test';
import blessed from 'blessed';
import { stripBlessedTags } from '../lib/format.js';
import {
  applyRoundedCorners,
  dashboardGeometry,
  dashboardLabel,
  DEFAULT_TERMINAL_PROFILE,
  DASHBOARD_SUBTITLE,
  formatFooter,
  rainbowTitle,
  terminalProfile,
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

test('normalized xterm profiles give Blessed the full palette', () => {
  const profile = terminalProfile({ TERM: 'xterm' });
  assert.equal(blessed.tput({ terminal: profile }).colors, 256);
});

test('dashboardGeometry centers a readable-width shell on wide terminals', () => {
  assert.deepEqual(dashboardGeometry(100), { width: 100, left: 0 });
  assert.deepEqual(dashboardGeometry(160), { width: 132, left: 14 });
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
  assert.match(lines[1], /1-8 refresh provider/);
  assert.match(lines[1], /projected/);
  assert.ok(!lines[0].includes('Provider 1'), 'healthy state is summarized instead of listing every provider');
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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { stripBlessedTags } from '../lib/format.js';
import { contentTickDelayMs, runDashboard } from '../lib/tui.js';

// Drives runDashboard end to end through a fake widget factory: no terminal
// and no blessed screen, only the calls the dashboard makes on its boxes.

class FakeProgram extends EventEmitter {
  constructor() {
    super();
    this.bells = 0;
  }

  bell() {
    this.bells += 1;
  }
}

class FakeScreen extends EventEmitter {
  constructor(options, size) {
    super();
    this.options = options;
    this.title = options.title;
    this.width = size.width;
    this.height = size.height;
    this.lines = [];
    this.olines = [];
    this.program = new FakeProgram();
    this.lockKeys = false;
    this.destroyed = false;
    this.renders = 0;
    this.handlers = new Map();
  }

  key(names, handler) {
    for (const name of [].concat(names)) {
      this.handlers.set(name, handler);
    }
  }

  press(name) {
    const handler = this.handlers.get(name);
    assert.ok(handler, `the dashboard binds ${name}`);
    handler(name.length === 1 ? name : null, { name, full: name });
  }

  render() {
    this.renders += 1;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeBox extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.hidden = options.hidden === true;
    this.content = options.content || '';
    this.label = options.label || '';
    this.width = options.width;
    this.height = options.height;
    this.left = options.left;
    this.top = options.top;
    const padding = options.padding || {};
    const border = options.border ? 1 : 0;
    this.iheight = border * 2 + (padding.top || 0) + (padding.bottom || 0);
    this.ileft = border + (padding.left || 0);
    this.itop = border + (padding.top || 0);
    this.lpos = null;
    this.scrollTop = 0;
    this.handlers = new Map();
    this.focused = 0;
    this.fronted = 0;
  }

  setContent(content) {
    this.content = content;
  }

  setLabel(label) {
    this.label = label;
  }

  show() {
    this.hidden = false;
  }

  hide() {
    this.hidden = true;
  }

  focus() {
    this.focused += 1;
  }

  setFront() {
    this.fronted += 1;
  }

  getScroll() {
    return this.scrollTop;
  }

  getScrollHeight() {
    return this.content.split('\n').length;
  }

  scroll(offset) {
    this.scrollTop = Math.max(0, this.scrollTop + offset);
  }

  setScroll(offset) {
    this.scrollTop = Math.max(0, offset);
  }

  key(names, handler) {
    for (const name of [].concat(names)) {
      this.handlers.set(name, handler);
    }
  }

  press(name) {
    this.handlers.get(name)?.(null, { name, full: name });
  }

  plain() {
    return stripBlessedTags(this.content);
  }
}

function createFakeUi({ width = 140, height = 40 } = {}) {
  const boxes = [];
  const holder = { screen: null };
  const ui = {
    screen(options) {
      holder.screen = new FakeScreen(options, { width, height });
      return holder.screen;
    },
    box(options) {
      const box = new FakeBox(options);
      boxes.push(box);
      return box;
    },
  };

  return {
    ui,
    boxes,
    get screen() {
      return holder.screen;
    },
    // Creation order inside runDashboard: footer, dashboard, help, reset
    // history, celebration frame.
    get footer() {
      return boxes[0];
    },
    get dashboard() {
      return boxes[1];
    },
    get help() {
      return boxes[2];
    },
    get celebration() {
      return boxes[4];
    },
  };
}

function fakeProvider(id, title, { percent = 20, resetAt = null } = {}) {
  const provider = {
    id,
    title,
    refreshMs: 60_000,
    fetches: 0,
    percent,
    resetAt,

    async fetch() {
      provider.fetches += 1;
      return {
        ok: true,
        items: [{ kind: 'usage', key: `${id}:window`, label: 'Window', percent: provider.percent, resetAt: provider.resetAt }],
      };
    },

    render(snapshot, width, mode) {
      if (snapshot.fatal) {
        return `${id} failed: ${snapshot.fatal}`;
      }

      return `${id}-${mode} ${Math.round(snapshot.items[0].percent)}% w${width}`;
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : 'ERR' };
    },

    alertItems(snapshot) {
      return snapshot.items;
    },
  };

  return provider;
}

function startDashboard(t, { providers, width, height, colorMode = '256', ...rest } = {}) {
  const fake = createFakeUi({ width, height });
  const exits = [];
  const handle = runDashboard({
    screenTitle: 'TokensLeft test',
    providers,
    terminal: 'xterm',
    colorMode,
    ui: fake.ui,
    exit: () => exits.push(Date.now()),
    initialResetHistory: [],
    ...rest,
  });
  t.after(() => {
    if (exits.length === 0) {
      handle.exit();
    }
  });
  return { fake, handle, exits };
}

test('dashboard renders providers, toggles detail mode, and exits with cleanup', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const beta = fakeProvider('beta', 'Beta');
  const { fake, handle, exits } = startDashboard(t, { providers: [alpha, beta] });

  assert.equal(fake.screen.title, 'TokensLeft test');
  assert.match(fake.dashboard.plain(), /Loading usage data/);
  await handle.ready;

  const body = fake.dashboard.plain();
  assert.match(body, /\[1\] Alpha/);
  assert.match(body, /\[2\] Beta/);
  assert.match(body, /alpha-compact 20%/);
  assert.match(fake.footer.plain(), /2\/2 providers healthy/);
  assert.match(fake.footer.plain(), /d details/);

  fake.screen.press('d');
  assert.match(fake.dashboard.plain(), /alpha-detail 20%/);
  assert.match(fake.footer.plain(), /d compact/);

  fake.screen.press('2');
  assert.equal(beta.fetches, 2, 'the numbered key refreshes only that provider');
  assert.equal(alpha.fetches, 1);
  await handle.refresh();
  assert.equal(alpha.fetches, 2);
  assert.equal(beta.fetches, 2, 'a refresh already in flight is joined, not duplicated');

  fake.screen.press('q');
  assert.equal(exits.length, 1);
  assert.equal(fake.screen.destroyed, true);
});

test('help overlay opens with ?, blocks dashboard keys while open, and closes with Esc', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const { fake, handle, exits } = startDashboard(t, { providers: [alpha] });
  await handle.ready;

  assert.equal(fake.help.hidden, true);
  fake.screen.press('?');
  assert.equal(fake.help.hidden, false);
  assert.match(fake.help.plain(), /Refresh all/);
  assert.match(fake.help.plain(), /github\.com\/tokensleft\/tokensleft/);

  fake.screen.press('r');
  await handle.refresh();
  assert.equal(alpha.fetches, 2, 'r is ignored while help is open (only the explicit refresh ran)');

  fake.screen.press('escape');
  assert.equal(fake.help.hidden, true);
  assert.equal(exits.length, 0, 'the first Esc only closes the overlay');

  fake.screen.press('escape');
  assert.equal(exits.length, 1);
});

test('crossing an alert threshold shows a footer warning and rings the bell', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha', { percent: 50 });
  const { fake, handle } = startDashboard(t, { providers: [alpha] });
  await handle.ready;
  assert.equal(fake.screen.program.bells, 0);

  alpha.percent = 85;
  await handle.refresh();

  assert.match(fake.footer.plain(), /Alpha · Window crossed 80% \(now 85%\)/);
  assert.equal(fake.screen.program.bells, 1);
  assert.match(fake.dashboard.plain(), /alpha-compact 85%/);
});

test('an unexpected quota reset is saved, celebrated, dismissed by a key, and replayable with t', async (t) => {
  const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const alpha = fakeProvider('alpha', 'Alpha', { percent: 90, resetAt });
  const saved = [];
  const { fake, handle } = startDashboard(t, {
    providers: [alpha],
    saveResetEvent: async (event) => {
      saved.push(event);
      return [event];
    },
  });
  await handle.ready;
  assert.doesNotMatch(fake.help.plain(), /Replay resets/);

  alpha.percent = 2;
  await handle.refresh();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].provider, 'Alpha');
  assert.deepEqual(saved[0].windows.map((window) => window.label), ['Window']);
  assert.equal(fake.celebration.hidden, false);
  assert.equal(fake.dashboard.hidden, true);
  assert.match(fake.celebration.plain(), /Alpha got a free reset!/);
  assert.match(fake.celebration.plain(), /PRESS ANY KEY TO KEEP CREATING/);

  const frontedBefore = fake.celebration.fronted;
  fake.screen.emit('resize');
  assert.ok(fake.celebration.fronted > frontedBefore, 'the celebration stays on top after a resize');

  fake.screen.program.emit('keypress', 'x', { name: 'x' });
  assert.equal(fake.celebration.hidden, true);
  assert.equal(fake.dashboard.hidden, false);
  assert.match(fake.help.plain(), /Replay resets/);
  assert.match(fake.footer.plain(), /t reset replay/);

  fake.screen.press('t');
  assert.equal(fake.celebration.hidden, false);
  assert.match(fake.celebration.plain(), /PRESS ANY OTHER KEY TO KEEP CREATING/);

  fake.screen.program.emit('keypress', null, { name: 'right' });
  assert.equal(fake.celebration.hidden, false, 'arrows browse history without dismissing');

  fake.screen.program.emit('keypress', 'x', { name: 'x' });
  assert.equal(fake.celebration.hidden, true);
});

test('footer clicks run the matching control', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const beta = fakeProvider('beta', 'Beta');
  const { fake, handle, exits } = startDashboard(t, { providers: [alpha, beta] });
  await handle.ready;
  const { footer } = fake;
  footer.lpos = {
    xi: footer.left,
    xl: footer.left + footer.width,
    yi: fake.screen.height - 2,
    yl: fake.screen.height,
  };
  const click = (text) => {
    const controls = footer.plain().split('\n')[1];
    const column = controls.indexOf(text);
    assert.ok(column >= 0, `footer shows "${text}"`);
    footer.emit('click', { button: 'left', x: footer.lpos.xi + footer.ileft + column, y: footer.lpos.yi + 1 });
  };

  click('d details');
  assert.match(fake.dashboard.plain(), /alpha-detail/);

  click('r refresh all');
  assert.equal(alpha.fetches, 2);
  assert.equal(beta.fetches, 2);
  await handle.refresh();

  click('?/h help');
  assert.equal(fake.help.hidden, false);
  fake.screen.press('escape');

  footer.emit('click', { button: 'right', x: footer.lpos.xi + footer.ileft, y: footer.lpos.yi + 1 });
  assert.equal(exits.length, 0, 'right clicks are ignored');

  click('q exit');
  assert.equal(exits.length, 1);
});

test('a narrow terminal asks for a resize and recovers once it grows', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const { fake, handle } = startDashboard(t, { providers: [alpha], width: 60 });
  await handle.ready;

  assert.match(fake.dashboard.plain(), /Terminal too narrow/);
  assert.match(fake.footer.plain(), /Resize terminal/);

  fake.screen.width = 140;
  fake.screen.emit('resize');
  assert.match(fake.dashboard.plain(), /alpha-compact 20%/);
  assert.equal(fake.dashboard.width, 132);
});

test('page keys and the footer scroll control page through a long dashboard and wrap', async (t) => {
  const tall = fakeProvider('tall', 'Tall');
  tall.render = () => Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n');
  const { fake, handle } = startDashboard(t, { providers: [tall], height: 30 });
  await handle.ready;
  const { dashboard, footer } = fake;
  dashboard.height = 28; // the fake does no layout, so give the box a page size

  dashboard.press('pagedown');
  assert.equal(dashboard.scrollTop, 28);
  dashboard.press('pageup');
  assert.equal(dashboard.scrollTop, 0);

  footer.lpos = {
    xi: footer.left,
    xl: footer.left + footer.width,
    yi: fake.screen.height - 2,
    yl: fake.screen.height,
  };
  const scrollColumn = footer.plain().split('\n')[1].indexOf('↑↓ scroll');
  assert.ok(scrollColumn >= 0, 'wide footers show the scroll control');
  const clickScroll = () => footer.emit('click', {
    button: 'left',
    x: footer.lpos.xi + footer.ileft + scrollColumn,
    y: footer.lpos.yi + 1,
  });
  const page = 28 - dashboard.iheight;

  clickScroll();
  assert.equal(dashboard.scrollTop, page);
  clickScroll();
  clickScroll();
  assert.equal(dashboard.scrollTop, page * 3);
  clickScroll();
  assert.equal(dashboard.scrollTop, 0, 'wraps to the top once the end is visible');
});

test('t without any history celebrates the user, and a mouse release outside closes help', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const { fake, handle } = startDashboard(t, { providers: [alpha] });
  await handle.ready;

  fake.screen.press('t');
  assert.equal(fake.celebration.hidden, false);
  assert.match(fake.celebration.plain(), /You got a free reset!/);
  fake.screen.program.emit('keypress', 'x', { name: 'x' });
  assert.equal(fake.celebration.hidden, true);

  fake.screen.press('?');
  assert.equal(fake.help.hidden, false);
  fake.help.lpos = { xi: 30, xl: 110, yi: 5, yl: 30 };
  fake.screen.emit('mouse', { action: 'mouseup', button: 'left', x: 40, y: 10 });
  assert.equal(fake.help.hidden, false, 'a release inside the window keeps it open');
  fake.screen.emit('mouse', { action: 'mousedown', button: 'left', x: 2, y: 2 });
  assert.equal(fake.help.hidden, false, 'only a release counts');
  fake.screen.emit('mouse', { action: 'mouseup', button: 'left', x: 2, y: 2 });
  assert.equal(fake.help.hidden, true);
});

test('a provider whose fetch throws is reported as failed, and a failed history save is announced', async (t) => {
  const broken = fakeProvider('broken', 'Broken');
  broken.fetch = async () => {
    throw new Error('boom');
  };
  const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const alpha = fakeProvider('alpha', 'Alpha', { percent: 95, resetAt });
  const { fake, handle } = startDashboard(t, {
    providers: [alpha, broken],
    saveResetEvent: async () => {
      throw new Error('disk full');
    },
  });
  await handle.ready;

  assert.match(fake.footer.plain(), /1 provider needs attention · Broken/);
  assert.match(fake.dashboard.plain(), /broken failed: boom/);

  alpha.percent = 1;
  await handle.refresh();
  assert.equal(fake.celebration.hidden, false, 'the reset is still celebrated');
  fake.screen.program.emit('keypress', 'x', { name: 'x' });
  assert.match(fake.footer.plain(), /Reset detected, but its history could not be saved/);
});

test('NO_COLOR mode strips color tags from every surface', async (t) => {
  const alpha = fakeProvider('alpha', 'Alpha');
  const { fake, handle } = startDashboard(t, { providers: [alpha], colorMode: 'none' });
  await handle.ready;

  assert.doesNotMatch(fake.dashboard.content, /-fg\}/);
  assert.doesNotMatch(fake.dashboard.label, /-fg\}/);
  assert.doesNotMatch(fake.footer.content, /-fg\}/);
  assert.match(fake.footer.plain(), /1\/1 providers healthy/);

  fake.screen.press('?');
  assert.doesNotMatch(fake.help.content, /-fg\}/);
  assert.match(fake.help.plain(), /Toggle help/);
});

test('content ticks each second only while a sub-hour countdown is on screen', () => {
  const now = Date.parse('2026-09-06T00:00:00Z');
  const at = (ms) => new Date(now + ms);
  const hour = 60 * 60 * 1000;

  assert.equal(contentTickDelayMs([], now), 30_000);
  assert.equal(contentTickDelayMs([null, { ok: true, items: [] }], now), 30_000);
  assert.equal(contentTickDelayMs([{ items: [{ resetAt: at(30 * 60 * 1000) }] }], now), 1000);
  assert.equal(contentTickDelayMs([{ results: [{ items: [{ depletesAt: at(-10 * 60 * 1000) }] }] }], now), 1000);
  assert.equal(contentTickDelayMs([{ items: [{ resetAt: at(hour + 5000) }] }], now), 5000);
  assert.equal(contentTickDelayMs([{ items: [{ resetAt: at(3 * hour) }] }], now), 30_000);
  assert.equal(contentTickDelayMs([{ items: [{ resetAt: at(hour + 200) }] }], now), 1000);
});

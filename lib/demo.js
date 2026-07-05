import { buildUsageItem } from './forecast.js';
import { clamp, formatNumber } from './format.js';
import { renderClaudeSnapshot } from '../providers/claude.js';
import { renderSingleAccount } from '../providers/codex.js';
import { renderAccountBlock as renderZaiAccountBlock } from '../providers/zai.js';

// Demo mode (--demo): the same dashboard rendered from randomly generated but
// plausible snapshots — no credentials touched, no network calls. Values are
// rolled once at startup (so the TUI stays steady across refreshes) and only
// the clocks tick; every run produces a slightly different, screenshot-ready
// dashboard.

const SESSION_PERIOD_MS = 5 * 60 * 60 * 1000;
const DAY_PERIOD_MS = 24 * 60 * 60 * 1000;
const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEMO_REFRESH_MS = 60 * 1000;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.round(rand(min, max));
}

// Rolls a usage window once: a percent inside `percent`, and a reset time
// placed so that used-vs-elapsed lands inside the `pace` ratio band (pace > 1
// reads as "burning faster than the window", which draws the ghost tail and,
// past 100%, the dry warning). `reset: false` models windows without a reset
// time (no pace/forecast lines, like Codex credits).
function rollWindow({ key, label, percent, pace = [0.75, 0.98], periodMs, value, active = false, details = [], reset = true }, now) {
  const rolledPercent = rand(percent[0], percent[1]);
  const elapsed = clamp(rolledPercent / rand(pace[0], pace[1]), 2, 98);

  return {
    key,
    label,
    percent: rolledPercent,
    resetAt: reset ? new Date(now + periodMs * (1 - elapsed / 100)) : null,
    periodMs,
    active,
    details,
    value: typeof value === 'function' ? value(rolledPercent) : value,
  };
}

function itemsFrom(specs, now) {
  return specs.map((spec) => buildUsageItem({ ...spec, now }));
}

function singleAccountAlerts(snapshot) {
  return (snapshot.items || [])
    .filter((item) => item.kind !== 'empty')
    .map((item) => ({ key: item.key, label: item.label, percent: item.percent }));
}

function makeSingleAccountDemo({ id, title, plan, windows }) {
  const specs = windows.map((window) => rollWindow(window, Date.now()));

  return {
    id,
    title,
    refreshMs: DEMO_REFRESH_MS,

    async fetch() {
      return { ok: true, ms: randInt(120, 900), plan, items: itemsFrom(specs, Date.now()) };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, id);
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : 'ERR' };
    },

    alertItems: singleAccountAlerts,
  };
}

// --- claude (multi-account + local usage table) -----------------------------------

function usageBucket({ input, output, cacheRead, cacheWrite, messages, inPrice, outPrice }) {
  const scale = rand(0.75, 1.25);
  const scaled = (value) => Math.round(value * scale);
  const bucket = {
    input: scaled(input),
    output: scaled(output),
    cacheRead: scaled(cacheRead),
    cacheWrite: scaled(cacheWrite),
    messages: scaled(messages),
    hasCost: true,
  };
  bucket.cost = (
    bucket.input * inPrice +
    bucket.output * outPrice +
    bucket.cacheRead * inPrice * 0.1 +
    bucket.cacheWrite * inPrice * 1.25
  ) / 1e6;
  return bucket;
}

function demoLocalModels() {
  const models = [
    { model: 'claude-fable-5', inPrice: 10, outPrice: 50, week: { input: 1_800_000, output: 5_200_000, cacheRead: 620_000_000, cacheWrite: 55_000_000, messages: 3200 } },
    { model: 'claude-opus-4-8', inPrice: 5, outPrice: 25, week: { input: 420_000, output: 1_100_000, cacheRead: 130_000_000, cacheWrite: 12_000_000, messages: 780 } },
    { model: 'claude-haiku-4-5-20251001', inPrice: 1, outPrice: 5, week: { input: 90_000, output: 260_000, cacheRead: 9_000_000, cacheWrite: 1_500_000, messages: 240 } },
  ];

  return models.map(({ model, inPrice, outPrice, week }) => ({
    model,
    today: usageBucket({
      input: week.input / 7,
      output: week.output / 7,
      cacheRead: week.cacheRead / 7,
      cacheWrite: week.cacheWrite / 7,
      messages: week.messages / 7,
      inPrice,
      outPrice,
    }),
    week: usageBucket({ ...week, inPrice, outPrice }),
  }));
}

function makeClaudeDemo() {
  const now = Date.now();
  const specs = [
    rollWindow({ key: 'demo:session', label: 'Session', percent: [45, 75], pace: [1.1, 1.35], periodMs: SESSION_PERIOD_MS, active: true }, now),
    rollWindow({ key: 'demo:weekly', label: 'Weekly all', percent: [35, 60], pace: [0.85, 1.0], periodMs: WEEKLY_PERIOD_MS }, now),
    rollWindow({ key: 'demo:weekly-opus', label: 'Wk Opus', percent: [20, 55], pace: [0.8, 1.0], periodMs: WEEKLY_PERIOD_MS }, now),
  ];
  const local = { ok: true, files: randInt(18, 60), models: demoLocalModels() };
  const spendPercent = randInt(15, 45);
  const spend = `$${(spendPercent * 0.5).toFixed(2)} (${spendPercent}%)`;

  return {
    id: 'claude',
    title: 'Claude Code',
    refreshMs: DEMO_REFRESH_MS,

    async fetch() {
      return {
        results: [{
          name: 'personal',
          source: 'system',
          plan: 'max / 20x',
          ok: true,
          ms: randInt(200, 800),
          items: itemsFrom(specs, Date.now()),
          spend,
        }],
        local,
        ms: randInt(200, 800),
      };
    },

    render(snapshot, width, mode = 'detail') {
      return renderClaudeSnapshot(snapshot, width, mode);
    },

    headerStatus() {
      return { ok: true, text: '1/1 OK' };
    },

    alertItems(snapshot) {
      return snapshot.results.flatMap((result) => result.items.map((item) => ({
        key: item.key,
        label: `${result.name} ${item.label}`,
        percent: item.percent,
      })));
    },
  };
}

// --- z.ai (multi-key) ---------------------------------------------------------------

function makeZaiDemo() {
  const now = Date.now();
  const specs = [
    rollWindow({ key: 'demo:zai:session', label: 'Session', percent: [30, 65], pace: [0.85, 1.02], periodMs: SESSION_PERIOD_MS }, now),
    rollWindow({ key: 'demo:zai:weekly', label: 'Weekly', percent: [40, 75], periodMs: WEEKLY_PERIOD_MS }, now),
    rollWindow({
      key: 'demo:zai:web',
      label: 'Web Searches',
      percent: [25, 60],
      periodMs: MONTHLY_PERIOD_MS,
      value: (percent) => `${formatNumber(Math.round(percent * 3))}/${formatNumber(300)} ${Math.round(percent)}%`,
    }, now),
  ];

  return {
    id: 'zai',
    title: 'z.ai',
    refreshMs: DEMO_REFRESH_MS,

    async fetch() {
      return {
        results: [{
          account: { name: 'work', key: 'sk-9f3...c2d1', proxy: 'direct' },
          ok: true,
          ms: randInt(300, 900),
          plan: 'GLM Coding Max',
          items: itemsFrom(specs, Date.now()),
          status: 'OK',
          error: '',
          body: '',
          url: '',
          partial: '',
          quotaSample: '',
        }],
      };
    },

    render(snapshot, width, mode = 'detail') {
      const joiner = mode === 'compact' ? '\n' : '\n\n';
      return snapshot.results.map((result) => renderZaiAccountBlock(result, width, mode)).join(joiner);
    },

    headerStatus() {
      return { ok: true, text: '1/1 OK' };
    },

    alertItems(snapshot) {
      return snapshot.results.flatMap((result) => result.items
        .filter((item) => item.kind === 'usage')
        .map((item) => ({
          key: item.key,
          label: `${result.account.name} ${item.label}`,
          percent: item.percent,
        })));
    },
  };
}

// --- all providers --------------------------------------------------------------------

export function makeDemoProviders(ids) {
  const providers = [
    makeClaudeDemo(),
    makeSingleAccountDemo({
      id: 'codex',
      title: 'Codex',
      plan: 'pro',
      windows: [
        { key: 'demo:codex:session', label: 'Session', percent: [15, 45], periodMs: SESSION_PERIOD_MS },
        { key: 'demo:codex:weekly', label: 'Weekly', percent: [50, 80], pace: [0.9, 1.02], periodMs: WEEKLY_PERIOD_MS },
        { key: 'demo:codex:reviews', label: 'Reviews', percent: [5, 25], periodMs: WEEKLY_PERIOD_MS },
        {
          key: 'demo:codex:credits',
          label: 'Credits',
          percent: [20, 45],
          periodMs: WEEKLY_PERIOD_MS,
          reset: false,
          value: (percent) => `${Math.round(1000 - percent * 10)} left`,
        },
      ],
    }),
    makeSingleAccountDemo({
      id: 'gemini',
      title: 'Gemini',
      plan: 'Paid · demo@example.com',
      windows: [
        { key: 'demo:gemini:pro', label: 'Pro', percent: [30, 65], pace: [0.85, 1.0], periodMs: DAY_PERIOD_MS },
        { key: 'demo:gemini:flash', label: 'Flash', percent: [5, 25], periodMs: DAY_PERIOD_MS },
      ],
    }),
    makeSingleAccountDemo({
      id: 'copilot',
      title: 'Copilot',
      plan: 'individual',
      windows: [
        { key: 'demo:copilot:premium', label: 'Premium', percent: [55, 85], pace: [1.0, 1.25], periodMs: MONTHLY_PERIOD_MS },
        { key: 'demo:copilot:chat', label: 'Chat', percent: [15, 40], periodMs: MONTHLY_PERIOD_MS },
      ],
    }),
    makeSingleAccountDemo({
      id: 'grok',
      title: 'Grok',
      plan: 'SuperGrok',
      windows: [
        {
          key: 'demo:grok:credits',
          label: 'Credits',
          percent: [30, 70],
          pace: [0.8, 1.0],
          periodMs: MONTHLY_PERIOD_MS,
          value: (percent) => `${Math.round(percent)}% (${formatNumber(Math.round(percent * 40))}/${formatNumber(4000)})`,
          details: [{ label: 'pay-as-you-go', value: 'disabled' }],
        },
      ],
    }),
    makeSingleAccountDemo({
      id: 'antigravity',
      title: 'Antigravity',
      plan: '',
      windows: [
        { key: 'demo:antigravity:gemini-pro', label: 'Gemini Pro', percent: [60, 90], pace: [1.05, 1.3], periodMs: SESSION_PERIOD_MS },
        { key: 'demo:antigravity:gemini-flash', label: 'Gemini Flash', percent: [10, 35], periodMs: SESSION_PERIOD_MS },
        { key: 'demo:antigravity:claude', label: 'Claude', percent: [40, 75], pace: [0.85, 1.0], periodMs: SESSION_PERIOD_MS },
      ],
    }),
    makeSingleAccountDemo({
      id: 'opencode',
      title: 'OpenCode',
      plan: 'Go',
      windows: [
        {
          key: 'demo:opencode:session',
          label: 'Session',
          percent: [20, 55],
          periodMs: SESSION_PERIOD_MS,
          value: (percent) => `${Math.floor(percent)}% ($${(percent * 0.12).toFixed(2)}/$12)`,
        },
        {
          key: 'demo:opencode:weekly',
          label: 'Weekly',
          percent: [40, 75],
          pace: [0.85, 1.0],
          periodMs: WEEKLY_PERIOD_MS,
          value: (percent) => `${Math.floor(percent)}% ($${(percent * 0.3).toFixed(2)}/$30)`,
        },
        {
          key: 'demo:opencode:monthly',
          label: 'Monthly',
          percent: [45, 80],
          pace: [0.85, 1.0],
          periodMs: MONTHLY_PERIOD_MS,
          value: (percent) => `${Math.floor(percent)}% ($${(percent * 0.6).toFixed(2)}/$60)`,
        },
      ],
    }),
    makeZaiDemo(),
  ];

  return ids?.length ? providers.filter((provider) => ids.includes(provider.id)) : providers;
}

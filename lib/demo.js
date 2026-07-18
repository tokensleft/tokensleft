import { buildClaudeLimitItems, renderClaudeSnapshot } from '../providers/claude.js';
import { buildCodexItems, buildCodexResetForecastItem, CODEX_LOCAL_OPTS } from '../providers/codex.js';
import { buildGeminiItems, GEMINI_LOCAL_OPTS } from '../providers/gemini.js';
import { buildKimiItems } from '../providers/kimi.js';
import { buildCopilotItems } from '../providers/copilot.js';
import { buildGrokItems } from '../providers/grok.js';
import { buildAntigravityItems } from '../providers/antigravity.js';
import { buildOpencodeItems, OPENCODE_LOCAL_OPTS } from '../providers/opencode.js';
import { buildZaiItems, renderAccountBlock as renderZaiAccountBlock } from '../providers/zai.js';
import { renderSingleAccount } from './provider-render.js';

// Demo mode is built from fake raw provider responses and then passed through
// the same builders and renderers as a live run. That keeps optional rows,
// labels, values, reset handling, and future provider changes in sync without
// touching credentials or making network requests.

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STANDARD_REFRESH_MS = 5 * 60 * 1000;
const ZAI_REFRESH_MS = 60 * 1000;

export const DEFAULT_DEMO_IDS = ['claude', 'codex', 'gemini', 'kimi', 'antigravity', 'zai'];

function rand(random, min, max) {
  return min + random() * (max - min);
}

function randInt(random, min, max) {
  return Math.round(rand(random, min, max));
}

function after(now, durationMs) {
  // A minute of boundary padding keeps a nominal "in 1d" or "in 5h"
  // fixture from immediately rendering as 23h 59m / 4h 59m after startup.
  return new Date(now + durationMs + MINUTE_MS);
}

function localBucket(source = {}, scale = 1) {
  const costKnown = Number.isFinite(source.cost);

  return {
    input: Math.round((source.input || 0) * scale),
    output: Math.round((source.output || 0) * scale),
    cacheRead: Math.round((source.cacheRead || 0) * scale),
    cacheWrite: Math.round((source.cacheWrite || 0) * scale),
    messages: Math.round((source.messages || 0) * scale),
    cost: costKnown ? source.cost * scale : 0,
    hasCost: costKnown,
  };
}

function demoLocalModels(models, random) {
  return models.map(({ model, today, week, month, all }) => {
    // One small per-model variation keeps every startup natural while
    // preserving the monotonic relationship between time windows.
    const scale = rand(random, 0.96, 1.04);

    return {
      model,
      today: localBucket(today, scale),
      week: localBucket(week, scale),
      month: localBucket(month, scale),
      all: localBucket(all, scale),
    };
  });
}

function singleAccountAlerts(snapshot) {
  return (snapshot.items || [])
    .filter((item) => item.kind !== 'empty' && item.kind !== 'info')
    .map((item) => ({ key: item.key, label: item.label, percent: item.percent, resetAt: item.resetAt }));
}

function makeSingleAccountDemo({
  id,
  title,
  plan,
  email,
  refreshMs = STANDARD_REFRESH_MS,
  latency = [200, 900],
  items,
  localModels,
  localFiles,
  localOpts,
}, { clock, random }) {
  const ms = randInt(random, latency[0], latency[1]);
  const local = localModels
    ? {
      ok: true,
      ...(Number.isFinite(localFiles) ? { files: localFiles } : {}),
      models: demoLocalModels(localModels, random),
    }
    : null;

  return {
    id,
    title,
    refreshMs,

    async fetch() {
      return {
        ok: true,
        ms,
        plan,
        ...(email ? { email } : {}),
        items: items(clock()),
        ...(local ? { local } : {}),
      };
    },

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, id, localOpts);
    },

    headerStatus(snapshot) {
      return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
    },

    alertItems: singleAccountAlerts,
  };
}

// --- Claude Code (system account + transcript usage) -----------------------------

const CLAUDE_LOCAL_MODELS = [
  {
    model: 'claude-sonnet-5',
    today: { output: 0, cost: 0 },
    week: { output: 1_900_000, cost: 145.55, messages: 980 },
    month: { output: 6_100_000, cost: 475.89, messages: 3100 },
    all: { output: 6_100_000, cost: 475.89, messages: 3100 },
  },
  {
    model: 'claude-fable-5',
    today: { output: 0, cost: 0 },
    week: { output: 261_400, cost: 106.59, messages: 420 },
    month: { output: 926_100, cost: 346.97, messages: 1420 },
    all: { output: 1_100_000, cost: 391.93, messages: 1710 },
  },
  {
    model: 'claude-opus-4-8',
    today: { output: 221_800, cost: 51.09, messages: 130 },
    week: { output: 329_900, cost: 72.13, messages: 240 },
    month: { output: 961_100, cost: 168.32, messages: 690 },
    all: { output: 1_200_000, cost: 202.30, messages: 860 },
  },
  {
    model: 'claude-haiku-4-5-20251001',
    today: { output: 0, cost: 0 },
    week: { output: 0, cost: 0 },
    month: { output: 2600, cost: 0.14, messages: 18 },
    all: { output: 14_000, cost: 0.54, messages: 95 },
  },
];

function makeClaudeDemo({ clock, random }) {
  const startedAt = clock();
  const weeklyReset = after(startedAt, 6 * HOUR_MS + 14 * 60 * 1000);
  const usage = {
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: randInt(random, 6, 12),
        severity: 'normal',
        resets_at: after(startedAt, 1 * HOUR_MS + 44 * 60 * 1000).toISOString(),
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: randInt(random, 70, 75),
        severity: 'normal',
        resets_at: weeklyReset.toISOString(),
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 100,
        severity: 'critical',
        resets_at: weeklyReset.toISOString(),
        scope: { model: { display_name: 'Fable' }, surface: null },
        is_active: true,
      },
    ],
    extra_usage: { is_enabled: false },
  };
  const local = { ok: true, files: 319, models: demoLocalModels(CLAUDE_LOCAL_MODELS, random) };
  const ms = randInt(random, 320, 480);

  return {
    id: 'claude',
    title: 'Claude Code',
    refreshMs: STANDARD_REFRESH_MS,

    async fetch() {
      const result = {
        name: 'system',
        source: 'system',
        plan: 'max / claude_max_20x',
        ok: true,
        ms,
        items: buildClaudeLimitItems(usage, { prefix: 'demo:claude:system', now: clock() }),
      };

      return { results: [result], local, ms };
    },

    render(snapshot, width, mode = 'detail') {
      return renderClaudeSnapshot(snapshot, width, mode);
    },

    headerStatus(snapshot) {
      if (snapshot.fatal) {
        return { ok: false, text: 'ERR' };
      }

      const counted = snapshot.results.filter((result) => result.status !== 'DUP');
      const okCount = counted.filter((result) => result.ok).length;
      return { ok: okCount === counted.length, text: `${okCount}/${counted.length} OK` };
    },

    alertItems(snapshot) {
      return snapshot.results.flatMap((result) => result.items.map((item) => ({
        key: item.key,
        label: `${result.name} ${item.label}`,
        percent: item.percent,
        resetAt: item.resetAt,
      })));
    },
  };
}

// --- Codex -----------------------------------------------------------------------

const CODEX_LOCAL_MODELS = [
  {
    model: 'gpt-5.5',
    today: { output: 0, cost: 0 },
    week: { output: 317_400, cost: 51.27, messages: 650 },
    month: { output: 537_500, cost: 94.09, messages: 1100 },
    all: { output: 771_400, cost: 142.73, messages: 1680 },
  },
  {
    model: 'gpt-5.6-sol',
    today: { output: 163_000, cost: 28.45, messages: 480 },
    week: { output: 301_900, cost: 62.13, messages: 920 },
    month: { output: 301_900, cost: 62.13, messages: 920 },
    all: { output: 301_900, cost: 62.13, messages: 920 },
  },
  {
    model: 'codex-auto-review',
    today: { output: 0, cost: null },
    week: { output: 345, cost: null, messages: 3 },
    month: { output: 345, cost: null, messages: 3 },
    all: { output: 345, cost: null, messages: 3 },
  },
];

function makeCodexDemo(context) {
  const { clock, random } = context;
  const startedAt = clock();
  const data = {
    rate_limit: {
      primary_window: {
        used_percent: randInt(random, 24, 30),
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Math.floor(after(startedAt, 5 * DAY_MS + 7 * HOUR_MS).getTime() / 1000),
      },
      secondary_window: null,
    },
    credits: { balance: 0 },
    rate_limit_reset_credits: { available_count: 5 },
  };
  const resetCreditExpiries = [
    // Keep the first row inside an hour to exercise the live seconds
    // countdown; the remaining rows retain the longer real-world spacing.
    new Date(startedAt + randInt(random, 5 * MINUTE_MS, 60 * MINUTE_MS - 1000)),
    after(startedAt, 12 * DAY_MS + 11 * HOUR_MS),
    after(startedAt, 17 * DAY_MS + 7 * HOUR_MS),
    after(startedAt, 28 * DAY_MS + 8 * HOUR_MS),
    after(startedAt, 29 * DAY_MS + 5 * HOUR_MS),
  ];

  return makeSingleAccountDemo({
    id: 'codex',
    title: 'Codex',
    plan: 'plus',
    latency: [650, 900],
    items: (now) => [
      ...buildCodexItems(data, {}, { prefix: 'demo:codex', now, resetCreditExpiries }),
      buildCodexResetForecastItem({ score: 68 }, 'demo:codex'),
    ],
    localModels: CODEX_LOCAL_MODELS,
    localFiles: 46,
    localOpts: CODEX_LOCAL_OPTS,
  }, context);
}

// --- Gemini ----------------------------------------------------------------------

const GEMINI_LOCAL_MODELS = [
  {
    model: 'gemini-3.1-pro-preview',
    today: { output: 0, cost: 0 },
    week: { output: 0, cost: 0 },
    month: { output: 0, cost: 0 },
    all: { output: 5200, cost: 0.13, messages: 18 },
  },
];

function makeGeminiDemo(context) {
  const startedAt = context.clock();
  const quota = {
    userQuota: [
      { modelId: 'gemini-3.1-pro-preview', remainingFraction: 0, resetTime: '1970-01-01T00:00:00Z' },
      { modelId: 'gemini-3-flash-preview', remainingFraction: 1, resetTime: after(startedAt, DAY_MS).toISOString() },
    ],
  };

  return makeSingleAccountDemo({
    id: 'gemini',
    title: 'Gemini',
    plan: 'Free',
    email: 'demo@example.com',
    latency: [1800, 2800],
    items: (now) => buildGeminiItems(quota, { prefix: 'demo:gemini', now }),
    localModels: GEMINI_LOCAL_MODELS,
    localFiles: 26,
    localOpts: GEMINI_LOCAL_OPTS,
  }, context);
}

// --- Kimi Code -------------------------------------------------------------------

function makeKimiDemo(context) {
  const startedAt = context.clock();
  const usage = {
    usage: {
      name: 'Weekly limit',
      used: 340,
      limit: 1000,
      resetAt: after(startedAt, 5 * DAY_MS + 8 * HOUR_MS).toISOString(),
    },
    limits: [
      {
        detail: {
          name: '5h limit',
          used: 38,
          limit: 100,
          resetAt: after(startedAt, 2 * HOUR_MS + 24 * MINUTE_MS).toISOString(),
        },
        window: { duration: 300, timeUnit: 'MINUTE' },
      },
    ],
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: '40000000000', amountLeft: '18208000000' },
      monthlyChargeLimitEnabled: false,
      monthlyUsed: { currency: 'CNY', priceInCents: 21792 },
    },
    user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
    subType: 'TYPE_PURCHASE',
    totalQuota: { limit: 100, remaining: 82 },
    parallel: { limit: 20, details: ['demo-task-1', 'demo-task-2'] },
    authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
  };
  const models = [
    {
      id: 'k3',
      displayName: 'K3',
      contextLength: 1048576,
      supportsThinking: true,
      supportsImage: true,
      supportsVideo: true,
      supportsTools: true,
    },
    {
      id: 'kimi-for-coding',
      displayName: 'K2.7 Coding',
      contextLength: 262144,
      supportsThinking: true,
      supportsImage: true,
      supportsVideo: true,
      supportsTools: true,
    },
  ];

  return makeSingleAccountDemo({
    id: 'kimi',
    title: 'Kimi Code',
    plan: 'Allegretto',
    latency: [280, 650],
    items: (now) => buildKimiItems(usage, { prefix: 'demo:kimi', now, models }),
  }, context);
}

// --- Copilot / Grok / Antigravity / OpenCode ------------------------------------

function makeCopilotDemo(context) {
  const startedAt = context.clock();
  const data = {
    quota_reset_date: after(startedAt, 18 * DAY_MS).toISOString(),
    quota_snapshots: {
      premium_interactions: { percent_remaining: 25 },
      chat: { unlimited: true, percent_remaining: 100 },
    },
  };

  return makeSingleAccountDemo({
    id: 'copilot',
    title: 'Copilot',
    plan: 'individual',
    latency: [300, 700],
    items: (now) => buildCopilotItems(data, { prefix: 'demo:copilot', now }),
  }, context);
}

function makeGrokDemo(context) {
  const startedAt = context.clock();
  const billing = {
    config: {
      used: { val: 1426 },
      monthlyLimit: { val: 4000 },
      onDemandCap: { val: 0 },
      billingPeriodEnd: after(startedAt, 17 * DAY_MS + 21 * HOUR_MS).toISOString(),
    },
  };

  return makeSingleAccountDemo({
    id: 'grok',
    title: 'Grok',
    plan: 'SuperGrok',
    latency: [350, 750],
    items: (now) => buildGrokItems(billing, { prefix: 'demo:grok', now }),
  }, context);
}

function makeAntigravityDemo(context) {
  const startedAt = context.clock();
  const data = {
    models: {
      pro: {
        model: 'GEMINI_3_PRO',
        displayName: 'Gemini 3 Pro (High)',
        quotaInfo: { remainingFraction: 1, resetTime: after(startedAt, 7 * DAY_MS).toISOString() },
      },
      flash: {
        model: 'GEMINI_3_FLASH',
        displayName: 'Gemini 3 Flash',
        quotaInfo: { remainingFraction: 1, resetTime: after(startedAt, 5 * HOUR_MS).toISOString() },
      },
      claude: {
        model: 'CLAUDE_SONNET',
        displayName: 'Claude Sonnet 4.5',
        quotaInfo: { remainingFraction: 1, resetTime: after(startedAt, 7 * DAY_MS).toISOString() },
      },
    },
  };

  return makeSingleAccountDemo({
    id: 'antigravity',
    title: 'Antigravity',
    plan: '',
    latency: [400, 650],
    items: (now) => buildAntigravityItems(data, { prefix: 'demo:antigravity', now }),
  }, context);
}

const OPENCODE_LOCAL_MODELS = [
  {
    model: 'opencode-go/claude-sonnet-5',
    today: { output: 58_700, cost: 3.70, messages: 80 },
    week: { output: 363_500, cost: 22.90, messages: 480 },
    month: { output: 1_400_000, cost: 88.63, messages: 1900 },
    all: { output: 8_000_000, cost: 503.31, messages: 10_500 },
  },
  {
    model: 'opencode-go/gpt-5.5',
    today: { output: 16_900, cost: 1.29, messages: 28 },
    week: { output: 110_400, cost: 8.37, messages: 175 },
    month: { output: 506_000, cost: 38.37, messages: 800 },
    all: { output: 3_200_000, cost: 245.38, messages: 5000 },
  },
];

function makeOpencodeDemo(context) {
  const startedAt = context.clock();
  const rows = [
    { createdMs: startedAt - 26 * DAY_MS, cost: 15 },
    { createdMs: startedAt - DAY_MS, cost: 9 },
    { createdMs: startedAt - HOUR_MS, cost: 6 },
  ];

  return makeSingleAccountDemo({
    id: 'opencode',
    title: 'OpenCode',
    plan: 'Go',
    latency: [20, 80],
    items: (now) => buildOpencodeItems(rows, { prefix: 'demo:opencode', now }),
    localModels: OPENCODE_LOCAL_MODELS,
    localOpts: OPENCODE_LOCAL_OPTS,
  }, context);
}

// --- z.ai (two accounts, including proxy layout) ---------------------------------

function zaiQuota({ session, sessionReset, weekly, weeklyReset, webReset }) {
  return {
    data: {
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          percentage: session,
          ...(sessionReset ? { nextResetTime: sessionReset.getTime() } : {}),
        },
        {
          type: 'TOKENS_LIMIT',
          unit: 6,
          percentage: weekly,
          nextResetTime: weeklyReset.getTime(),
        },
        {
          type: 'TIME_LIMIT',
          percentage: 0,
          currentValue: 0,
          usage: 1000,
          nextResetTime: webReset.getTime(),
          usageDetails: [
            { modelCode: 'search-prime', usage: 0 },
            { modelCode: 'web-reader', usage: 0 },
            { modelCode: 'zread', usage: 0 },
          ],
        },
      ],
    },
  };
}

function makeZaiDemo({ clock, random }) {
  const startedAt = clock();
  const fixtures = [
    {
      account: { name: 'Account 1', key: 'demo01...keyA', proxy: 'direct' },
      ms: randInt(random, 1050, 1350),
      quota: zaiQuota({
        session: 0,
        weekly: randInt(random, 91, 95),
        weeklyReset: after(startedAt, 3 * DAY_MS + 13 * HOUR_MS),
        webReset: after(startedAt, 27 * DAY_MS + 13 * HOUR_MS),
      }),
    },
    {
      account: { name: 'Account 2', key: 'demo02...keyB', proxy: 'http://192.0.2.10:8002' },
      ms: randInt(random, 550, 750),
      quota: zaiQuota({
        session: 1,
        sessionReset: after(startedAt, 4 * HOUR_MS + 49 * 60 * 1000),
        weekly: randInt(random, 28, 32),
        weeklyReset: after(startedAt, 4 * DAY_MS + 21 * HOUR_MS),
        webReset: after(startedAt, 13 * DAY_MS + 21 * HOUR_MS),
      }),
    },
  ];

  return {
    id: 'zai',
    title: 'z.ai',
    refreshMs: ZAI_REFRESH_MS,

    async fetch() {
      const now = clock();
      return {
        results: fixtures.map((fixture) => ({
          account: fixture.account,
          ok: true,
          ms: fixture.ms,
          plan: 'GLM Coding Pro',
          items: buildZaiItems(fixture.quota, { prefix: `demo:zai:${fixture.account.name}`, now }),
          status: 'OK',
          error: '',
          body: '',
          url: '',
          partial: '',
          quotaSample: '',
        })),
      };
    },

    render(snapshot, width, mode = 'detail') {
      const joiner = mode === 'compact' ? '\n' : '\n\n';
      return snapshot.results.map((result) => renderZaiAccountBlock(result, width, mode)).join(joiner);
    },

    headerStatus(snapshot) {
      const okCount = snapshot.results.filter((result) => result.ok).length;
      return { ok: okCount === snapshot.results.length, text: `${okCount}/${snapshot.results.length} OK` };
    },

    alertItems(snapshot) {
      return snapshot.results.flatMap((result) => result.items
        .filter((item) => item.kind === 'usage')
        .map((item) => ({
          key: item.key,
          label: [result.account.name, item.label].filter(Boolean).join(' '),
          percent: item.percent,
          resetAt: item.resetAt,
        })));
    },
  };
}

export function makeDemoProviders(ids = DEFAULT_DEMO_IDS, { clock = Date.now, random = Math.random } = {}) {
  const context = { clock, random };
  const providers = [
    makeClaudeDemo(context),
    makeCodexDemo(context),
    makeGeminiDemo(context),
    makeKimiDemo(context),
    makeCopilotDemo(context),
    makeGrokDemo(context),
    makeAntigravityDemo(context),
    makeOpencodeDemo(context),
    makeZaiDemo(context),
  ];

  return ids?.length ? providers.filter((provider) => ids.includes(provider.id)) : providers;
}

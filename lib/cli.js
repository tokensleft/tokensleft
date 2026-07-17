import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadDotEnv } from './env.js';
import { sanitizeTerminalText, stripBlessedTags, truncateVisible } from './format.js';
import { configPath } from './fsx.js';
import { loadNodeSqlite } from './runtime.js';

const PLAIN_WIDTH = 96;
const USER_ENV_PATH = configPath('.env');
const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

// One entry per provider, in dashboard order. Provider modules are imported
// lazily so --help, --demo, and single-provider runs don't pay for the whole
// provider fleet. `hint` is what the user sees when they ask for
// exactly this provider and it isn't detected; `envKeys` marks providers that
// also accept manual keys, so the hint gets the where-do-keys-go suffix.
export const PROVIDERS = [
  { id: 'claude', envKeys: true, make: (env) => import('../providers/claude.js').then((m) => m.createClaudeProvider(env)), hint: 'No Claude Code credentials found. Run `claude` and /login, or set CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_TOKEN_1.' },
  { id: 'codex', make: (env) => import('../providers/codex.js').then((m) => m.createCodexProvider(env)), hint: 'No Codex credentials found (~/.codex/auth.json or CODEX_HOME). Run `codex` to log in first.' },
  { id: 'gemini', make: (env) => import('../providers/gemini.js').then((m) => m.createGeminiProvider(env)), hint: 'No Gemini credentials found (~/.gemini/oauth_creds.json). Run `gemini` and sign in first.' },
  { id: 'kimi', envKeys: true, make: (env) => import('../providers/kimi.js').then((m) => m.createKimiProvider(env)), hint: 'No Kimi Code credentials found (~/.kimi-code/credentials/kimi-code.json). Run `kimi` and /login, or set KIMI_CODE_API_KEY_1 / KIMI_CODE_API_KEY.' },
  { id: 'copilot', envKeys: true, make: (env) => import('../providers/copilot.js').then((m) => m.createCopilotProvider(env)), hint: 'No GitHub token found. Run `gh auth login`, sign in to Copilot in your editor, or set COPILOT_TOKEN / GH_TOKEN / GITHUB_TOKEN.' },
  { id: 'grok', envKeys: true, make: (env) => import('../providers/grok.js').then((m) => m.createGrokProvider(env)), hint: 'No Grok credentials found (~/.grok/auth.json). Run `grok login` first, or set GROK_TOKEN.' },
  { id: 'antigravity', requiresNodeSqlite: true, make: (env) => import('../providers/antigravity.js').then((m) => m.createAntigravityProvider(env)), hint: 'No Antigravity state found. Start Antigravity and sign in first.' },
  { id: 'opencode', requiresNodeSqlite: true, make: (env) => import('../providers/opencode.js').then((m) => m.createOpencodeProvider(env)), hint: 'No OpenCode data found (~/.local/share/opencode). Log in with OpenCode or use it locally first.' },
  { id: 'zai', envKeys: true, make: (env) => import('../providers/zai.js').then((m) => m.createZaiProvider(env)), hint: 'No z.ai keys found. Set ZAI_API_KEY_1 (or ZAI_KEY_1 / GLM_API_KEY_1), or log in to Claude Code with a profile pointing at api.z.ai.' },
];

export function manualKeysHint() {
  return `Manual keys go in ${USER_ENV_PATH} (read from any directory) or ./.env (wins on conflicts); .env.example in the tokensleft package lists every variable.`;
}

export function isNpxExecution(env = process.env) {
  const lifecycle = String(env.npm_lifecycle_event || '').toLowerCase();
  const command = String(env.npm_command || '').toLowerCase();
  const execPath = String(env.npm_execpath || '').replaceAll('\\', '/');

  // Modern npm implements npx as `npm exec`. Older standalone npx versions
  // exposed their own executable path instead of npm_command=exec.
  return lifecycle === 'npx'
    && (command === 'exec' || (!command && /\/npx(?:-cli)?(?:\.js)?$/i.test(execPath)));
}

export async function resolveProviderSupport(entries, loadSqlite = loadNodeSqlite) {
  if (!entries.some((entry) => entry.requiresNodeSqlite)) {
    return { supported: entries, skipped: [] };
  }

  if (await loadSqlite()) {
    return { supported: entries, skipped: [] };
  }

  return {
    supported: entries.filter((entry) => !entry.requiresNodeSqlite),
    skipped: entries.filter((entry) => entry.requiresNodeSqlite),
  };
}

function sqliteUnavailableMessage(entries) {
  const names = entries.map((entry) => entry.id === 'opencode' ? 'OpenCode' : 'Antigravity');
  const label = names.length === 1 ? names[0] : names.join(' and ');
  return `${label} ${names.length === 1 ? 'requires' : 'require'} node:sqlite and ${names.length === 1 ? 'was' : 'were'} skipped on this Node.js runtime. Use Node.js 22.13 or newer to enable ${names.length === 1 ? 'this provider' : 'these providers'}.`;
}

// User-facing errors: bin/tokensleft.js prints only the message for these and
// keeps the full stack for everything else.
function fail(message) {
  const error = new Error(message);
  error.friendly = true;
  return error;
}

// Manual keys: ~/.tokensleft/.env first (works from any directory, e.g. via
// `npx tokensleft`), then ./.env on top (project-local overrides), both over
// process.env. The cwd .env may belong to an unrelated project, so say when
// it is being read.
async function loadEnv() {
  if (existsSync('.env')) {
    console.error(`tokensleft: reading manual keys from ${resolve('.env')}`);
  }

  return loadDotEnv('.env', await loadDotEnv(USER_ENV_PATH));
}

export function usage() {
  return [
    'tokensleft — AI subscription quota dashboards in the terminal',
    '',
    'Usage: tokensleft [providers...] [options]',
    '',
    `Providers (default: all detected): ${PROVIDERS.map((entry) => entry.id).join(' ')}`,
    '',
    'Options:',
    '  --demo            realistic random data — no credentials, no network',
    '  --once            print one plain-text snapshot and exit',
    '  --json            print one JSON snapshot and exit',
    '  --read-only       never refresh or persist credential updates',
    '  --interval <s>    refresh interval in seconds',
    '  -h, --help        show this help',
    '  -v, --version     show the installed version',
    '',
    'Keys are auto-discovered from logged-in CLIs.',
    manualKeysHint(),
  ].join('\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.version) {
    console.log(VERSION);
    return;
  }

  const selected = args.providers.length > 0
    ? PROVIDERS.filter((entry) => args.providers.includes(entry.id))
    : PROVIDERS;
  let providers;
  let skippedProviders = [];
  let dashboardEnv = process.env;

  if (args.demo) {
    const { makeDemoProviders } = await import('./demo.js');
    // With no explicit provider list, use the curated live-shaped demo rather
    // than pretending every supported integration is installed at once.
    providers = makeDemoProviders(args.providers.length > 0
      ? selected.map((entry) => entry.id)
      : undefined);
  } else {
    const env = providerEnvironment(await loadEnv(), args.readOnly);
    dashboardEnv = env;
    const support = await resolveProviderSupport(selected);
    skippedProviders = support.skipped;
    providers = (await Promise.all(support.supported.map((entry) => entry.make(env)))).filter(Boolean);
  }

  if (providers.length === 0) {
    if (selected.length === 1 && skippedProviders.length === 1) {
      throw fail(sqliteUnavailableMessage(skippedProviders));
    }

    if (selected.length === 1) {
      const suffix = selected[0].envKeys ? `\n${manualKeysHint()}` : '';
      throw fail(`${selected[0].hint}${suffix}`);
    }

    const skipped = skippedProviders.length > 0 ? `\n${sqliteUnavailableMessage(skippedProviders)}` : '';
    throw fail(`No providers detected. Log in to any supported CLI first. ${manualKeysHint()}${skipped}`);
  }

  if (args.intervalMs) {
    for (const provider of providers) {
      provider.refreshMs = args.intervalMs;
    }
  }

  if (args.json) {
    const entries = await Promise.all(providers.map(async (provider) => [provider.id, await provider.fetch()]));
    console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
    return;
  }

  if (args.once || !process.stdout.isTTY) {
    const width = plainOutputWidth(process.stdout, process.env);
    const blocks = await Promise.all(providers.map(async (provider) => {
      const snapshot = await provider.fetch();
      return formatPlainProviderBlock(provider, snapshot, width, providers.length > 1);
    }));
    console.log(blocks.join(`\n${'-'.repeat(Math.max(1, Math.min(72, width)))}\n`));
    return;
  }

  // The provider's own title is the single naming authority.
  const heading = providers.length === 1
    ? `TokensLeft — ${providers[0].title}`
    : 'TokensLeft — AI usage across providers';
  const [
    { runDashboard, terminalProfile, uiColorMode },
    { loadResetHistory, recordResetEvent },
  ] = await Promise.all([
    import('./tui.js'),
    import('./reset-history.js'),
  ]);
  const initialResetHistory = await loadResetHistory();
  runDashboard({
    screenTitle: heading,
    title: 'TokensLeft',
    commandPrefix: isNpxExecution(process.env) ? 'npx' : '',
    terminal: terminalProfile(dashboardEnv),
    colorMode: uiColorMode(dashboardEnv),
    providers,
    initialResetHistory,
    saveResetEvent: recordResetEvent,
  });
}

export function formatPlainProviderBlock(provider, snapshot, width, showHeader = false) {
  const body = stripBlessedTags(provider.render(snapshot, width))
    .split('\n')
    .map((line) => truncateVisible(sanitizeTerminalText(line), width))
    .join('\n');

  if (!showHeader) {
    return body;
  }

  const header = truncateVisible(sanitizeTerminalText(`▌ ${provider.title}`), width);
  return `${header}\n${body}`;
}

export function parseArgs(argv) {
  const args = {
    providers: [],
    json: false,
    once: false,
    demo: false,
    help: false,
    version: false,
    readOnly: false,
    intervalMs: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--once') {
      args.once = true;
    } else if (arg === '--demo') {
      args.demo = true;
    } else if (arg === '--read-only') {
      args.readOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--interval' || arg.startsWith('--interval=')) {
      const raw = arg === '--interval' ? argv[(index += 1)] : arg.slice('--interval='.length);
      const seconds = Number(raw);

      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw fail(`--interval expects a positive number of seconds, got: ${raw ?? 'nothing'}\n\n${usage()}`);
      }

      args.intervalMs = Math.max(5, seconds) * 1000;
    } else if (arg.startsWith('-')) {
      throw fail(`Unknown option: ${arg}\n\n${usage()}`);
    } else if (PROVIDERS.some((entry) => entry.id === arg)) {
      if (!args.providers.includes(arg)) {
        args.providers.push(arg);
      }
    } else {
      throw fail(`Unknown provider: ${arg}\n\n${usage()}`);
    }
  }

  return args;
}

export function providerEnvironment(env, readOnly = false) {
  return readOnly ? { ...env, TOKENSLEFT_READ_ONLY: '1' } : env;
}

export function plainOutputWidth(stdout = process.stdout, env = process.env) {
  const terminalWidth = Number(stdout?.columns);
  const envWidth = Number(env.COLUMNS);
  const candidate = Number.isFinite(terminalWidth) && terminalWidth > 0
    ? terminalWidth
    : Number.isFinite(envWidth) && envWidth > 0
      ? envWidth
      : PLAIN_WIDTH;
  return Math.max(20, Math.min(160, Math.floor(candidate)));
}

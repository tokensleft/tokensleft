import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from './env.js';
import { stripBlessedTags } from './format.js';
import { configPath } from './fsx.js';

const PLAIN_WIDTH = 96;
const USER_ENV_PATH = configPath('.env');

// One entry per provider, in dashboard order. Provider modules are imported
// lazily so --help, --demo, and single-provider runs don't pay for the whole
// fleet (or for blessed). `hint` is what the user sees when they ask for
// exactly this provider and it isn't detected; `envKeys` marks providers that
// also accept manual keys, so the hint gets the where-do-keys-go suffix.
export const PROVIDERS = [
  { id: 'claude', envKeys: true, make: (env) => import('../providers/claude.js').then((m) => m.createClaudeProvider(env)), hint: 'No Claude Code credentials found. Run `claude` and /login, or set CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_TOKEN_1.' },
  { id: 'codex', make: (env) => import('../providers/codex.js').then((m) => m.createCodexProvider(env)), hint: 'No Codex credentials found (~/.codex/auth.json or CODEX_HOME). Run `codex` to log in first.' },
  { id: 'gemini', make: (env) => import('../providers/gemini.js').then((m) => m.createGeminiProvider(env)), hint: 'No Gemini credentials found (~/.gemini/oauth_creds.json). Run `gemini` and sign in first.' },
  { id: 'copilot', envKeys: true, make: (env) => import('../providers/copilot.js').then((m) => m.createCopilotProvider(env)), hint: 'No GitHub token found. Run `gh auth login`, sign in to Copilot in your editor, or set COPILOT_TOKEN / GH_TOKEN / GITHUB_TOKEN.' },
  { id: 'grok', envKeys: true, make: (env) => import('../providers/grok.js').then((m) => m.createGrokProvider(env)), hint: 'No Grok credentials found (~/.grok/auth.json). Run `grok login` first, or set GROK_TOKEN.' },
  { id: 'antigravity', make: (env) => import('../providers/antigravity.js').then((m) => m.createAntigravityProvider(env)), hint: 'No Antigravity state found. Start Antigravity and sign in first.' },
  { id: 'opencode', make: (env) => import('../providers/opencode.js').then((m) => m.createOpencodeProvider(env)), hint: 'No OpenCode data found (~/.local/share/opencode). Log in with OpenCode or use it locally first.' },
  { id: 'zai', envKeys: true, make: (env) => import('../providers/zai.js').then((m) => m.createZaiProvider(env)), hint: 'No z.ai keys found. Set ZAI_API_KEY_1 (or ZAI_KEY_1 / GLM_API_KEY_1), or log in to Claude Code with a profile pointing at api.z.ai.' },
];

export function manualKeysHint() {
  return `Manual keys go in ${USER_ENV_PATH} (read from any directory) or ./.env (wins on conflicts); .env.example in the tokensleft package lists every variable.`;
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
    '  --interval <s>    refresh interval in seconds',
    '  -h, --help        show this help',
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

  const selected = args.providers.length > 0
    ? PROVIDERS.filter((entry) => args.providers.includes(entry.id))
    : PROVIDERS;
  let providers;

  if (args.demo) {
    const { makeDemoProviders } = await import('./demo.js');
    providers = makeDemoProviders(selected.map((entry) => entry.id));
  } else {
    const env = await loadEnv();
    providers = (await Promise.all(selected.map((entry) => entry.make(env)))).filter(Boolean);
  }

  if (providers.length === 0) {
    if (selected.length === 1) {
      const suffix = selected[0].envKeys ? `\n${manualKeysHint()}` : '';
      throw fail(`${selected[0].hint}${suffix}`);
    }

    throw fail(`No providers detected. Log in to any supported CLI first. ${manualKeysHint()}`);
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
    const blocks = await Promise.all(providers.map(async (provider) => {
      const snapshot = await provider.fetch();
      const body = stripBlessedTags(provider.render(snapshot, PLAIN_WIDTH));
      return providers.length > 1 ? `▌ ${provider.title}\n${body}` : body;
    }));
    console.log(blocks.join(`\n${'-'.repeat(72)}\n`));
    return;
  }

  // The provider's own title is the single naming authority.
  const heading = providers.length === 1
    ? `tokensleft — ${providers[0].title}`
    : 'tokensleft — AI usage across providers';
  const { runDashboard } = await import('./tui.js');
  runDashboard({ screenTitle: heading, title: heading, providers });
}

export function parseArgs(argv) {
  const args = { providers: [], json: false, once: false, demo: false, help: false, intervalMs: 0 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--once') {
      args.once = true;
    } else if (arg === '--demo') {
      args.demo = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
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

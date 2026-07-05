import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJson } from './http.js';

export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Claude Code profiles (settings.json, settings.<profile>.json) can route to
// third-party Anthropic-compatible endpoints via env.ANTHROPIC_BASE_URL +
// env.ANTHROPIC_AUTH_TOKEN. Those tokens ARE the provider API keys (e.g. a
// GLM coding-plan key when the base URL points at api.z.ai), so providers can
// auto-discover them instead of requiring a duplicate entry in .env.
export async function discoverClaudeSettingsKeys(configDir) {
  let entries;

  try {
    entries = await readdir(configDir);
  } catch {
    return [];
  }

  const found = [];

  for (const entry of entries) {
    if (!/^settings(\.[\w-]+)?\.json$/.test(entry)) {
      continue;
    }

    const raw = await readFile(join(configDir, entry), 'utf8').catch(() => '');
    const env = parseJson(raw)?.env;
    const key = env?.ANTHROPIC_AUTH_TOKEN;

    if (!key || typeof key !== 'string') {
      continue;
    }

    found.push({
      file: entry,
      name: entry === 'settings.json' ? 'claude-env' : entry.replace(/^settings\./, '').replace(/\.json$/, ''),
      key: key.trim(),
      baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '',
    });
  }

  return found;
}

export function matchesHost(baseUrl, hostFragment) {
  return typeof baseUrl === 'string' && baseUrl.includes(hostFragment);
}

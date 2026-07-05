import { readFile } from 'node:fs/promises';

export async function loadDotEnv(path = '.env', base = process.env) {
  let content = '';

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    // A present-but-unreadable .env (permissions, a directory by mistake)
    // should not take the whole dashboard down — warn and continue without it.
    if (error.code !== 'ENOENT') {
      console.error(`tokensleft: skipping ${path}: ${error.message}`);
    }
  }

  return parseDotEnv(content, base);
}

export function parseDotEnv(content, base = {}) {
  const env = { ...base };

  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalIndex = line.indexOf('=');

    if (equalIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    const value = unquote(line.slice(equalIndex + 1).trim());

    if (key) {
      env[key] = value;
    }
  }

  return env;
}

export function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function splitCsv(value) {
  return String(value).split(',').map((item) => item.trim());
}

// Reads the first defined env key (values are seconds) and returns milliseconds.
export function readRefreshMs(env, keys, fallbackMs) {
  for (const key of keys) {
    const seconds = Number(env[key] || '');

    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.max(5, seconds) * 1000;
    }
  }

  return fallbackMs;
}

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AtomicWriteConflictError,
  configPath,
  writeFileAtomic,
} from './fsx.js';

export const RESET_HISTORY_PATH = configPath('reset-history.json');
export const MAX_RESET_HISTORY_ENTRIES = 100;

const WRITE_RETRIES = 3;

function cleanText(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeResetEvent(value) {
  const detectedAt = new Date(value?.detectedAt);
  const provider = cleanText(value?.provider);
  const providerId = cleanText(value?.providerId || provider, 80);

  if (!provider || !providerId || Number.isNaN(detectedAt.getTime())) {
    return null;
  }

  const windows = (Array.isArray(value?.windows) ? value.windows : [])
    .map((window) => ({
      key: cleanText(window?.key, 120),
      label: cleanText(window?.label || window?.key, 120),
    }))
    .filter((window) => window.key || window.label)
    .slice(0, 20);

  return {
    providerId,
    provider,
    windows,
    detectedAt: detectedAt.toISOString(),
  };
}

export function normalizeResetHistory(value, maxEntries = MAX_RESET_HISTORY_ENTRIES) {
  const source = Array.isArray(value) ? value : value?.events;
  const limit = Math.max(1, Math.floor(Number(maxEntries) || MAX_RESET_HISTORY_ENTRIES));

  return (Array.isArray(source) ? source : [])
    .map(normalizeResetEvent)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
    .slice(0, limit);
}

async function readHistoryFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function parseHistory(raw, maxEntries) {
  if (!raw) {
    return [];
  }

  try {
    return normalizeResetHistory(JSON.parse(raw), maxEntries);
  } catch {
    return [];
  }
}

export async function loadResetHistory({
  path = RESET_HISTORY_PATH,
  maxEntries = MAX_RESET_HISTORY_ENTRIES,
} = {}) {
  try {
    return parseHistory(await readHistoryFile(path), maxEntries);
  } catch {
    // Reset history is optional UI state; an unreadable file must not prevent
    // the quota dashboard from starting.
    return [];
  }
}

export async function recordResetEvent(event, {
  path = RESET_HISTORY_PATH,
  maxEntries = MAX_RESET_HISTORY_ENTRIES,
} = {}) {
  const normalized = normalizeResetEvent(event);

  if (!normalized) {
    throw new TypeError('reset event requires a provider and valid detectedAt timestamp');
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
    const raw = await readHistoryFile(path);
    const events = normalizeResetHistory([normalized, ...parseHistory(raw, maxEntries)], maxEntries);
    const serialized = `${JSON.stringify({ version: 1, events }, null, 2)}\n`;

    try {
      await writeFileAtomic(path, serialized, { expectedContent: raw });
      return events;
    } catch (error) {
      if (!(error instanceof AtomicWriteConflictError) || attempt === WRITE_RETRIES - 1) {
        throw error;
      }
    }
  }

  return [normalized];
}

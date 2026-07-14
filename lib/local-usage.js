import { open, stat } from 'node:fs/promises';
import {
  escapeBlessed,
  formatTokens,
  padStart,
  padVisible,
  truncateTagged,
} from './format.js';
import { COLOR, resolveUiColor } from './palette.js';

// Shared machinery for the "Local usage by model" tables: every provider that
// keeps token counts on disk (Claude Code transcripts, Codex rollouts, Gemini
// CLI session files, ...) feeds per-response usage events through the same
// aggregation and rendering. Shown in the detail view only (the `d` key).

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Canonical usage event: { t, id?, model, input, output, cacheRead,
// cacheWrite, cost } — `input` excludes cached tokens, `cost` is USD or null
// when the model's pricing is unknown.

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messages: 0,
    cost: 0,
    hasCost: false,
    hasUnknownCost: false,
  };
}

function addUsage(target, event) {
  target.input += event.input || 0;
  target.output += event.output || 0;
  target.cacheRead += event.cacheRead || 0;
  target.cacheWrite += event.cacheWrite || 0;
  target.messages += 1;

  if (Number.isFinite(event.cost)) {
    target.hasCost = true;
    target.cost += event.cost;
  } else {
    target.hasUnknownCost = true;
  }
}

// Buckets canonical events into per-model today / 7d / 30d / all-time totals
// ("all" being whatever logs still exist on disk), deduping by event id
// (when present) across files.
export function aggregateUsageEvents(eventLists, { now = Date.now(), toUsage = (event) => event } = {}) {
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const weekStart = now - WEEK_MS;
  const monthStart = now - MONTH_MS;
  const perModel = new Map();
  const seen = new Set();

  for (const events of eventLists) {
    for (const raw of events) {
      if (raw.id) {
        if (seen.has(raw.id)) {
          continue;
        }

        seen.add(raw.id);
      }

      const event = toUsage(raw);
      const model = event.model || 'unknown';
      let bucket = perModel.get(model);

      if (!bucket) {
        bucket = { model, today: emptyUsage(), week: emptyUsage(), month: emptyUsage(), all: emptyUsage() };
        perModel.set(model, bucket);
      }

      addUsage(bucket.all, event);

      if (raw.t >= monthStart) {
        addUsage(bucket.month, event);
      }

      if (raw.t >= weekStart) {
        addUsage(bucket.week, event);
      }

      if (raw.t >= todayStart) {
        addUsage(bucket.today, event);
      }
    }
  }

  return [...perModel.values()].sort((a, b) => (b.all.cost - a.all.cost) || (b.all.output - a.all.output));
}

// Generic incremental scanner. `listFiles()` returns the candidate log paths
// (throwing a user-facing Error when the log directory is missing);
// `refreshFile(filePath, info, cached)` brings one file's `cached.events` up
// to date. Every log on disk counts — the first scan parses full history for
// the all-time window, later scans only touch appended data — and files
// deleted from disk drop out of the cache.
export function createLocalUsageScanner({ listFiles, refreshFile, initState = () => null, toUsage }) {
  const fileCache = new Map(); // path -> { offset, events, state, ... }

  return {
    async scan(now = Date.now()) {
      const seenFiles = new Set();
      let paths;

      try {
        paths = await listFiles();
      } catch (error) {
        if (fileCache.size > 0) {
          return {
            ok: true,
            partial: true,
            failedFiles: [{ path: '', error: error.message }],
            files: fileCache.size,
            models: aggregateUsageEvents([...fileCache.values()].map((cached) => cached.events), { now, toUsage }),
          };
        }

        return { ok: false, error: error.message, models: [] };
      }

      let files = 0;
      const failedFiles = [];

      for (const filePath of paths) {
        seenFiles.add(filePath);
        let info;

        try {
          info = await stat(filePath);
        } catch (error) {
          failedFiles.push({ path: filePath, error: error.message });
          continue;
        }

        files += 1;
        const previous = fileCache.get(filePath);
        let working;

        // new file, or a file that shrank (rotated/rewritten) — (re)parse fully
        if (!previous || previous.offset > info.size) {
          working = { offset: 0, events: [], state: initState() };
        } else {
          // Refresh transactionally: a partial read/parse failure must not
          // corrupt the last-known-good offset, parser state, or events.
          working = structuredClone(previous);
        }

        try {
          await refreshFile(filePath, info, working);
          fileCache.set(filePath, working);
        } catch (error) {
          failedFiles.push({ path: filePath, error: error.message });
        }
      }

      for (const filePath of fileCache.keys()) {
        if (!seenFiles.has(filePath)) {
          fileCache.delete(filePath);
        }
      }

      const eventLists = [...fileCache.values()].map((cached) => cached.events);
      return {
        ok: true,
        files,
        partial: failedFiles.length > 0,
        failedFiles,
        models: aggregateUsageEvents(eventLists, { now, toUsage }),
      };
    },
  };
}

const MAX_SLICE_BYTES = 64 * 1024 * 1024;

// refreshFile implementation for append-only JSONL logs: remembers the byte
// offset of the last complete line and only parses what was appended, in
// slices of at most MAX_SLICE_BYTES so a huge backlog never means a
// file-sized allocation. `parseChunk(text, state)` returns
// { events, remainder } and may carry parser state (current model, running
// totals) across chunks via `state`.
export function jsonlRefresher(parseChunk) {
  const readSlice = async (filePath, position, length) => {
    const handle = await open(filePath, 'r');

    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  };

  return async (filePath, info, cached) => {
    while (cached.offset < info.size) {
      const length = Math.min(info.size - cached.offset, MAX_SLICE_BYTES);
      const text = await readSlice(filePath, cached.offset, length);
      const { events, remainder } = parseChunk(text, cached.state);
      const consumed = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(remainder, 'utf8');
      cached.events.push(...events);

      if (consumed > 0) {
        cached.offset += consumed;
        continue;
      }

      if (length < MAX_SLICE_BYTES) {
        break; // partial trailing line — completed once more data is appended
      }

      // A single line larger than the slice cap can't be a usage record —
      // skip the slice; the mid-line tail parses as garbage and is dropped.
      cached.offset += length;
    }
  };
}

// --- rendering -------------------------------------------------------------------

function formatMoney(cost) {
  return cost >= 1000 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
}

function formatCost(usage) {
  if (!usage.hasCost) {
    return usage.messages > 0 ? '?' : '$0.00';
  }

  return `${formatMoney(usage.cost)}${usage.hasUnknownCost ? '+?' : ''}`;
}

const DEFAULT_NOTE = '$ = estimated from public API prices; subscription usage is prepaid';
const WINDOWS = [
  { key: 'today', label: 'today' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'all', label: 'all' },
];

export function modelTableWindowsFor(width = 98) {
  const available = Math.max(1, Number(width) || 98);

  if (available >= 90) {
    return WINDOWS;
  }

  if (available >= 68) {
    return [WINDOWS[0], WINDOWS[1], WINDOWS[3]];
  }

  if (available >= 48) {
    return [WINDOWS[0], WINDOWS[3]];
  }

  return [WINDOWS[3]];
}

export function formatModelTable(models, {
  shorten = (model) => model,
  tone = () => 'white',
  note = DEFAULT_NOTE,
  width = 98,
} = {}) {
  const availableWidth = Math.max(1, Number(width) || 98);
  const windows = modelTableWindowsFor(availableWidth);
  const modelWidth = Math.max(6, Math.min(42, availableWidth - 2 - windows.length * 19));
  const rows = [];
  const header = [
    padVisible('model', modelWidth),
    ...windows.flatMap((window) => [padStart(`${window.label} out`, 9), padStart(`${window.label} $`, 8)]),
  ].join(' ');
  rows.push(`  {${COLOR.secondary}-fg}{underline}${escapeBlessed(header)}{/underline}{/${COLOR.secondary}-fg}`);

  const totals = Object.fromEntries(windows.map((window) => [window.key, {
    output: 0,
    cost: 0,
    partial: false,
  }]));

  for (const entry of models) {
    const line = [
      padVisible(shorten(entry.model), modelWidth),
      ...windows.flatMap((window) => [
        padStart(formatTokens(entry[window.key].output), 9),
        padStart(formatCost(entry[window.key]), 8),
      ]),
    ].join(' ');
    const rowTone = resolveUiColor(tone(entry.model));
    rows.push(`  {${rowTone}-fg}${escapeBlessed(line)}{/${rowTone}-fg}`);

    for (const window of windows) {
      totals[window.key].output += entry[window.key].output;
      totals[window.key].cost += entry[window.key].cost;
      totals[window.key].partial ||= Boolean(
        entry[window.key].hasUnknownCost
        || (entry[window.key].messages > 0 && !entry[window.key].hasCost),
      );
    }
  }

  const totalLine = [
    padVisible('total', modelWidth),
    ...windows.flatMap((window) => [
      padStart(formatTokens(totals[window.key].output), 9),
      padStart(`${formatMoney(totals[window.key].cost)}${totals[window.key].partial ? '+?' : ''}`, 8),
    ]),
  ].join(' ');
  rows.push(`  {bold}${escapeBlessed(totalLine)}{/bold}`);

  if (note) {
    rows.push(truncateTagged(`  {${COLOR.muted}-fg}${escapeBlessed(note)}{/${COLOR.muted}-fg}`, availableWidth));
  }

  if (Object.values(totals).some((total) => total.partial)) {
    rows.push(truncateTagged(
      `  {${COLOR.warning}-fg}+? partial total: some model prices are unavailable{/${COLOR.warning}-fg}`,
      availableWidth,
    ));
  }

  return rows.join('\n');
}

// Full "Local usage by model" section for the detail view.
export function renderLocalUsage(local, { source = 'transcripts', width = 98, ...tableOpts } = {}) {
  const windows = modelTableWindowsFor(width);
  const windowSummary = windows.map((window) => window.label === 'all' ? 'all time' : window.label).join(' / ');
  const fileCount = local.ok && Number.isFinite(local.files) ? ` | ${local.files} files` : '';
  const header = truncateTagged(
    `{${COLOR.accent}-fg}{bold}Local usage by model{/bold}{/${COLOR.accent}-fg} {${COLOR.muted}-fg}(${escapeBlessed(source)}, ${windowSummary}${fileCount}){/${COLOR.muted}-fg}`,
    width,
  );
  const body = local.ok
    ? local.models.length > 0
      ? formatModelTable(local.models, { ...tableOpts, width })
      : `  {${COLOR.secondary}-fg}no local usage recorded{/${COLOR.secondary}-fg}`
    : `  {${COLOR.danger}-fg}${escapeBlessed(local.error || 'scan failed')}{/${COLOR.danger}-fg}`;
  const partial = local.partial
    ? `\n  {${COLOR.warning}-fg}partial · ${local.failedFiles?.length || 1} file${local.failedFiles?.length === 1 ? '' : 's'} could not be refreshed; last good data kept{/${COLOR.warning}-fg}`
    : '';

  return `${header}\n${(body + partial).split('\n').map((line) => truncateTagged(line, width)).join('\n')}`;
}

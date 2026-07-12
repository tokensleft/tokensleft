import { open, stat } from 'node:fs/promises';
import { escapeBlessed, formatTokens, padStart, padVisible } from './format.js';

// Shared machinery for the "Local usage by model" tables: every provider that
// keeps token counts on disk (Claude Code transcripts, Codex rollouts, Gemini
// CLI session files, ...) feeds per-response usage events through the same
// aggregation and rendering. Shown in the detail view only (the `d` key).

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Canonical usage event: { t, id?, model, input, output, cacheRead,
// cacheWrite, cost } — `input` excludes cached tokens, `cost` is USD or null
// when the model's pricing is unknown.

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, hasCost: false };
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
  }
}

// Buckets canonical events into per-model today/week totals, deduping by
// event id (when present) across files.
export function aggregateUsageEvents(eventLists, { weekStart, todayStart, toUsage = (event) => event }) {
  const perModel = new Map();
  const seen = new Set();

  for (const events of eventLists) {
    for (const raw of events) {
      if (raw.t < weekStart) {
        continue;
      }

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
        bucket = { model, today: emptyUsage(), week: emptyUsage() };
        perModel.set(model, bucket);
      }

      addUsage(bucket.week, event);

      if (raw.t >= todayStart) {
        addUsage(bucket.today, event);
      }
    }
  }

  return [...perModel.values()].sort((a, b) => (b.week.cost - a.week.cost) || (b.week.output - a.week.output));
}

// Generic incremental scanner. `listFiles()` returns the candidate log paths
// (throwing a user-facing Error when the log directory is missing);
// `refreshFile(filePath, info, cached)` brings one file's `cached.events` up
// to date. Files untouched for a week are dropped from the cache entirely.
export function createLocalUsageScanner({ listFiles, refreshFile, initState = () => null, toUsage }) {
  const fileCache = new Map(); // path -> { offset, events, state, ... }

  return {
    async scan(now = Date.now()) {
      const weekStart = now - WEEK_MS;
      const todayStart = new Date(now).setHours(0, 0, 0, 0);
      const seenFiles = new Set();
      let paths;

      try {
        paths = await listFiles();
      } catch (error) {
        return { ok: false, error: error.message, models: [] };
      }

      let files = 0;

      for (const filePath of paths) {
        const info = await stat(filePath).catch(() => null);

        if (!info || info.mtimeMs < weekStart) {
          fileCache.delete(filePath);
          continue;
        }

        files += 1;
        seenFiles.add(filePath);
        let cached = fileCache.get(filePath);

        // new file, or a file that shrank (rotated/rewritten) — (re)parse fully
        if (!cached || cached.offset > info.size) {
          cached = { offset: 0, events: [], state: initState() };
          fileCache.set(filePath, cached);
        }

        try {
          await refreshFile(filePath, info, cached);
          cached.events = cached.events.filter((event) => event.t >= weekStart);
        } catch {
          fileCache.delete(filePath);
        }
      }

      for (const filePath of fileCache.keys()) {
        if (!seenFiles.has(filePath)) {
          fileCache.delete(filePath);
        }
      }

      const eventLists = [...fileCache.values()].map((cached) => cached.events);
      return { ok: true, files, models: aggregateUsageEvents(eventLists, { weekStart, todayStart, toUsage }) };
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

function formatCost(usage) {
  if (!usage.hasCost) {
    return usage.messages > 0 ? '?' : '$0.00';
  }

  return `$${usage.cost.toFixed(2)}`;
}

const DEFAULT_NOTE = '$ = estimated from public API prices; subscription usage is prepaid';

export function formatModelTable(models, { shorten = (model) => model, tone = () => 'white', note = DEFAULT_NOTE } = {}) {
  const rows = [];
  const header = [
    padVisible('model', 22),
    padStart('today out', 10),
    padStart('today $', 9),
    padStart('7d in', 9),
    padStart('7d out', 9),
    padStart('7d cache', 10),
    padStart('7d $', 9),
    padStart('msgs', 7),
  ].join(' ');
  rows.push(`  {white-fg}{underline}${escapeBlessed(header)}{/underline}{/white-fg}`);

  const totals = { todayOut: 0, todayCost: 0, weekIn: 0, weekOut: 0, weekCache: 0, weekCost: 0, messages: 0 };

  for (const entry of models) {
    const line = [
      padVisible(shorten(entry.model), 22),
      padStart(formatTokens(entry.today.output), 10),
      padStart(formatCost(entry.today), 9),
      padStart(formatTokens(entry.week.input), 9),
      padStart(formatTokens(entry.week.output), 9),
      padStart(formatTokens(entry.week.cacheRead + entry.week.cacheWrite), 10),
      padStart(formatCost(entry.week), 9),
      padStart(String(entry.week.messages), 7),
    ].join(' ');
    const rowTone = tone(entry.model);
    rows.push(`  {${rowTone}-fg}${escapeBlessed(line)}{/${rowTone}-fg}`);

    totals.todayOut += entry.today.output;
    totals.todayCost += entry.today.cost;
    totals.weekIn += entry.week.input;
    totals.weekOut += entry.week.output;
    totals.weekCache += entry.week.cacheRead + entry.week.cacheWrite;
    totals.weekCost += entry.week.cost;
    totals.messages += entry.week.messages;
  }

  const totalLine = [
    padVisible('total', 22),
    padStart(formatTokens(totals.todayOut), 10),
    padStart(`$${totals.todayCost.toFixed(2)}`, 9),
    padStart(formatTokens(totals.weekIn), 9),
    padStart(formatTokens(totals.weekOut), 9),
    padStart(formatTokens(totals.weekCache), 10),
    padStart(`$${totals.weekCost.toFixed(2)}`, 9),
    padStart(String(totals.messages), 7),
  ].join(' ');
  rows.push(`  {bold}${escapeBlessed(totalLine)}{/bold}`);

  if (note) {
    rows.push(`  {gray-fg}${escapeBlessed(note)}{/gray-fg}`);
  }

  return rows.join('\n');
}

// Full "Local usage by model" section for the detail view.
export function renderLocalUsage(local, { source = 'transcripts', ...tableOpts } = {}) {
  const fileCount = local.ok && Number.isFinite(local.files) ? ` | ${local.files} files` : '';
  const header = `{cyan-fg}{bold}Local usage by model{/bold}{/cyan-fg} {white-fg}(${escapeBlessed(source)}, last 7 days${fileCount}){/white-fg}`;
  const body = local.ok
    ? local.models.length > 0
      ? formatModelTable(local.models, tableOpts)
      : '  {white-fg}no usage recorded in the last 7 days{/white-fg}'
    : `  {red-fg}${escapeBlessed(local.error || 'scan failed')}{/red-fg}`;

  return `${header}\n${body}`;
}

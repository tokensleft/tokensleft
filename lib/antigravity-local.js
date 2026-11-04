import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createLocalUsageScanner } from './local-usage.js';
import { calculateModelCost } from './model-pricing.js';
import { loadNodeSqlite } from './runtime.js';

// Only decode protobuf framing and the accounting fields below. Prompt and
// response payloads remain opaque bytes and never leave the local process.
function varint(buffer, cursor) {
  let value = 0n;
  for (let shift = 0n; shift < 70n && cursor.pos < buffer.length; shift += 7n) {
    const byte = buffer[cursor.pos++];
    value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  throw new Error('Invalid agy protobuf varint');
}

function fields(buffer) {
  const result = new Map();
  const cursor = { pos: 0 };
  while (cursor.pos < buffer.length) {
    const tag = varint(buffer, cursor);
    if (!Number.isSafeInteger(tag) || tag < 8) throw new Error('Invalid agy protobuf tag');
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    let value;
    if (wire === 0) value = varint(buffer, cursor);
    else if (wire === 1 || wire === 5) cursor.pos += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const length = varint(buffer, cursor);
      if (!Number.isSafeInteger(length)) throw new Error('Invalid agy protobuf length');
      value = buffer.subarray(cursor.pos, cursor.pos + length);
      cursor.pos += length;
    } else throw new Error('Unsupported agy protobuf wire type');
    if (cursor.pos > buffer.length) throw new Error('Truncated agy protobuf record');
    if (value !== undefined) {
      if (!result.has(number)) result.set(number, []);
      result.get(number).push(value);
    }
  }
  return result;
}

const last = (record, number) => record.get(number)?.at(-1);
const nested = (record, number) => Buffer.isBuffer(last(record, number)) ? fields(last(record, number)) : new Map();
const text = (record, number) => Buffer.isBuffer(last(record, number)) ? last(record, number).toString('utf8') : '';
const count = (record, number) => {
  const value = last(record, number);
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid agy token count');
  return value;
};

function timestamp(record) {
  const seconds = last(record, 1);
  const nanos = last(record, 2) ?? 0;
  return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(nanos) && nanos >= 0 && nanos < 1e9
    ? seconds * 1000 + Math.floor(nanos / 1e6) : null;
}

export function antigravityUsageModel(config, displayName) {
  // Display names remove internal effort aliases such as flash-n / opus-high.
  const display = String(displayName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (/^(?:Gemini \d|Claude (?:Opus|Sonnet|Haiku) \d|GPT-)/i.test(display)) {
    const model = display.toLowerCase().replace(/\s+/g, '-');
    return model.startsWith('claude-') ? model.replace(/(\d)\.(\d)/g, '$1-$2') : model;
  }
  return String(config || '').trim().replace(/-(?:low|medium|high|xhigh|max|thinking)$/i, '') || 'unknown';
}

export function parseAntigravityGeneration(data, { sessionId, index, stepTimes }) {
  const generation = fields(Buffer.from(data));
  const model = nested(generation, 1);
  const usage = nested(model, 4);
  const input = count(usage, 2);
  // output_tokens already includes reasoning (fields 9 + 10).
  const output = last(usage, 3) === undefined ? count(usage, 9) + count(usage, 10) : count(usage, 3);
  const cacheWrite = count(usage, 4);
  const cacheRead = count(usage, 5);
  if (!(input || output || cacheRead || cacheWrite)) return null;
  let t = timestamp(nested(nested(model, 9), 4));
  for (const packed of generation.get(2) || []) {
    const cursor = { pos: 0 };
    const indices = [];
    if (Buffer.isBuffer(packed)) {
      while (cursor.pos < packed.length) indices.push(varint(packed, cursor));
    } else indices.push(packed);
    for (const idx of indices) {
      const candidate = stepTimes.get(idx);
      if (Number.isFinite(candidate)) t = t === null ? candidate : Math.min(t, candidate);
    }
  }
  if (!Number.isFinite(t)) throw new Error('agy generation has token usage without a recorded timestamp');
  const responseId = text(generation, 4);
  return {
    id: `agy:${responseId || `${sessionId}:${index}`}`,
    t,
    model: antigravityUsageModel(text(model, 19), text(model, 21)),
    input, output, cacheRead, cacheWrite,
  };
}

export async function readAntigravityUsageEvents(path) {
  const sqlite = await loadNodeSqlite();
  if (!sqlite) throw new Error('agy local usage requires Node.js 22.13+ with node:sqlite');
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    // One read transaction keeps the generation and step tables consistent.
    db.exec('BEGIN');
    const stepTimes = new Map();
    for (const row of db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL').iterate()) {
      const t = timestamp(nested(fields(Buffer.from(row.metadata)), 1));
      if (t !== null) stepTimes.set(row.idx, t);
    }
    const hasTrajectory = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'trajectory_meta'").get();
    const sessionId = (hasTrajectory ? db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get()?.trajectory_id : '') || basename(path, '.db');
    const events = [];
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx').iterate()) {
      const event = parseAntigravityGeneration(row.data, { sessionId, index: row.idx, stepTimes });
      if (event) events.push(event);
    }
    return events;
  } finally { db.close(); }
}

export function createAntigravityUsageScanner(cliHome) {
  return createLocalUsageScanner({
    async listFiles() {
      const conversations = join(cliHome, 'conversations');
      const entries = await readdir(conversations, { recursive: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const implicit = join(cliHome, 'implicit');
      const extra = await readdir(implicit, { recursive: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return [...entries.filter((p) => p.endsWith('.db')).map((p) => join(conversations, p)),
        ...extra.filter((p) => p.endsWith('.db')).map((p) => join(implicit, p))];
    },
    async refreshFile(path, info, cached) {
      const wal = await stat(`${path}-wal`).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const signature = [info.size, info.mtimeMs, wal?.size, wal?.mtimeMs].join(':');
      if (cached.state === signature) return;
      cached.events = await readAntigravityUsageEvents(path);
      cached.state = signature;
      // Leave offset at zero: SQLite files can change without growing, and
      // a live WAL can change while the main database stays untouched.
    },
    toUsage(event) {
      return { ...event, cost: calculateModelCost(event.model, event, { exact: true }) };
    },
  });
}

export const ANTIGRAVITY_LOCAL_OPTS = {
  source: 'agy SQLite sessions',
  note: 'all local accounts; SQLite sessions only; $ estimates API cost, not subscription billing',
  tone: (model) => model.startsWith('claude-') ? 'magenta' : 'white',
};

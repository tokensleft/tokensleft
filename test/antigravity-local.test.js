import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ANTIGRAVITY_LOCAL_OPTS, antigravityUsageModel, createAntigravityUsageScanner, parseAntigravityGeneration } from '../lib/antigravity-local.js';
import { calculateModelCost } from '../lib/model-pricing.js';
import { stripBlessedTags } from '../lib/format.js';
import { renderSingleAccount } from '../lib/provider-render.js';
import { loadNodeSqlite } from '../lib/runtime.js';

const sqlite = await loadNodeSqlite();
const sqliteTest = (name, run) => test(name, { skip: !sqlite }, run);
const NOW = Date.parse('2026-11-05T04:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function varint(number) {
  let value = BigInt(number);
  const bytes = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function field(number, value) {
  if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const proto = (...parts) => Buffer.concat(parts);
const timeMetadata = (time) => field(1, proto(field(1, Math.floor(time / 1000)), field(2, (time % 1000) * 1e6)));
function generation({ id = 'response-1', input = 1000, output = 70, cacheRead = 500, cacheWrite = 50, thinking = 20, steps = [1], config = 'gemini-3.8-flash-n', display = 'Gemini 3.8 Flash (High)' } = {}) {
  return proto(
    field(1, proto(
      field(4, proto(field(2, input), field(3, output), field(4, cacheWrite), field(5, cacheRead), field(9, thinking), field(10, output - thinking))),
      field(19, config), field(21, display),
    )),
    field(2, proto(...steps.map(varint))),
    ...(id ? [field(4, id)] : []),
  );
}

test('agy generation accounting excludes cache from input and includes thinking only once', () => {
  const event = parseAntigravityGeneration(generation(), { sessionId: 'session', index: 0, stepTimes: new Map([[1, NOW]]) });
  assert.deepEqual(event, { id: 'agy:response-1', t: NOW, model: 'gemini-3.8-flash', input: 1000, output: 70, cacheRead: 500, cacheWrite: 50 });
  const multipleSteps = parseAntigravityGeneration(generation({ steps: [3, 130], id: '' }), { sessionId: 'session', index: 4, stepTimes: new Map([[3, NOW], [130, NOW + 1000]]) });
  assert.equal(multipleSteps.t, NOW);
  assert.equal(multipleSteps.id, 'agy:session:4');
  assert.equal(parseAntigravityGeneration(generation({ input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 }), { stepTimes: new Map() }), null);
  assert.throws(() => parseAntigravityGeneration(generation(), { stepTimes: new Map() }), /timestamp/);
  assert.throws(() => parseAntigravityGeneration(Buffer.from([10, 127, 1]), { stepTimes: new Map() }), /Truncated/);
  assert.throws(() => parseAntigravityGeneration(Buffer.from([128]), { stepTimes: new Map() }), /varint/);
});

test('agy model aliases keep versions distinct and do not inherit a different version price', () => {
  assert.equal(antigravityUsageModel('claude-opus-5-5-high', 'Claude Opus 5.5 (High)'), 'claude-opus-5-5');
  assert.equal(antigravityUsageModel('gemini-3.8-flash-n', 'Gemini 3.8 Flash (High)'), 'gemini-3.8-flash');
  const entries = { 'claude-opus-5': { input: 5, output: 25 }, 'gemini-3.8-flash': { input: 1, output: 2 } };
  assert.equal(calculateModelCost('claude-opus-5-5', { input: 1000 }, { entries, exact: true }), null);
  assert.equal(calculateModelCost('gemini-3.8-flash', { input: 1000 }, { entries, exact: true }), 0.001);
});

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'tokensleft-agy-local-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  await mkdir(join(home, 'conversations'));
  return home;
}
function database(path) {
  const db = new sqlite.DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  return db;
}
function insert(db, index, time, options = {}) {
  // Step metadata mirrors the same usage record. Only gen_metadata is counted.
  db.prepare('INSERT OR REPLACE INTO steps VALUES (?, ?)').run(index, proto(timeMetadata(time), field(9, proto(field(2, 999999)))));
  db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)').run(index, generation({ id: `response-${index}`, steps: [index], ...options }));
}

sqliteTest('agy detail table buckets real database generations and dedupes copied conversations', async (t) => {
  const home = await tempHome(t);
  const path = join(home, 'conversations', 'session.db');
  const db = database(path);
  insert(db, 1, NOW);
  insert(db, 2, NOW - 2 * DAY);
  insert(db, 3, NOW - 10 * DAY);
  insert(db, 4, NOW - 40 * DAY);
  db.close();
  await copyFile(path, join(home, 'conversations', 'copy.db'));
  await writeFile(join(home, 'conversations', 'old.pb'), 'opaque encrypted legacy format');
  const scanner = createAntigravityUsageScanner(home);
  const local = await scanner.scan(NOW);
  assert.equal(local.files, 2);
  assert.equal(local.partial, false);
  const model = local.models[0];
  assert.equal(model.today.messages, 1);
  assert.equal(model.week.messages, 2);
  assert.equal(model.month.messages, 3);
  assert.equal(model.all.messages, 4);
  assert.equal(model.all.input, 4000);
  assert.equal(model.all.cacheRead, 2000);
  assert.equal(model.all.cacheWrite, 200);
  assert.equal(model.all.output, 280);
  assert.equal(model.all.hasCost, true);
  const snapshot = { ok: true, plan: 'Google AI Ultra', ms: 1, items: [], local };
  const detail = stripBlessedTags(renderSingleAccount(snapshot, 120, 'detail', 'antigravity', ANTIGRAVITY_LOCAL_OPTS));
  assert.match(detail, /Local usage by model[\s\S]*gemini-3.8-flash[\s\S]*today[\s\S]*7d[\s\S]*30d[\s\S]*all/);
  assert.match(detail, /all local accounts/);
  assert.doesNotMatch(renderSingleAccount(snapshot, 120, 'compact', 'antigravity', ANTIGRAVITY_LOCAL_OPTS), /Local usage by model/);
  await rm(path);
  await rm(join(home, 'conversations', 'copy.db'));
  assert.equal((await scanner.scan(NOW)).models.length, 0);
});

sqliteTest('agy scanner detects live WAL changes even when the main database stays unchanged', async (t) => {
  const home = await tempHome(t);
  const path = join(home, 'conversations', 'live.db');
  const db = database(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    insert(db, 1, NOW, { input: 100 });
    const scanner = createAntigravityUsageScanner(home);
    assert.equal((await scanner.scan(NOW)).models[0].all.input, 100);
    const before = await stat(path);
    insert(db, 1, NOW, { input: 200 });
    const after = await stat(path);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
    assert.equal((await scanner.scan(NOW)).models[0].all.input, 200);
  } finally { db.close(); }
});

sqliteTest('agy scanner preserves last good local usage when a database becomes unreadable', async (t) => {
  const home = await tempHome(t);
  const path = join(home, 'conversations', 'session.db');
  const db = database(path);
  insert(db, 1, NOW);
  db.close();
  const scanner = createAntigravityUsageScanner(home);
  await scanner.scan(NOW);
  await writeFile(path, 'corrupt database');
  const local = await scanner.scan(NOW);
  assert.equal(local.partial, true);
  assert.equal(local.failedFiles.length, 1);
  assert.equal(local.models[0].all.input, 1000);
});

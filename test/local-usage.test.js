import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { aggregateUsageEvents, formatModelTable, renderLocalUsage } from '../lib/local-usage.js';
import { renderClaudeSnapshot } from '../providers/claude.js';
import { CODEX_LOCAL_OPTS, createRolloutScanner, parseRolloutChunk, renderSingleAccount } from '../providers/codex.js';
import { createChatScanner, parseChatJsonlChunk, parseChatMessages } from '../providers/gemini.js';
import { loadLocalModels } from '../providers/opencode.js';
import { stripBlessedTags } from '../lib/format.js';

// --- shared aggregation -------------------------------------------------------

test('aggregateUsageEvents buckets today/7d/30d/all per model and dedupes by id', () => {
  const now = Date.now();
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const events = [
    { t: todayStart + 1000, id: 'a', model: 'm1', input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.5 },
    { t: todayStart + 1000, id: 'a', model: 'm1', input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.5 },
    { t: todayStart - 1000, id: 'b', model: 'm1', input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null },
    { t: now - 8 * dayMs, id: 'c', model: 'm1', input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cost: 9 },
    { t: now - 45 * dayMs, id: 'd', model: 'm1', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 90 },
  ];
  const models = aggregateUsageEvents([events], { now });
  assert.equal(models.length, 1);
  assert.equal(models[0].week.messages, 2); // duplicate id and out-of-window dropped
  assert.equal(models[0].week.input, 11);
  assert.equal(models[0].today.output, 20);
  assert.equal(models[0].week.cost, 0.5); // null cost accumulates nothing
  assert.equal(models[0].week.hasCost, true);
  assert.equal(models[0].month.messages, 3); // 8-day-old event joins the 30d window
  assert.equal(models[0].month.cost, 9.5);
  assert.equal(models[0].all.messages, 4); // 45-day-old event counts all-time only
  assert.equal(models[0].all.cost, 99.5);
});

function windowsOf(usage) {
  return { today: usage, week: usage, month: usage, all: usage };
}

test('formatModelTable shows ? for models without pricing', () => {
  const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, messages: 3, cost: 0, hasCost: false };
  const table = stripBlessedTags(formatModelTable([{ model: 'mystery-model', ...windowsOf(usage) }]));
  assert.match(table, /mystery-model/);
  assert.match(table, / \? /);
});

test('local usage tables render in detail mode only', () => {
  const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, messages: 1, cost: 0.1, hasCost: true };
  const local = { ok: true, files: 1, models: [{ model: 'gpt-5.6-sol', ...windowsOf(usage) }] };
  const snapshot = { ok: true, ms: 1, plan: 'plus', items: [], local };
  assert.match(renderSingleAccount(snapshot, 100, 'detail', 'codex', CODEX_LOCAL_OPTS), /Local usage by model/);
  assert.doesNotMatch(renderSingleAccount(snapshot, 100, 'compact', 'codex', CODEX_LOCAL_OPTS), /Local usage by model/);
  const compactHeader = stripBlessedTags(renderSingleAccount(snapshot, 100, 'compact', 'codex', CODEX_LOCAL_OPTS));
  assert.match(compactHeader, /^  OK  plus$/);
  assert.ok(!compactHeader.includes('codex'), 'the section title already identifies a single-account provider');

  // local data stays useful in detail view even when the quota fetch failed
  const failed = { ok: false, status: 401, error: 'expired', items: [], local };
  assert.match(renderSingleAccount(failed, 100, 'detail', 'codex', CODEX_LOCAL_OPTS), /Local usage by model/);

  const claudeSnapshot = { results: [], local };
  assert.match(renderClaudeSnapshot(claudeSnapshot, 100, 'detail'), /Local usage by model/);
  assert.doesNotMatch(renderClaudeSnapshot(claudeSnapshot, 100, 'compact'), /Local usage by model/);
});

test('renderLocalUsage reports scan errors and empty windows', () => {
  const failed = stripBlessedTags(renderLocalUsage({ ok: false, error: 'no session logs at /x', models: [] }));
  assert.match(failed, /no session logs at \/x/);

  const empty = stripBlessedTags(renderLocalUsage({ ok: true, files: 2, models: [] }, { source: 'sessions' }));
  assert.match(empty, /sessions, today \/ 7d \/ 30d \/ all time \| 2 files/);
  assert.match(empty, /no local usage recorded/);
});

// --- codex rollout parsing ------------------------------------------------------

function rolloutTokenCount({ t, total, last }) {
  const usage = (u) => ({
    input_tokens: u.input,
    cached_input_tokens: u.cached,
    output_tokens: u.output,
    reasoning_output_tokens: 0,
    total_tokens: u.input + u.output,
  });

  return `${JSON.stringify({
    timestamp: new Date(t).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last) } },
  })}\n`;
}

function rolloutTurnContext(model, t = Date.now()) {
  return `${JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'turn_context', payload: { model } })}\n`;
}

test('parseRolloutChunk diffs cumulative totals so repeated events count once', () => {
  const state = rolloutState();
  const t = Date.now();
  const text =
    rolloutTurnContext('gpt-5.5', t) +
    rolloutTokenCount({ t, total: { input: 100, cached: 60, output: 10 }, last: { input: 100, cached: 60, output: 10 } }) +
    rolloutTokenCount({ t, total: { input: 100, cached: 60, output: 10 }, last: { input: 100, cached: 60, output: 10 } }) + // duplicate
    rolloutTokenCount({ t, total: { input: 300, cached: 200, output: 25 }, last: { input: 200, cached: 140, output: 15 } });
  const { events, remainder } = parseRolloutChunk(text, state);
  assert.equal(remainder, '');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.input), [100, 200]);
  assert.deepEqual(events.map((event) => event.cached), [60, 140]);
  assert.deepEqual(events.map((event) => event.output), [10, 15]);
  assert.ok(events.every((event) => event.model === 'gpt-5.5'));
});

function rolloutState() {
  return { model: null, firstModel: null, prevTotals: null, replay: false, burstSec: null, pending: null };
}

function rolloutSessionMeta({ forked = false } = {}) {
  const payload = { session_id: 's1', ...(forked ? { forked_from_id: 'parent' } : {}) };
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload })}\n`;
}

test('parseRolloutChunk baselines the first event at totals minus last', () => {
  const state = rolloutState();
  const t = Date.now();
  // the first event's totals may include history this file did not record
  const text = rolloutTokenCount({ t, total: { input: 1_000_000, cached: 900_000, output: 50_000 }, last: { input: 2000, cached: 1500, output: 100 } });
  const { events } = parseRolloutChunk(text, state);
  assert.equal(events.length, 1);
  assert.equal(events[0].input, 2000);
  assert.equal(events[0].cached, 1500);
  assert.equal(events[0].output, 100);
});

test('parseRolloutChunk skips a forked session replay burst, counting only live usage', () => {
  const state = rolloutState();
  const burstT = Date.parse('2026-07-10T10:02:55.028Z');
  // the parent's history is replayed as a same-second burst of growing totals
  const text =
    rolloutSessionMeta({ forked: true }) +
    rolloutTurnContext('gpt-5.5', burstT) +
    rolloutTokenCount({ t: burstT, total: { input: 100, cached: 50, output: 10 }, last: { input: 100, cached: 50, output: 10 } }) +
    rolloutTokenCount({ t: burstT + 5, total: { input: 300, cached: 200, output: 30 }, last: { input: 200, cached: 150, output: 20 } }) +
    rolloutTokenCount({ t: burstT + 9, total: { input: 900, cached: 700, output: 90 }, last: { input: 600, cached: 500, output: 60 } }) +
    // real usage arrives minutes later
    rolloutTokenCount({ t: burstT + 120_000, total: { input: 1150, cached: 900, output: 115 }, last: { input: 250, cached: 200, output: 25 } });
  const { events } = parseRolloutChunk(text, state);
  assert.equal(events.length, 1);
  assert.equal(events[0].input, 250);
  assert.equal(events[0].cached, 200);
  assert.equal(events[0].output, 25);
});

test('parseRolloutChunk keeps the first event of a forked file that has no replay burst', () => {
  const state = rolloutState();
  const t0 = Date.parse('2026-07-10T10:02:55.028Z');
  const text =
    rolloutSessionMeta({ forked: true }) +
    rolloutTokenCount({ t: t0, total: { input: 100, cached: 50, output: 10 }, last: { input: 100, cached: 50, output: 10 } }) +
    rolloutTokenCount({ t: t0 + 30_000, total: { input: 300, cached: 200, output: 30 }, last: { input: 200, cached: 150, output: 20 } });
  const { events } = parseRolloutChunk(text, state);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.input), [100, 200]);
  assert.deepEqual(events.map((event) => event.output), [10, 20]);
});

test('parseRolloutChunk keeps partial trailing lines as remainder', () => {
  const state = rolloutState();
  const partial = '{"type":"event_msg","payload":{"type":"token_count"';
  const { events, remainder } = parseRolloutChunk(partial, state);
  assert.equal(events.length, 0);
  assert.equal(remainder, partial);
});

test('rollout scanner attributes pre-turn_context events to the first model and prices usage', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'tokensleft-codex-'));
  after(() => rm(codexHome, { recursive: true, force: true }));

  const dayDir = join(codexHome, 'sessions', '2026', '07', '12');
  await mkdir(dayDir, { recursive: true });
  const filePath = join(dayDir, 'rollout-test.jsonl');
  const now = Date.now();

  // token_count arrives before the first turn_context (forked session replay)
  await writeFile(
    filePath,
    rolloutTokenCount({ t: now - 2000, total: { input: 500, cached: 400, output: 50 }, last: { input: 500, cached: 400, output: 50 } }) +
    rolloutTurnContext('gpt-5.5', now - 1500),
  );

  const scanner = createRolloutScanner(codexHome);
  let result = await scanner.scan(now);
  assert.equal(result.ok, true);
  assert.equal(result.files, 1);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, 'gpt-5.5');
  assert.equal(result.models[0].week.input, 100); // 500 minus 400 cached
  assert.equal(result.models[0].week.cacheRead, 400);
  assert.ok(result.models[0].week.hasCost);
  assert.ok(result.models[0].week.cost > 0);

  // incremental append only parses the tail
  await appendFile(filePath, rolloutTokenCount({ t: now, total: { input: 800, cached: 600, output: 80 }, last: { input: 300, cached: 200, output: 30 } }));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
  assert.equal(result.models[0].week.output, 80);

  // unchanged file: stable aggregation
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
});

test('rollout scanner reports missing sessions dir', async () => {
  const scanner = createRolloutScanner(join(tmpdir(), 'tokensleft-codex-missing'));
  const result = await scanner.scan();
  assert.equal(result.ok, false);
  assert.match(result.error, /no session logs/);
});

// --- gemini chat parsing -------------------------------------------------------

function chatSession({ id, t, tokens, model = 'gemini-3.1-pro-preview' }) {
  return {
    sessionId: 's1',
    messages: [
      { id: 'u1', timestamp: new Date(t).toISOString(), type: 'user', content: 'hi' },
      { id, timestamp: new Date(t).toISOString(), type: 'gemini', model, content: 'hello', tokens },
    ],
  };
}

test('parseChatMessages keeps only model responses with token counts', () => {
  const t = Date.now();
  const data = chatSession({ id: 'g1', t, tokens: { input: 9461, output: 72, cached: 5626, thoughts: 695, tool: 0, total: 10228 } });
  data.messages.push({ id: 'g2', timestamp: new Date(t).toISOString(), type: 'gemini', model: 'gemini-3.1-pro-preview', content: 'no tokens recorded' });
  const events = parseChatMessages(data);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'g1');
  assert.equal(events[0].input, 9461);
  assert.equal(events[0].cached, 5626);
  assert.equal(events[0].thoughts, 695);
});

test('chat scanner re-parses rewritten session files and dedupes messages across files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-gemini-'));
  after(() => rm(dir, { recursive: true, force: true }));

  const chatsDir = join(dir, 'tmp', 'proj', 'chats');
  await mkdir(chatsDir, { recursive: true });
  const filePath = join(chatsDir, 'session-1.json');
  const now = Date.now();
  const tokens = { input: 1000, output: 100, cached: 400, thoughts: 50, tool: 0, total: 1150 };

  const data = chatSession({ id: 'g1', t: now - 1000, tokens });
  await writeFile(filePath, JSON.stringify(data, null, 2));

  const scanner = createChatScanner(dir);
  let result = await scanner.scan(now);
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].week.input, 600); // 1000 minus 400 cached
  assert.equal(result.models[0].week.output, 150); // output plus thoughts
  assert.equal(result.models[0].week.cacheRead, 400);
  assert.ok(result.models[0].week.cost > 0);

  // the session file is rewritten in place as the conversation grows
  data.messages.push({ id: 'g2', timestamp: new Date(now).toISOString(), type: 'gemini', model: 'gemini-3.1-pro-preview', content: 'x', tokens });
  await writeFile(filePath, JSON.stringify(data, null, 2));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);

  // a /chat save copy of the same session must not double count
  await writeFile(join(chatsDir, 'saved-copy.json'), JSON.stringify(data, null, 2));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
});

test('parseChatJsonlChunk merges repeated message ids last-wins', () => {
  const state = { byId: new Map(), seq: 0 };
  const t = new Date().toISOString();
  const message = (tokens) => JSON.stringify({ id: 'g1', timestamp: t, type: 'gemini', model: 'gemini-3.1-pro-preview', tokens });
  const text = [
    JSON.stringify({ sessionId: 's1', projectHash: 'h' }), // metadata line
    message({ input: 100, output: 1, cached: 0, thoughts: 0, tool: 0 }),
    message({ input: 100, output: 10, cached: 40, thoughts: 5, tool: 0 }), // update wins
    JSON.stringify({ $set: { lastUpdated: t } }),
  ].join('\n') + '\n';
  const { events, remainder } = parseChatJsonlChunk(text, state);
  assert.equal(events.length, 0); // events live in state.byId
  assert.equal(remainder, '');
  assert.equal(state.byId.size, 1);
  assert.equal(state.byId.get('g1').output, 10);
  assert.equal(state.byId.get('g1').cached, 40);
});

test('chat scanner reads jsonl sessions incrementally, including nested subagent files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-gemini-jsonl-'));
  after(() => rm(dir, { recursive: true, force: true }));

  const chatsDir = join(dir, 'tmp', 'proj', 'chats');
  const subDir = join(chatsDir, 'session-parent');
  await mkdir(subDir, { recursive: true });
  const now = Date.now();
  const line = (id, output) => `${JSON.stringify({ id, timestamp: new Date(now).toISOString(), type: 'gemini', model: 'gemini-3.1-pro-preview', tokens: { input: 100, output, cached: 0, thoughts: 0, tool: 0 } })}\n`;

  const filePath = join(chatsDir, 'session-1.jsonl');
  await writeFile(filePath, `${JSON.stringify({ sessionId: 's1' })}\n` + line('g1', 10));
  await writeFile(join(subDir, 'subagent.jsonl'), line('sub1', 7));

  const scanner = createChatScanner(dir);
  let result = await scanner.scan(now);
  assert.equal(result.files, 2);
  assert.equal(result.models[0].week.messages, 2);
  assert.equal(result.models[0].week.output, 17);

  // append: an update for g1 (last-wins) plus a new message
  await appendFile(filePath, line('g1', 20) + line('g2', 5));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 3);
  assert.equal(result.models[0].week.output, 32); // 20 + 5 + 7
});

// --- opencode db aggregation ------------------------------------------------------

test('loadLocalModels aggregates assistant messages per provider/model with recorded cost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokensleft-opencode-'));
  after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, 'opencode.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  const assistant = (tokens, cost) => JSON.stringify({ role: 'assistant', providerID: 'opencode-go', modelID: 'claude-sonnet-5', cost, tokens });
  insert.run('m1', 's1', now - 1000, now, assistant({ input: 100, output: 50, reasoning: 25, cache: { read: 500, write: 40 } }, 0.02));
  insert.run('m2', 's1', now - 2000, now, assistant({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0.001));
  insert.run('m3', 's1', now - 3000, now, JSON.stringify({ role: 'user' })); // ignored
  insert.run('m4', 's1', now - 10 * 24 * 60 * 60 * 1000, now, assistant({ input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } }, 9)); // outside 7d
  db.close();

  const local = await loadLocalModels(dbPath, now);
  assert.equal(local.ok, true);
  assert.equal(local.models.length, 1);
  assert.equal(local.models[0].model, 'opencode-go/claude-sonnet-5');
  assert.equal(local.models[0].week.messages, 2);
  assert.equal(local.models[0].week.input, 110);
  assert.equal(local.models[0].week.output, 80); // reasoning folds into output
  assert.equal(local.models[0].week.cacheRead, 500);
  assert.equal(local.models[0].week.cacheWrite, 40);
  assert.ok(Math.abs(local.models[0].week.cost - 0.021) < 1e-9);
  assert.equal(local.models[0].month.messages, 3); // 10-day-old message joins 30d and all
  assert.ok(Math.abs(local.models[0].all.cost - 9.021) < 1e-9);
});

import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  buildClaudeLimitItems,
  createTranscriptScanner,
  parseTranscriptChunk,
  renderClaudeSnapshot,
  resolveRetryAfterAt,
} from '../providers/claude.js';
import { stripBlessedTags } from '../lib/format.js';

const SAMPLE_USAGE = {
  five_hour: { utilization: 3, resets_at: '2026-07-03T12:10:00Z' },
  seven_day: { utilization: 17, resets_at: '2026-07-07T19:00:00Z' },
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: '2026-07-03T12:10:00Z', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 17, severity: 'normal', resets_at: '2026-07-07T19:00:00Z', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 33, severity: 'warning', resets_at: '2026-07-07T19:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  spend: { enabled: false },
};

test('buildClaudeLimitItems maps limits[] including model-scoped (Fable)', () => {
  const items = buildClaudeLimitItems(SAMPLE_USAGE, { prefix: 'sys' });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly all', 'Wk Fable']);
  assert.equal(items[0].active, true);
  assert.equal(items[2].percent, 33);
  assert.equal(items[2].severity, 'warning');
  assert.ok(items.every((item) => item.key.startsWith('sys:')));
});

test('buildClaudeLimitItems falls back to five_hour/seven_day', () => {
  const items = buildClaudeLimitItems({ five_hour: SAMPLE_USAGE.five_hour, seven_day: SAMPLE_USAGE.seven_day }, { prefix: 'sys' });
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly all']);
});

test('429 retry time honors the server delay with a ten-minute minimum backoff', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  assert.equal(resolveRetryAfterAt('0', { now }).getTime(), now + 10 * 60 * 1000);
  assert.equal(resolveRetryAfterAt(null, { now }).getTime(), now + 10 * 60 * 1000);
  assert.equal(resolveRetryAfterAt('3600', { now }).getTime(), now + 60 * 60 * 1000);
});

test('429 UI shows a countdown instead of a misleading time-of-day', () => {
  const now = Date.parse('2026-07-14T06:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;

  try {
    const retryAfterAt = new Date(now + 24 * 60 * 60 * 1000);
    const result = {
      name: 'personal',
      ok: false,
      status: 429,
      error: 'HTTP 429',
      plan: 'max',
      ms: 10,
      retryAfterAt,
      items: [],
    };
    const compact = stripBlessedTags(renderClaudeSnapshot({ results: [result] }, 100, 'compact'));
    const detail = stripBlessedTags(renderClaudeSnapshot({
      results: [result],
      local: { ok: true, models: [] },
    }, 100, 'detail'));

    assert.match(compact, /retry in 1d/);
    assert.ok(!compact.includes('retry after'));
    assert.match(detail, /retry in 1d · at /);
  } finally {
    Date.now = realNow;
  }
});

function transcriptLine({ id, model = 'claude-fable-5', t, output = 100 }) {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(t).toISOString(),
    message: {
      id,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 200 },
      },
    },
  })}\n`;
}

test('parseTranscriptChunk parses complete lines and keeps the remainder', () => {
  const full = transcriptLine({ id: 'msg_1', t: Date.now() });
  const partial = '{"type":"assistant","message":{"usage"';
  const { events, remainder } = parseTranscriptChunk(full + partial);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'msg_1');
  assert.equal(events[0].cache5m, 50);
  assert.equal(events[0].cache1h, 200);
  assert.equal(remainder, partial);
});

test('parseTranscriptChunk skips non-assistant and synthetic models', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { usage: {}, model: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm', model: '<synthetic>', usage: { output_tokens: 5 } } }),
  ].join('\n') + '\n';
  assert.equal(parseTranscriptChunk(lines).events.length, 0);
});

test('transcript scanner aggregates incrementally and dedupes by message id', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'tokensleft-test-'));
  after(() => rm(configDir, { recursive: true, force: true }));

  const projectDir = join(configDir, 'projects', 'proj-a');
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, 'session.jsonl');
  const now = Date.now();

  await writeFile(filePath, transcriptLine({ id: 'msg_1', t: now - 1000 }) + transcriptLine({ id: 'msg_1', t: now - 1000 }));

  const scanner = createTranscriptScanner(configDir);
  let result = await scanner.scan(now);
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].week.messages, 1); // duplicate id counted once
  assert.equal(result.models[0].week.output, 100);
  assert.equal(result.models[0].week.cacheWrite, 250);
  assert.ok(result.models[0].week.cost > 0);

  // Append a new message — the incremental pass must pick up only the tail.
  await appendFile(filePath, transcriptLine({ id: 'msg_2', t: now, output: 900 }));
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
  assert.equal(result.models[0].week.output, 1000);

  // Unchanged file: aggregation is stable.
  result = await scanner.scan(now);
  assert.equal(result.models[0].week.messages, 2);
});

test('transcript scanner reports missing projects dir', async () => {
  const scanner = createTranscriptScanner(join(tmpdir(), 'tokensleft-definitely-missing'));
  const result = await scanner.scan();
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, []);
});

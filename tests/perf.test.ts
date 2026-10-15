import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { open, init } from '../src/db.js';
import { analyzeChanged, INSIGHTS_VERSION } from '../src/insights.js';
import { sessionShape } from '../src/session-status.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-test-perf-'));
const TEST_DB = path.join(TMP, 'test.db');

describe('startup insight scoring', () => {
  let db: Database.Database;

  before(() => {
    init(TEST_DB);
    db = open(TEST_DB);
    const add = db.prepare('INSERT INTO sessions (id, start_time, end_time, message_count, tool_count) VALUES (?, ?, ?, 0, 0)');
    for (const id of ['a', 'b', 'c']) add.run(id, '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const computedAt = (id: string): string | undefined =>
    (db.prepare('SELECT computed_at FROM session_insights WHERE session_id = ?').get(id) as { computed_at: string } | undefined)?.computed_at;

  it('scores every session when no insights version is stored', () => {
    assert.strictEqual(analyzeChanged(db, []), 3);
    const v = db.prepare("SELECT value FROM agentacta_meta WHERE key = 'insights_version'").get() as { value: string };
    assert.strictEqual(Number(v.value), INSIGHTS_VERSION);
  });

  it('then scores only changed sessions and ones never scored', () => {
    db.prepare("UPDATE session_insights SET computed_at = 'old'").run();
    db.prepare("DELETE FROM session_insights WHERE session_id = 'c'").run();
    assert.strictEqual(analyzeChanged(db, ['a']), 2);
    assert.notStrictEqual(computedAt('a'), 'old', 'changed session rescored');
    assert.strictEqual(computedAt('b'), 'old', 'unchanged session left alone');
    assert.ok(computedAt('c'), 'missing session scored');
    assert.strictEqual(analyzeChanged(db, []), 0);
  });
});

describe('session shape', () => {
  it('buckets events over the session and counts tool calls by name', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const events = Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date(start + i * 60_000).toISOString(),
      type: i % 2 ? 'tool_call' : 'message',
      tool_name: i % 2 ? (i % 4 === 1 ? 'Bash' : 'Read') : null,
    })).reverse(); // newest first, as the API returns them
    const shape = sessionShape({ start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:20:00Z' }, events);
    assert.ok(shape.activity);
    assert.strictEqual(shape.activity.counts.length, 20, 'one bucket a minute for a 20-minute session');
    assert.strictEqual(shape.activity.counts.reduce((a, b) => a + b, 0), 20);
    assert.deepStrictEqual(Object.fromEntries(shape.tools), { Bash: 5, Read: 5 });
  });

  it('has no activity chart for very short or sparse sessions', () => {
    const shape = sessionShape({ start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:00:30Z' }, [{ timestamp: '2026-01-01T00:00:10Z', type: 'message', tool_name: null }]);
    assert.strictEqual(shape.activity, null);
  });
});

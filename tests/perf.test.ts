import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { open, init } from '../src/db.js';
import { analyzeChanged, INSIGHTS_VERSION } from '../src/insights.js';
import { sessionShape } from '../src/session-status.js';
import { backfillAttribution, hasStoredAttribution } from '../src/attribution-store.js';
import { loadSessionEvents, loadOlderSessionEvents } from '../src/session-detail.js';
import { attributeSessionEvents } from '../src/project-attribution.js';
import type { EventRow, SessionRow } from '../src/types.js';

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

describe('stored project attribution', () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-test-attr-'));
  const DB = path.join(DIR, 'test.db');
  let db: Database.Database;

  before(() => {
    init(DB);
    db = open(DB);
    db.prepare("INSERT INTO sessions (id, start_time, end_time, message_count, tool_count, projects) VALUES ('s1', '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', 2, 4, ?)").run(JSON.stringify(['alpha', 'beta']));
    const ev = db.prepare('INSERT INTO events (id, session_id, timestamp, type, role, content, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const at = (m: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + m * 60_000).toISOString();
    ev.run('m1', 's1', at(1), 'message', 'user', 'work on alpha', null, null);
    ev.run('c1', 's1', at(2), 'tool_call', null, null, 'Read', JSON.stringify({ file_path: '/home/u/Developer/alpha/src/a.ts' }));
    ev.run('c1:result', 's1', at(3), 'tool_result', null, 'ok', 'Read', null);
    ev.run('c2', 's1', at(4), 'tool_call', null, null, 'Edit', JSON.stringify({ file_path: '/home/u/Developer/beta/b.ts' }));
    ev.run('m2', 's1', at(5), 'message', 'assistant', 'done', null, null);
  });

  after(() => {
    db.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  const slowPath = () => {
    const s = db.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as SessionRow;
    const all = db.prepare("SELECT * FROM events WHERE session_id = 's1' ORDER BY timestamp DESC, id DESC").all() as EventRow[];
    const a = attributeSessionEvents(s, all);
    return { events: a.events, eventTotal: all.length, shape: sessionShape(s, all), projectFilters: a.projectFilters };
  };

  it('falls back to attributing on read until attribution is stored', () => {
    const s = db.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as SessionRow;
    assert.strictEqual(hasStoredAttribution(db, 's1'), false);
    assert.deepStrictEqual(loadSessionEvents(db, s, 0), slowPath());
  });

  it('serves the same events, filters and shape from stored attribution', () => {
    assert.strictEqual(backfillAttribution(db), 1);
    assert.strictEqual(hasStoredAttribution(db, 's1'), true);
    const s = db.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as SessionRow;
    const expected = slowPath();
    assert.ok(expected.projectFilters.length >= 1, 'fixture attributes some events');
    assert.deepStrictEqual(loadSessionEvents(db, s, 0), expected);
    assert.deepStrictEqual(loadSessionEvents(db, s, 2).events, expected.events.slice(0, 2));
    const older = loadOlderSessionEvents(db, s, { timestamp: expected.events[1].timestamp, id: expected.events[1].id }, 10);
    assert.deepStrictEqual(older, expected.events.slice(2));
    assert.strictEqual(backfillAttribution(db), 0, 'nothing left to backfill');
  });

  it('drops stored attribution when the session is replaced', () => {
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    assert.strictEqual(hasStoredAttribution(db, 's1'), false);
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS c FROM event_attr WHERE session_id = 's1'").get() as { c: number }).c, 0);
  });
});

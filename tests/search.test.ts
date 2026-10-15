import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { open, init } from '../src/db.js';
import { quickSearch, toPrefixFtsQuery } from '../src/search.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-test-search-'));
const DB = path.join(TMP, 'test.db');

describe('quick search', () => {
  let db: Database.Database;

  before(() => {
    init(DB);
    db = open(DB);
    const s = db.prepare('INSERT INTO sessions (id, start_time, end_time, summary, label, agent) VALUES (?, ?, ?, ?, ?, ?)');
    s.run('old-1', '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', 'Migrate the billing exporter', null, 'claude-code');
    for (let i = 0; i < 30; i++) s.run(`new-${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, null, `Routine task ${i}`, null, 'codex');
    const e = db.prepare('INSERT INTO events (id, session_id, timestamp, type, role, content) VALUES (?, ?, ?, ?, ?, ?)');
    e.run('e1', 'old-1', '2025-01-01T00:10:00Z', 'message', 'user', 'the sqlite index was rebuilt overnight');
    e.run('e2', 'new-3', '2026-01-04T00:10:00Z', 'message', 'assistant', 'nothing relevant here');
    const f = db.prepare('INSERT INTO file_activity (session_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 40; i++) f.run('new-1', `/home/u/Developer/busy/file${i}.ts`, 'read', '2026-01-02T00:00:00Z');
    f.run('old-1', '/home/u/Developer/rare-project/exporter.ts', 'edit', '2025-01-01T00:20:00Z');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('finds a session by title however old it is', () => {
    assert.deepStrictEqual(quickSearch(db, 'billing').sessions.map(s => s.id), ['old-1']);
  });

  it('finds files by any part of the path, not only the most-touched', () => {
    assert.deepStrictEqual(quickSearch(db, 'rare-project').files.map(f => f.file_path), ['/home/u/Developer/rare-project/exporter.ts']);
  });

  it('matches an unfinished last word and marks it in the snippet', () => {
    const r = quickSearch(db, 'sqli');
    assert.deepStrictEqual(r.events.map(e => e.id), ['e1']);
    assert.match(r.events[0].snippet, /\u0002sqlite\u0003/);
  });

  it('treats LIKE wildcards in the query literally', () => {
    assert.strictEqual(quickSearch(db, '%').sessions.length, 0);
  });

  it('builds prefix queries only for a finished-looking last word', () => {
    assert.strictEqual(toPrefixFtsQuery('sqlite ind'), '"sqlite" AND "ind"*');
    assert.strictEqual(toPrefixFtsQuery('sqlite '), '"sqlite"');
    assert.strictEqual(toPrefixFtsQuery('sqlite in'), '"sqlite" AND "in"', 'two letters match exactly');
  });

  it('keeps the full-text index in step when an event is replaced', () => {
    db.prepare("INSERT OR REPLACE INTO events (id, session_id, timestamp, type, role, content) VALUES ('e1', 'old-1', '2025-01-01T00:10:00Z', 'message', 'user', 'completely different words')").run();
    assert.doesNotThrow(() => db.prepare("INSERT INTO events_fts(events_fts, rank) VALUES('integrity-check', 1)").run());
    assert.strictEqual(quickSearch(db, 'sqlite').events.length, 0, 'the old text no longer matches');
    assert.strictEqual(quickSearch(db, 'completely').events.length, 1);
  });
});

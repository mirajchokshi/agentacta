import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { open, init, createStmts } from '../src/db.js';
import type { PreparedStatements, CountRow } from '../src/types.js';
import type Database from 'better-sqlite3';

const TEST_DB = path.join(os.tmpdir(), `agentacta-test-db-${Date.now()}.db`);

describe('db', () => {
  after(() => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('init creates all tables', () => {
    process.env.AGENTACTA_DB_PATH = TEST_DB;
    init(TEST_DB);
    const db: Database.Database = open(TEST_DB);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('events'));
    assert.ok(tables.includes('index_state'));
    assert.ok(tables.includes('file_activity'));
    assert.ok(tables.includes('archive'));
    assert.ok(tables.includes('events_fts'));
    db.close();
  });

  it('init is idempotent', () => {
    init(TEST_DB);
    init(TEST_DB);
    const db: Database.Database = open(TEST_DB);
    const count = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as CountRow).c;
    assert.strictEqual(count, 0);
    db.close();
  });


  it('migrates older sessions tables before preparing upsert statements', () => {
    const legacyDbPath = path.join(os.tmpdir(), `agentacta-legacy-db-${Date.now()}.db`);
    try {
      const legacyDb = open(legacyDbPath);
      legacyDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          start_time TEXT NOT NULL,
          end_time TEXT,
          message_count INTEGER DEFAULT 0,
          tool_count INTEGER DEFAULT 0,
          model TEXT,
          summary TEXT,
          agent TEXT,
          session_type TEXT,
          total_cost REAL DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0
        );
      `);
      legacyDb.close();

      init(legacyDbPath);
      const db: Database.Database = open(legacyDbPath);
      const columns = db.prepare('PRAGMA table_info(sessions)').all().map((r) => (r as { name: string }).name);
      for (const column of ['initial_prompt', 'first_message_id', 'first_message_timestamp', 'models', 'projects']) {
        assert.ok(columns.includes(column), `Missing migrated column: ${column}`);
      }

      const stmts: PreparedStatements = createStmts(db);
      stmts.upsertSession.run('legacy-sess-1', '2025-01-01T00:00:00Z', null,
        1, 0, 'test-model', 'test summary', 'main', null, 0, 0, 0, 0, 0, 0,
        'hello', 'msg-1', '2025-01-01T00:00:00Z', JSON.stringify(['test-model']), JSON.stringify(['/tmp/project']));
      const row = db.prepare('SELECT initial_prompt, first_message_id, first_message_timestamp, models, projects FROM sessions WHERE id = ?').get('legacy-sess-1') as Record<string, string>;
      assert.strictEqual(row.initial_prompt, 'hello');
      assert.strictEqual(row.first_message_id, 'msg-1');
      assert.strictEqual(row.first_message_timestamp, '2025-01-01T00:00:00Z');
      assert.strictEqual(row.models, JSON.stringify(['test-model']));
      assert.strictEqual(row.projects, JSON.stringify(['/tmp/project']));
      db.close();
    } finally {
      for (const f of [legacyDbPath, legacyDbPath + '-wal', legacyDbPath + '-shm']) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  });

  it('createStmts returns all expected statements', () => {
    const db: Database.Database = open(TEST_DB);
    const stmts: PreparedStatements = createStmts(db);
    const expected: (keyof PreparedStatements)[] = ['getState', 'getSession', 'deleteEvents', 'deleteSession',
      'deleteFileActivity', 'insertEvent', 'upsertSession', 'upsertState',
      'insertFileActivity', 'deleteArchive', 'insertArchive'];
    for (const key of expected) {
      assert.ok(stmts[key], `Missing stmt: ${key}`);
    }
    db.close();
  });

  it('FTS search works after insert', () => {
    const db: Database.Database = open(TEST_DB);
    const stmts: PreparedStatements = createStmts(db);
    stmts.upsertSession.run('test-sess-1', '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z',
      1, 0, 'test-model', 'test summary', 'main', null, 0, 0, 0, 0, 0, 0, null, null, null, null, null);
    stmts.insertEvent.run('evt-1', 'test-sess-1', '2025-01-01T00:00:00Z', 'message', 'user',
      'hello world unique_search_term', null, null, null);
    const results = db.prepare("SELECT * FROM events_fts WHERE events_fts MATCH 'unique_search_term'").all();
    assert.strictEqual(results.length, 1);
    db.close();
  });
});

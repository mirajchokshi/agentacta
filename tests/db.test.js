const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open, init, createStmts } = require('../db');

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
    const db = open(TEST_DB);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
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
    const db = open(TEST_DB);
    const count = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
    assert.strictEqual(count, 0);
    db.close();
  });

  it('createStmts returns all expected statements', () => {
    const db = open(TEST_DB);
    const stmts = createStmts(db);
    const expected = ['getState', 'getSession', 'deleteEvents', 'deleteSession',
      'deleteFileActivity', 'insertEvent', 'upsertSession', 'upsertState',
      'insertFileActivity', 'deleteArchive', 'insertArchive'];
    for (const key of expected) {
      assert.ok(stmts[key], `Missing stmt: ${key}`);
    }
    db.close();
  });

  it('FTS search works after insert', () => {
    const db = open(TEST_DB);
    const stmts = createStmts(db);
    stmts.upsertSession.run('test-sess-1', '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z',
      1, 0, 'test-model', 'test summary', 'main', null, 0, 0, 0, 0, 0, 0, null, null, null, null, null);
    stmts.insertEvent.run('evt-1', 'test-sess-1', '2025-01-01T00:00:00Z', 'message', 'user',
      'hello world unique_search_term', null, null, null);
    const results = db.prepare("SELECT * FROM events_fts WHERE events_fts MATCH 'unique_search_term'").all();
    assert.strictEqual(results.length, 1);
    db.close();
  });
});

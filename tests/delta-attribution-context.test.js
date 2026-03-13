const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open, init, createStmts } = require('../db');
const { loadDeltaAttributionContext } = require('../delta-attribution-context');

const TMP = path.join(os.tmpdir(), `agentacta-test-delta-context-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

describe('delta attribution context', () => {
  let db;
  let stmts;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    init(TEST_DB);
    db = open(TEST_DB);
    stmts = createStmts(db);

    stmts.upsertSession.run(
      'delta-ctx-sess-1',
      '2026-03-12T10:00:00.000Z',
      null,
      0,
      0,
      'test-model',
      null,
      'main',
      null,
      0,
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      JSON.stringify(['proj-a'])
    );

    stmts.insertEvent.run(
      'ctx-call-1:call',
      'delta-ctx-sess-1',
      '2026-03-12T10:00:00.000Z',
      'tool_call',
      'assistant',
      null,
      'Read',
      JSON.stringify({ file_path: '/home/dev/Developer/proj-a/src/a.js' }),
      null
    );
    stmts.insertEvent.run(
      'ctx-msg-1',
      'delta-ctx-sess-1',
      '2026-03-12T10:00:00.500Z',
      'message',
      'assistant',
      'continuing update',
      null,
      null,
      null
    );
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('returns prior neighborhood rows for incoming message deltas', () => {
    const deltaRows = [
      {
        id: 'ctx-msg-2',
        session_id: 'delta-ctx-sess-1',
        timestamp: '2026-03-12T10:01:00.000Z',
        type: 'message',
        role: 'assistant',
        content: 'new streamed message'
      }
    ];

    const context = loadDeltaAttributionContext(db, 'delta-ctx-sess-1', deltaRows);
    assert.ok(context.some(row => row.id === 'ctx-call-1:call'));
    assert.ok(context.some(row => row.id === 'ctx-msg-1'));
  });

  it('still returns linked tool_call rows for tool_result deltas', () => {
    const deltaRows = [
      {
        id: 'ctx-call-1:result',
        session_id: 'delta-ctx-sess-1',
        timestamp: '2026-03-12T10:01:05.000Z',
        type: 'tool_result',
        role: 'tool',
        content: 'ok'
      }
    ];

    const context = loadDeltaAttributionContext(db, 'delta-ctx-sess-1', deltaRows);
    assert.ok(context.some(row => row.id === 'ctx-call-1:call'));
  });
});

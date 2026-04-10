import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { open, init, createStmts } from '../src/db.js';
import { loadDeltaAttributionContext } from '../src/delta-attribution-context.js';
import type { PreparedStatements, EventRow } from '../src/types.js';
import type Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-delta-context-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

describe('delta attribution context', () => {
  let db: Database.Database;
  let stmts: PreparedStatements;

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
    const deltaRows: EventRow[] = [
      {
        id: 'ctx-msg-2',
        session_id: 'delta-ctx-sess-1',
        timestamp: '2026-03-12T10:01:00.000Z',
        type: 'message',
        role: 'assistant',
        content: 'new streamed message',
        tool_name: null,
        tool_args: null,
        tool_result: null
      }
    ];

    const context = loadDeltaAttributionContext(db, 'delta-ctx-sess-1', deltaRows);
    assert.ok(context.some((row: EventRow) => row.id === 'ctx-call-1:call'));
    assert.ok(context.some((row: EventRow) => row.id === 'ctx-msg-1'));
  });

  it('still returns linked tool_call rows for tool_result deltas', () => {
    const deltaRows: EventRow[] = [
      {
        id: 'ctx-call-1:result',
        session_id: 'delta-ctx-sess-1',
        timestamp: '2026-03-12T10:01:05.000Z',
        type: 'tool_result',
        role: 'tool',
        content: 'ok',
        tool_name: null,
        tool_args: null,
        tool_result: null
      }
    ];

    const context = loadDeltaAttributionContext(db, 'delta-ctx-sess-1', deltaRows);
    assert.ok(context.some((row: EventRow) => row.id === 'ctx-call-1:call'));
  });
});

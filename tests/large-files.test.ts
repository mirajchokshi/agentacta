import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Worker } from 'node:worker_threads';

import { open, init, createStmts } from '../src/db.js';
import { indexFile, readLinesSync, recordIndexCrash, isQuarantined, MAX_INDEX_CRASHES, INDEX_QUARANTINE_MS } from '../src/indexer.js';
import type { PreparedStatements, IndexResult } from '../src/types.js';
import Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-large-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');
const MB = 1024 * 1024;

// Writes a Claude Code transcript line by line, so the test itself never holds
// the whole file. Each turn carries a 64 KB snapshot line, like the file
// snapshots that make real transcripts large.
function writeBigSession(fp: string, sessionId: string, turns: number): void {
  const fd = fs.openSync(fp, 'w');
  const padding = 'x'.repeat(64 * 1024);
  try {
    for (let i = 0; i < turns; i++) {
      const ts = new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString();
      fs.writeSync(fd, JSON.stringify({ type: 'user', sessionId, uuid: `u-${i}`, timestamp: ts, message: { role: 'user', content: `step ${i} ünïcode` } }) + '\n');
      fs.writeSync(fd, JSON.stringify({ type: 'file-history-snapshot', messageId: `u-${i}`, snapshot: { padding } }) + '\n');
    }
  } finally {
    fs.closeSync(fd);
  }
}

describe('large session files', () => {
  let db: Database.Database;
  let stmts: PreparedStatements;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    process.env.AGENTACTA_DB_PATH = TEST_DB;
    init(TEST_DB);
    db = open(TEST_DB);
    stmts = createStmts(db);
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('reads lines across chunk boundaries, including split multi-byte characters', () => {
    const fp = path.join(TMP, 'lines.jsonl');
    // The first line ends 1 byte short of the 4 MB chunk, so the 3-byte "€"
    // that starts the second line straddles the chunk boundary.
    const first = 'a'.repeat(4 * MB - 1);
    fs.writeFileSync(fp, `${first}\n€uro\r\n\n   \nlast line, no newline`);
    const lines = [...readLinesSync(fp)];
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].length, first.length);
    assert.strictEqual(lines[1], '€uro');
    assert.strictEqual(lines[2], 'last line, no newline');
  });

  it('indexes a file several times bigger than the heap allows reading whole', async () => {
    const fp = path.join(TMP, 'big.jsonl');
    writeBigSession(fp, 'big-1', 960); // about 60 MB
    assert.ok(fs.statSync(fp).size > 60 * MB);
    // A worker with a 48 MB heap, like the indexer under a tight memory limit.
    // Reading the file whole needs its size in one string plus the split copy.
    const root = path.resolve(__dirname, '..');
    const worker = new Worker(`
      require('tsx/cjs/api').register();
      const { workerData, parentPort } = require('node:worker_threads');
      const { open, createStmts } = require(${JSON.stringify(path.join(root, 'src/db.ts'))});
      const { indexFile } = require(${JSON.stringify(path.join(root, 'src/indexer.ts'))});
      const db = open(workerData.db);
      const r = indexFile(db, workerData.fp, 'claude-code', createStmts(db), false, { projectAliases: {} });
      parentPort.postMessage(r);
    `, { eval: true, workerData: { db: TEST_DB, fp }, resourceLimits: { maxOldGenerationSizeMb: 48 } });
    const result = await new Promise<IndexResult>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    assert.strictEqual(result.sessionId, 'big-1');
    const n = db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = 'big-1'").get() as { c: number };
    assert.strictEqual(n.c, 960);
    const state = db.prepare('SELECT last_offset FROM index_state WHERE file_path = ?').get(fp) as { last_offset: number };
    assert.strictEqual(state.last_offset, 1920, 'line count is recorded');
  });

  it('skips a file after it crashes the indexer repeatedly, then tries it again later', () => {
    const fp = path.join(TMP, 'crashy.jsonl');
    fs.writeFileSync(fp, JSON.stringify({ type: 'user', sessionId: 'crashy-1', uuid: 'u-1', timestamp: '2026-10-20T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n');
    const markCrash = (): void => {
      // What a worker that died mid-parse leaves behind.
      db.prepare("INSERT OR REPLACE INTO agentacta_meta (key, value) VALUES ('indexing_file', ?)").run(fp);
    };
    const t0 = Date.now();
    for (let i = 1; i <= MAX_INDEX_CRASHES; i++) {
      markCrash();
      assert.deepStrictEqual(recordIndexCrash(db, t0), { sourceKey: fp, crashes: i });
    }
    assert.strictEqual(recordIndexCrash(db, t0), null, 'the mark is consumed');
    assert.strictEqual(isQuarantined(db, fp, t0), true);
    assert.deepStrictEqual(indexFile(db, fp, 'claude-code', stmts, false), { skipped: true });
    assert.strictEqual(isQuarantined(db, fp, t0 + INDEX_QUARANTINE_MS), false, 'retried after the quarantine');

    // A successful parse clears both the mark and the crash count.
    db.prepare('UPDATE index_failures SET last_crash_at = ? WHERE source_key = ?').run(t0 - INDEX_QUARANTINE_MS, fp);
    assert.strictEqual(indexFile(db, fp, 'claude-code', stmts, false).sessionId, 'crashy-1');
    assert.strictEqual(db.prepare('SELECT 1 FROM index_failures WHERE source_key = ?').get(fp), undefined);
    assert.strictEqual(recordIndexCrash(db), null);
  });

  it('keeps the previous copy when a re-parse fails partway', () => {
    const fp = path.join(TMP, 'atomic.jsonl');
    const line = (i: number): string => JSON.stringify({ type: 'user', sessionId: 'atomic-1', uuid: `u-${i}`, timestamp: `2026-10-20T00:00:0${i}Z`, message: { role: 'user', content: `m${i}` } });
    fs.writeFileSync(fp, [0, 1, 2].map(line).join('\n') + '\n');
    indexFile(db, fp, 'claude-code', stmts, false);
    const count = (): number => (db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = 'atomic-1'").get() as { c: number }).c;
    assert.strictEqual(count(), 3);

    // Events are written while the file is read; a failure halfway must roll
    // all of them back, not leave a half-indexed session.
    fs.appendFileSync(fp, line(3) + '\n');
    const insert = stmts.insertEvent;
    let calls = 0;
    stmts.insertEvent = { run: (...args: unknown[]) => { if (++calls === 2) throw new Error('disk full'); return insert.run(...args); } } as unknown as Database.Statement;
    try {
      assert.throws(() => indexFile(db, fp, 'claude-code', stmts, false, { projectAliases: {} } as never), /disk full/);
    } finally {
      stmts.insertEvent = insert;
    }
    assert.strictEqual(count(), 3);
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = 'atomic-1'").get(), 'session row survives');
  });
});

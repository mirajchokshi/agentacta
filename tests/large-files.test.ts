import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Worker } from 'node:worker_threads';

import { open, init, createStmts } from '../src/db.js';
import { indexFile, readLinesSync, recordIndexCrash, recordStartupCrashes, clearIndexingMark, isQuarantined, MAX_INDEX_CRASHES, INDEX_QUARANTINE_MS } from '../src/indexer.js';
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
    // The fourth line spans three chunks.
    const long = 'é'.repeat(5 * MB);
    fs.writeFileSync(fp, `${first}\n€uro\r\n\n   \n${long}\nlast line, no newline`);
    const lines = [...readLinesSync(fp)];
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[0].length, first.length);
    assert.strictEqual(lines[1], '€uro');
    assert.ok(lines[2] === long, 'a line longer than a chunk comes back whole');
    assert.strictEqual(lines[3], 'last line, no newline');
  });

  it('skips a line too big to parse instead of reading it', () => {
    const fp = path.join(TMP, 'oversized.jsonl');
    // Limit 1 MB: a 2 KB line passes, a 9 MB one (spanning chunks) and a 1.5 MB
    // last line without a newline are dropped.
    fs.writeFileSync(fp, `first\n${'s'.repeat(2048)}\n${'b'.repeat(9 * MB)}\nafter\n${'t'.repeat(1.5 * MB)}`);
    assert.deepStrictEqual([...readLinesSync(fp, MB)].map(l => l.length > 10 ? l.length : l), ['first', 2048, 'after']);
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
      db.prepare('INSERT OR REPLACE INTO agentacta_meta (key, value) VALUES (?, ?)').run(`indexing_file:${process.pid}`, fp);
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

  it('at startup blames marks from dead processes only, and a clean shutdown leaves none', () => {
    const mark = (pid: number, source: string) => db.prepare('INSERT OR REPLACE INTO agentacta_meta (key, value) VALUES (?, ?)').run(`indexing_file:${pid}`, source);
    const deadPid = 2 ** 22 + 12345; // above Linux's pid_max, so never running
    mark(deadPid, '/logs/died-outright.jsonl');
    mark(1, '/logs/other-live-indexer.jsonl'); // pid 1 is always running
    const crashes = recordStartupCrashes(db);
    assert.deepStrictEqual(crashes.map(c => c.sourceKey), ['/logs/died-outright.jsonl']);
    assert.ok(db.prepare("SELECT 1 FROM agentacta_meta WHERE key = 'indexing_file:1'").get(), "a live process's mark is left alone");
    db.prepare("DELETE FROM agentacta_meta WHERE key = 'indexing_file:1'").run();

    mark(process.pid, '/logs/was-parsing.jsonl');
    clearIndexingMark(db); // clean shutdown
    assert.strictEqual(recordIndexCrash(db), null);
    assert.deepStrictEqual(recordStartupCrashes(db), []);
    db.exec('DELETE FROM index_failures');
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
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(fp, later, later); // a write in the same clock tick keeps the old mtime
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
    assert.strictEqual(recordIndexCrash(db), null, 'a thrown error is not counted as a crash');
  });

  it("indexes a forked Codex log as its own session, not its parent's", () => {
    const meta = (id: string, extra: Record<string, unknown> = {}) => ({ timestamp: '2026-08-17T00:36:00.964Z', type: 'session_meta', payload: { id, timestamp: '2026-08-17T00:36:00.964Z', cwd: '/w', originator: 'openclaw', ...extra } });
    const msg = (text: string, ts: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text } });
    const parentFp = path.join(TMP, 'codex-parent.jsonl');
    fs.writeFileSync(parentFp, [meta('parent-1'), msg('parent work', '2026-08-17T00:37:00.000Z')].map(l => JSON.stringify(l)).join('\n') + '\n');
    indexFile(db, parentFp, 'codex-cli', stmts, false, { projectAliases: {} } as never);
    // A fork opens with its own session_meta, then repeats the parent's.
    const forkFp = path.join(TMP, 'codex-fork.jsonl');
    fs.writeFileSync(forkFp, [meta('fork-1', { forked_from_id: 'parent-1', originator: 'codex_exec' }), meta('parent-1', { model: 'parent-model' }), msg('fork work', '2026-08-17T00:38:00.000Z')].map(l => JSON.stringify(l)).join('\n') + '\n');
    assert.strictEqual(indexFile(db, forkFp, 'codex-cli', stmts, false, { projectAliases: {} } as never).sessionId, 'fork-1');
    const contents = (id: string) => (db.prepare('SELECT content FROM events WHERE session_id = ?').all(id) as Array<{ content: string }>).map(r => r.content);
    assert.deepStrictEqual(contents('parent-1'), ['parent work'], 'the parent is untouched');
    assert.deepStrictEqual(contents('fork-1'), ['fork work']);
    const fork = db.prepare("SELECT models, summary FROM sessions WHERE id = 'fork-1'").get() as { models: string | null; summary: string };
    assert.strictEqual(fork.models, null, "the parent's model isn't the fork's");
    assert.match(fork.summary, /originator=codex_exec/);
  });
});

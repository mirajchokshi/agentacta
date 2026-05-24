import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { open, init, createStmts } from '../src/db.js';
import { discoverSessionDirs, listJsonlFiles, indexFile, indexCronRunFile } from '../src/indexer.js';
import type { PreparedStatements, SessionRow, SessionDir, IndexResult } from '../src/types.js';
import type Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-idx-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

function setup(): Database.Database {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.AGENTACTA_DB_PATH = TEST_DB;
  init(TEST_DB);
  return open(TEST_DB);
}

function writeSession(filename: string, lines: Record<string, unknown>[]): string {
  const fp = path.join(TMP, filename);
  fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return fp;
}

describe('indexer', () => {
  let db: Database.Database;
  let stmts: PreparedStatements;

  before(() => {
    db = setup();
    stmts = createStmts(db);
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('indexes a valid session file', () => {
    const fp = writeSession('sess1.jsonl', [
      { type: 'session', id: 'sess-001', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'message', id: 'msg-1', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: 'Hello agent' } },
      { type: 'message', id: 'msg-2', timestamp: '2025-01-01T00:02:00Z', message: { role: 'assistant', content: 'Hi there!' } }
    ]);
    const result: IndexResult = indexFile(db, fp, 'test-agent', stmts, false);
    assert.strictEqual(result.sessionId, 'sess-001');
    assert.strictEqual(result.msgCount, 2);
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-001') as SessionRow;
    assert.strictEqual(sess.agent, 'test-agent');
    assert.strictEqual(sess.summary, 'Hello agent');
  });

  it('indexes tool calls and file activity', () => {
    const fp = writeSession('sess2.jsonl', [
      { type: 'session', id: 'sess-002', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'message', id: 'msg-3', timestamp: '2025-01-01T00:01:00Z', message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc-1', name: 'Read', input: { path: '/tmp/foo.js' } }
        ]
      }}
    ]);
    const result: IndexResult = indexFile(db, fp, 'test', stmts, false);
    assert.strictEqual(result.toolCount, 1);
    const fa = db.prepare('SELECT * FROM file_activity WHERE session_id = ?').all('sess-002') as { file_path: string }[];
    assert.strictEqual(fa.length, 1);
    assert.strictEqual(fa[0].file_path, '/tmp/foo.js');
  });

  it('skips files without session header', () => {
    const fp = writeSession('nosess.jsonl', [
      { type: 'message', id: 'msg-x', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } }
    ]);
    const result: IndexResult = indexFile(db, fp, 'test', stmts, false);
    assert.ok(result.skipped);
  });

  it('skips empty files', () => {
    const fp = path.join(TMP, 'empty.jsonl');
    fs.writeFileSync(fp, '');
    const result: IndexResult = indexFile(db, fp, 'test', stmts, false);
    assert.ok(result.skipped);
  });

  it('handles malformed JSON lines gracefully', () => {
    const fp = path.join(TMP, 'bad.jsonl');
    fs.writeFileSync(fp, JSON.stringify({ type: 'session', id: 'sess-bad', timestamp: '2025-01-01T00:00:00Z' }) + '\n{not valid json}\n');
    const result: IndexResult = indexFile(db, fp, 'test', stmts, false);
    assert.strictEqual(result.sessionId, 'sess-bad');
  });

  it('stores archive data when archiveMode is true', () => {
    const fp = writeSession('sess-arch.jsonl', [
      { type: 'session', id: 'sess-arch', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'message', id: 'msg-a', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: 'archived' } }
    ]);
    indexFile(db, fp, 'test', stmts, true);
    const rows = db.prepare('SELECT * FROM archive WHERE session_id = ?').all('sess-arch');
    assert.strictEqual(rows.length, 2);
  });

  it('tracks cost and token usage', () => {
    const fp = writeSession('sess-cost.jsonl', [
      { type: 'session', id: 'sess-cost', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'message', id: 'msg-c', timestamp: '2025-01-01T00:01:00Z', message: {
        role: 'assistant', content: 'response',
        usage: { cost: { total: 0.05 }, totalTokens: 1000, input: 400, output: 600, cacheRead: 100, cacheWrite: 50 }
      }}
    ]);
    indexFile(db, fp, 'test', stmts, false);
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-cost') as SessionRow;
    assert.strictEqual(sess.total_cost, 0.05);
    assert.strictEqual(sess.total_tokens, 1000);
    assert.strictEqual(sess.input_tokens, 400);
  });

  it('skips heartbeat messages for summary', () => {
    const fp = writeSession('sess-hb.jsonl', [
      { type: 'session', id: 'sess-hb', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'message', id: 'msg-hb1', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: 'HEARTBEAT_OK' } },
      { type: 'message', id: 'msg-hb2', timestamp: '2025-01-01T00:02:00Z', message: { role: 'user', content: 'Real question here' } }
    ]);
    indexFile(db, fp, 'test', stmts, false);
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-hb') as SessionRow;
    assert.strictEqual(sess.summary, 'Real question here');
  });

  it('indexes symphony-origin codex sessions with clear attribution', () => {
    const fp = writeSession('codex-symphony.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-03-12T04:55:55.432Z',
        payload: {
          id: 'codex-symphony-1',
          timestamp: '2026-03-12T04:55:54.828Z',
          cwd: '/home/mirajrc/symphony-workspaces/HON-6',
          originator: 'symphony-orchestrator',
          source: 'vscode',
          model_provider: 'openai'
        }
      }
    ]);

    const result: IndexResult = indexFile(db, fp, 'codex-cli', stmts, false);
    assert.strictEqual(result.sessionId, 'codex-symphony-1');

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('codex-symphony-1') as SessionRow;
    assert.strictEqual(sess.agent, 'codex-cli');
    assert.strictEqual(sess.session_type, 'codex-symphony');
    assert.match(sess.summary!, /originator=symphony-orchestrator/);
    assert.match(sess.summary!, /source=vscode/);

    const projects = JSON.parse(sess.projects!) as string[];
    assert.ok(projects.includes('HON-6'));
  });

  it('indexes direct codex sessions with direct type and cwd project attribution', () => {
    const fp = writeSession('codex-direct.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-03-12T04:55:55.432Z',
        payload: {
          id: 'codex-direct-1',
          timestamp: '2026-03-12T04:55:54.828Z',
          cwd: '/home/mirajrc/Developer/mosaic',
          originator: 'codex_cli_rs',
          source: 'cli',
          model_provider: 'openai'
        }
      }
    ]);

    const result: IndexResult = indexFile(db, fp, 'codex-cli', stmts, false);
    assert.strictEqual(result.sessionId, 'codex-direct-1');

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('codex-direct-1') as SessionRow;
    assert.strictEqual(sess.agent, 'codex-cli');
    assert.strictEqual(sess.session_type, 'codex-direct');

    const projects = JSON.parse(sess.projects!) as string[];
    assert.ok(projects.includes('mosaic'));
  });

  it('lists nested jsonl files only when recursive is enabled', () => {
    const nested = path.join(TMP, 'nested', '2026', '03', '13');
    fs.mkdirSync(nested, { recursive: true });
    const rootFile = path.join(TMP, 'root.jsonl');
    const nestedFile = path.join(nested, 'nested.jsonl');
    fs.writeFileSync(rootFile, '{"type":"session","id":"r","timestamp":"2025-01-01T00:00:00Z"}\n');
    fs.writeFileSync(nestedFile, '{"type":"session","id":"n","timestamp":"2025-01-01T00:00:00Z"}\n');

    const flat: string[] = listJsonlFiles(TMP, false);
    const recursive: string[] = listJsonlFiles(TMP, true);

    assert.ok(flat.includes(rootFile));
    assert.ok(!flat.includes(nestedFile));
    assert.ok(recursive.includes(rootFile));
    assert.ok(recursive.includes(nestedFile));
  });

  it('treats overridden codex sessions path as recursive codex-cli source', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-codex-override');
    const codex = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(codex, { recursive: true });
    process.env.HOME = home;

    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: [codex] });
      const codexDir = dirs.find(d => d.path === codex);
      assert.ok(codexDir);
      assert.strictEqual(codexDir!.agent, 'codex-cli');
      assert.strictEqual(codexDir!.recursive, true);
    } finally {
      process.env.HOME = originalHome;
    }
  });


  it('keeps auto-discovered openclaw agent sessions even when sessionsPath is set', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-openclaw-merge');
    const custom = path.join(home, 'custom-sessions');
    const auto = path.join(home, '.openclaw', 'agents', 'helper', 'sessions');
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(auto, { recursive: true });
    process.env.HOME = home;

    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: [custom] });
      assert.ok(dirs.find(d => d.path === custom));
      const autoDir = dirs.find(d => d.path === auto);
      assert.ok(autoDir);
      assert.strictEqual(autoDir!.agent, 'helper');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('uses normalized config sessionsPath instead of raw env override', () => {
    const originalHome = process.env.HOME;
    const originalSessionsPath = process.env.AGENTACTA_SESSIONS_PATH;
    const home = path.join(TMP, 'home-normalized-env');
    const one = path.join(home, 'one');
    const two = path.join(home, 'two');
    fs.mkdirSync(one, { recursive: true });
    fs.mkdirSync(two, { recursive: true });
    process.env.HOME = home;
    process.env.AGENTACTA_SESSIONS_PATH = JSON.stringify([one, two]);

    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: [one, two] });
      assert.ok(dirs.find(d => d.path === one));
      assert.ok(dirs.find(d => d.path === two));
    } finally {
      process.env.HOME = originalHome;
      if (originalSessionsPath === undefined) delete process.env.AGENTACTA_SESSIONS_PATH;
      else process.env.AGENTACTA_SESSIONS_PATH = originalSessionsPath;
    }
  });

  it('uses only explicit session paths in demo mode', () => {
    const originalHome = process.env.HOME;
    const originalDemoMode = process.env.AGENTACTA_DEMO_MODE;
    const home = path.join(TMP, 'home-demo-only');
    const demo = path.join(home, 'demo-sessions');
    const auto = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(demo, { recursive: true });
    fs.mkdirSync(auto, { recursive: true });
    process.env.HOME = home;
    process.env.AGENTACTA_DEMO_MODE = '1';

    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: [demo] });
      assert.deepStrictEqual(dirs.map(d => d.path), [demo]);
    } finally {
      process.env.HOME = originalHome;
      if (originalDemoMode === undefined) delete process.env.AGENTACTA_DEMO_MODE;
      else process.env.AGENTACTA_DEMO_MODE = originalDemoMode;
    }
  });

  it('discovers cron runs as a synthetic fallback source', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-cron-runs');
    const cronRuns = path.join(home, '.openclaw', 'cron', 'runs');
    fs.mkdirSync(cronRuns, { recursive: true });
    process.env.HOME = home;

    try {
      const dirs: SessionDir[] = discoverSessionDirs({});
      const cronDir = dirs.find(d => d.path === cronRuns);
      assert.ok(cronDir);
      assert.strictEqual(cronDir!.sourceType, 'cron-run');
      assert.strictEqual(cronDir!.agent, 'cron');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('indexes cron run metadata when no transcript exists', () => {
    const fp = path.join(TMP, 'cron-run.jsonl');
    fs.writeFileSync(fp, JSON.stringify({
      ts: Date.parse('2026-03-08T12:05:00Z'),
      runAtMs: Date.parse('2026-03-08T12:00:00Z'),
      durationMs: 300000,
      sessionId: 'cron-session-1',
      sessionKey: 'agent:main:cron:job-1:run:cron-session-1',
      summary: '[Sun 2026-03-08 07:00 CDT] Cron summary',
      model: 'gpt-5.4',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }) + '\n');

    const result: IndexResult = indexCronRunFile(db, fp, 'cron', stmts);
    assert.strictEqual(result.sessionId, 'cron-session-1');

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('cron-session-1') as SessionRow;
    assert.strictEqual(sess.agent, 'main');
    assert.strictEqual(sess.session_type, 'cron');
    assert.strictEqual(sess.summary, 'Cron summary');
    assert.strictEqual(sess.message_count, 0);
    assert.strictEqual(sess.total_tokens, 15);
  });

  it('prefers transcript-backed sessions over cron metadata duplicates', () => {
    const transcript = writeSession('cron-transcript.jsonl', [
      { type: 'session', id: 'cron-preferred', timestamp: '2026-03-08T12:00:00Z', sessionType: 'cron' },
      { type: 'message', id: 'msg-ctp-1', timestamp: '2026-03-08T12:01:00Z', message: { role: 'user', content: 'Real transcript prompt' } }
    ]);
    indexFile(db, transcript, 'main', stmts, false);

    const fp = path.join(TMP, 'cron-duplicate.jsonl');
    fs.writeFileSync(fp, JSON.stringify({
      ts: Date.parse('2026-03-08T12:05:00Z'),
      sessionId: 'cron-preferred',
      sessionKey: 'agent:main:cron:job-2:run:cron-preferred',
      summary: 'Synthetic duplicate summary'
    }) + '\n');

    const result: IndexResult = indexCronRunFile(db, fp, 'cron', stmts);
    assert.ok(result.skipped);

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('cron-preferred') as SessionRow;
    assert.strictEqual(sess.summary, 'Real transcript prompt');
    assert.strictEqual(sess.message_count, 1);
  });

  it('keeps codex discovery when override paths omit codex', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-codex-fallback');
    const custom = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
    const codex = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(codex, { recursive: true });
    process.env.HOME = home;

    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: [custom] });
      const codexDir = dirs.find(d => d.path === codex);
      assert.ok(codexDir);
      assert.strictEqual(codexDir!.agent, 'codex-cli');
      assert.strictEqual(codexDir!.recursive, true);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

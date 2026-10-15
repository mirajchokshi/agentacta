import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { open, init, createStmts } from '../src/db.js';
import { discoverSessionDirs, listJsonlFiles, indexFile, indexCronRunFile, indexOpenClawDb } from '../src/indexer.js';
import { analyzeSession } from '../src/insights.js';
import type { PreparedStatements, SessionRow, SessionDir, IndexResult } from '../src/types.js';
import Database from 'better-sqlite3';

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
          cwd: '/home/user/symphony-workspaces/TASK-1',
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
    assert.ok(projects.includes('TASK-1'));
  });

  it('indexes direct codex sessions with direct type and cwd project attribution', () => {
    const fp = writeSession('codex-direct.jsonl', [
      {
        type: 'session_meta',
        timestamp: '2026-03-12T04:55:55.432Z',
        payload: {
          id: 'codex-direct-1',
          timestamp: '2026-03-12T04:55:54.828Z',
          cwd: '/home/user/Developer/sample-app',
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
    assert.ok(projects.includes('sample-app'));
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


  it('indexes OpenClaw sqlite transcript stores and skips unchanged sessions', () => {
    const dbp = path.join(TMP, 'openclaw-agent.sqlite');
    const src = new Database(dbp);
    src.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)');
    const ins = src.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)');
    ins.run('db-sess-1', 1, JSON.stringify({ type: 'session', version: 3, id: 'db-sess-1', timestamp: '2026-08-31T00:00:00Z' }), 1);
    ins.run('db-sess-1', 2, JSON.stringify({ type: 'message', id: 'db-msg-1', timestamp: '2026-08-31T00:01:00Z', message: { role: 'user', content: 'Hello from sqlite' } }), 2);
    ins.run('db-sess-1', 3, JSON.stringify({ type: 'message', id: 'db-msg-2', timestamp: '2026-08-31T00:02:00Z', message: { role: 'assistant', content: 'Hi!', model: 'openai/gpt-5.6-sol' } }), 3);

    const first = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(first, ['db-sess-1']);
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('db-sess-1') as SessionRow;
    assert.strictEqual(sess.agent, 'main');
    assert.strictEqual(sess.summary, 'Hello from sqlite');
    assert.strictEqual(sess.message_count, 2);
    assert.strictEqual(sess.model, 'openai/gpt-5.6-sol');

    // Unchanged store: nothing re-indexed
    const second = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(second, []);

    // Appended event bumps max seq and triggers a re-index
    ins.run('db-sess-1', 4, JSON.stringify({ type: 'message', id: 'db-msg-3', timestamp: '2026-08-31T00:03:00Z', message: { role: 'user', content: 'Follow-up' } }), 4);
    src.close();
    const third = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(third, ['db-sess-1']);
    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get('db-sess-1') as SessionRow;
    assert.strictEqual(updated.message_count, 3);
  });


  it('prefers the OpenClaw sqlite store over the legacy sessions dir for the same agent', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-db-preference');
    const legacy = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
    const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const storePath = path.join(agentDir, 'openclaw-agent.sqlite');
    new Database(storePath).close();
    process.env.HOME = home;
    try {
      const dirs: SessionDir[] = discoverSessionDirs({ sessionsPath: null } as never);
      const dbDir = dirs.find(d => d.path === storePath);
      assert.ok(dbDir);
      assert.strictEqual(dbDir!.sourceType, 'openclaw-db');
      assert.ok(!dirs.some(d => d.path === legacy), 'legacy sessions dir must be skipped when the sqlite store exists');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('uses the transcript_events session_id when a DB session header has no id', () => {
    const dbp = path.join(TMP, 'openclaw-agent-noid.sqlite');
    const src = new Database(dbp);
    src.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)');
    const ins = src.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)');
    ins.run('db-sess-noid', 1, JSON.stringify({ type: 'session', version: 3, timestamp: '2026-08-31T01:00:00Z' }), 1);
    ins.run('db-sess-noid', 2, JSON.stringify({ type: 'message', id: 'noid-msg-1', timestamp: '2026-08-31T01:01:00Z', message: { role: 'user', content: 'Header without id' } }), 2);
    src.close();
    const ids = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(ids, ['db-sess-noid']);
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('db-sess-noid') as SessionRow;
    assert.ok(sess, 'session must be stored under the transcript_events session_id, not a path-derived id');
  });

  it('records index state for unparseable DB sessions so they are not re-read every pass', () => {
    const dbp = path.join(TMP, 'openclaw-agent-badjson.sqlite');
    const src = new Database(dbp);
    src.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)');
    src.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)').run('db-sess-bad', 1, 'not json at all', 1);
    src.close();
    const ids = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(ids, []);
    const state = db.prepare('SELECT * FROM index_state WHERE file_path = ?').get(`${dbp}#db-sess-bad`);
    assert.ok(state, 'skipped session must still record an index_state row');
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

  it('indexes Claude Code transcripts that open with metadata lines', () => {
    const fp = writeSession('claude-mode-first.jsonl', [
      { type: 'mode', mode: 'default', sessionId: 'cc-mode-1' },
      { type: 'permission-mode', permissionMode: 'auto', sessionId: 'cc-mode-1' },
      { type: 'user', sessionId: 'cc-mode-1', uuid: 'u-1', timestamp: '2026-10-14T20:00:00Z', message: { role: 'user', content: 'Start from main' } },
      { type: 'assistant', sessionId: 'cc-mode-1', uuid: 'a-1', timestamp: '2026-10-14T20:01:00Z', message: { role: 'assistant', content: 'On it' } },
    ]);
    const result: IndexResult = indexFile(db, fp, 'claude-code', stmts, false);
    assert.strictEqual(result.sessionId, 'cc-mode-1');
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('cc-mode-1') as SessionRow;
    assert.strictEqual(sess.start_time, '2026-10-14T20:00:00Z');
    assert.strictEqual(sess.message_count, 2);
  });

  it('indexes Claude Code tool output (tool_result blocks) linked to its call', () => {
    const fp = writeSession('claude-tool-results.jsonl', [
      { type: 'user', sessionId: 'cc-tools-1', uuid: 'u-1', timestamp: '2026-10-14T20:00:00Z', message: { role: 'user', content: 'List the files' } },
      { type: 'assistant', sessionId: 'cc-tools-1', uuid: 'a-1', timestamp: '2026-10-14T20:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', sessionId: 'cc-tools-1', uuid: 'u-2', timestamp: '2026-10-14T20:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\nsrc' }] } },
      { type: 'assistant', sessionId: 'cc-tools-1', uuid: 'a-2', timestamp: '2026-10-14T20:00:07Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/x/README.md' } }] } },
      { type: 'user', sessionId: 'cc-tools-1', uuid: 'u-3', timestamp: '2026-10-14T20:00:08Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'zebracrossing readme body' }, { type: 'image', source: {} }] }] } },
    ]);
    indexFile(db, fp, 'claude-code', stmts, false);
    const results = db.prepare("SELECT id, tool_name, content FROM events WHERE session_id = 'cc-tools-1' AND type = 'tool_result' ORDER BY timestamp").all() as Array<{ id: string; tool_name: string; content: string }>;
    assert.deepStrictEqual(results.map(r => [r.id, r.tool_name]), [['toolu_1:result', 'Bash'], ['toolu_2:result', 'Read']]);
    assert.strictEqual(results[0].content, 'README.md\nsrc');
    assert.strictEqual(results[1].content, 'zebracrossing readme body');
    const fts = db.prepare("SELECT COUNT(*) AS c FROM events_fts WHERE events_fts MATCH 'zebracrossing'").get() as { c: number };
    assert.strictEqual(fts.c, 1, 'tool output is searchable');
    const sess = db.prepare("SELECT message_count, tool_count FROM sessions WHERE id = 'cc-tools-1'").get() as { message_count: number; tool_count: number };
    assert.deepStrictEqual([sess.message_count, sess.tool_count], [1, 2], 'results are not counted as messages');
  });

  it('stores Claude Code is_error once and skips image-only output', () => {
    const fp = writeSession('claude-tool-errors.jsonl', [
      { type: 'user', sessionId: 'cc-err-1', uuid: 'u-1', timestamp: '2026-10-14T20:00:00Z', message: { role: 'user', content: 'Fix it' } },
      { type: 'assistant', sessionId: 'cc-err-1', uuid: 'a-1', timestamp: '2026-10-14T20:00:01Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/x/a.ts' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'toolu_i', name: 'Read', input: { file_path: '/x/shot.png' } },
      ] } },
      { type: 'user', sessionId: 'cc-err-1', uuid: 'u-2', timestamp: '2026-10-14T20:00:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_r', content: 'throw new Error("bad input")' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Exit code 1', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_i', content: [{ type: 'image', source: {} }] },
      ] } },
    ]);
    indexFile(db, fp, 'claude-code', stmts, false);
    const rows = db.prepare("SELECT id, content, tool_result, is_error FROM events WHERE session_id = 'cc-err-1' AND type = 'tool_result' ORDER BY id").all() as Array<{ id: string; content: string; tool_result: string | null; is_error: number }>;
    assert.deepStrictEqual(rows.map(r => [r.id, r.is_error, r.tool_result]), [['toolu_b:result', 1, null], ['toolu_r:result', 0, null]]);
    assert.strictEqual(rows[1].content, 'throw new Error("bad input")');
  });

  it('error rate follows is_error, not words in the output', () => {
    const results = (flag: boolean) => [0, 1, 2].map(i => ({ type: 'tool_result', tool_use_id: `toolu_${flag}_${i}`, content: 'class ParseError extends Error {} // failed', is_error: flag }));
    for (const flag of [false, true]) {
      const sid = `cc-rate-${flag}`;
      const fp = writeSession(`${sid}.jsonl`, [
        { type: 'user', sessionId: sid, uuid: `${sid}-u1`, timestamp: '2026-10-14T20:00:00Z', message: { role: 'user', content: 'Read the parser' } },
        { type: 'assistant', sessionId: sid, uuid: `${sid}-a1`, timestamp: '2026-10-14T20:00:01Z', message: { role: 'assistant', content: [0, 1, 2].map(i => ({ type: 'tool_use', id: `toolu_${flag}_${i}`, name: 'Read', input: { file_path: `/x/p${i}.ts` } })) } },
        { type: 'user', sessionId: sid, uuid: `${sid}-u2`, timestamp: '2026-10-14T20:00:02Z', message: { role: 'user', content: results(flag) } },
      ]);
      indexFile(db, fp, 'claude-code', stmts, false);
      const signals = analyzeSession(db, sid)!.signals.map(s => s.type);
      assert.strictEqual(signals.includes('high_error_rate'), flag, `is_error=${flag}`);
    }
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { open, init, createStmts } from '../src/db.js';
import { discoverSessionDirs, listSessionFiles, indexFile, indexOpenClawDb } from '../src/indexer.js';
import { computeSessionStatus, attachChildren, LIVE_WINDOW_MS } from '../src/session-status.js';
import type { PreparedStatements, SessionRow, SessionDir } from '../src/types.js';
import type { SessionTreeNode } from '../src/session-status.js';

const TMP = path.join(os.tmpdir(), `agentacta-test-tree-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

function row(partial: Partial<SessionRow>): SessionRow {
  return { id: 'x', start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:10:00Z', source_status: null, ...partial } as SessionRow;
}

function writeJsonl(fp: string, lines: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('session status', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');

  it('is live when there was activity inside the window', () => {
    const s = row({ end_time: new Date(now - 60_000).toISOString() });
    assert.strictEqual(computeSessionStatus(s, now).status, 'live');
  });

  it('is stale when no end was recorded and it has been quiet past the window', () => {
    const s = row({ start_time: new Date(now - LIVE_WINDOW_MS - 1000).toISOString(), end_time: null });
    assert.strictEqual(computeSessionStatus(s, now).status, 'stale');
  });

  it('is ended (inactive) when quiet with an end time', () => {
    const st = computeSessionStatus(row({}), now);
    assert.deepStrictEqual([st.status, st.ended_reason], ['ended', 'inactive']);
  });

  it('treats terminal source statuses as ended even when recent', () => {
    const st = computeSessionStatus(row({ end_time: new Date(now - 1000).toISOString(), source_status: 'killed' }), now);
    assert.deepStrictEqual([st.status, st.ended_reason], ['ended', 'source']);
  });
});

describe('attachChildren', () => {
  it('nests descendants with counts and survives parent cycles', () => {
    const mk = (id: string, parent_id: string | null, status: 'live' | 'ended' = 'ended', ts = '2026-01-01T00:00:00Z') =>
      ({ id, parent_id, status, end_time: ts, start_time: ts }) as SessionTreeNode & { end_time: string; start_time: string };
    const root = mk('root', null);
    const pool = [
      mk('a', 'root', 'ended', '2026-01-01T01:00:00Z'),
      mk('b', 'root', 'live', '2026-01-01T02:00:00Z'),
      mk('a1', 'a', 'live'),
      mk('loop1', 'loop2'), mk('loop2', 'loop1'),
    ];
    const [tree] = attachChildren([root], pool, s => (s as { end_time: string }).end_time);
    assert.deepStrictEqual(tree.children!.map(c => c.id), ['b', 'a'], 'newest child first');
    assert.strictEqual(tree.child_count, 2);
    assert.strictEqual(tree.descendant_count, 3);
    assert.strictEqual(tree.live_descendant_count, 2);

    const [loop] = attachChildren([pool[3]], pool, () => '');
    assert.strictEqual(loop.descendant_count, 1, 'cycle is cut instead of recursing forever');
  });
});

describe('subagent indexing', () => {
  let db: Database.Database;
  let stmts: PreparedStatements;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    init(TEST_DB);
    db = open(TEST_DB);
    stmts = createStmts(db);
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('indexes Claude Code subagent transcripts as children without clobbering the parent', () => {
    const projDir = path.join(TMP, 'claude-proj');
    const parentId = '11111111-2222-3333-4444-555555555555';
    writeJsonl(path.join(projDir, `${parentId}.jsonl`), [
      { type: 'user', sessionId: parentId, uuid: 'p-1', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'Parent task here' } },
      { type: 'assistant', sessionId: parentId, uuid: 'p-2', timestamp: '2026-10-01T00:05:00Z', message: { role: 'assistant', content: 'Spawning a helper' } },
    ]);
    const subPath = path.join(projDir, parentId, 'subagents', 'agent-abc123.jsonl');
    writeJsonl(subPath, [
      { type: 'user', isSidechain: true, agentId: 'abc123', sessionId: parentId, uuid: 's-1', timestamp: '2026-10-01T00:01:00Z', message: { role: 'user', content: 'Do the helper thing' } },
      { type: 'assistant', isSidechain: true, agentId: 'abc123', sessionId: parentId, uuid: 's-2', timestamp: '2026-10-01T00:02:00Z', message: { role: 'assistant', content: 'Done' } },
    ]);
    fs.writeFileSync(subPath.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Build the helper' }));

    const dir: SessionDir = { path: projDir, agent: 'claude-code', subagents: true };
    const files = listSessionFiles(dir);
    assert.ok(files.includes(subPath), 'subagent transcript is discovered');
    // Index the subagent after the parent: it must not overwrite the parent row.
    for (const f of files.sort((a, b) => a.length - b.length)) indexFile(db, f, 'claude-code', stmts, false, {} as never);

    const parent = db.prepare('SELECT * FROM sessions WHERE id = ?').get(parentId) as SessionRow;
    assert.strictEqual(parent.summary, 'Parent task here');
    assert.strictEqual(parent.parent_id, null);
    const child = db.prepare('SELECT * FROM sessions WHERE id = ?').get('agent-abc123') as SessionRow;
    assert.strictEqual(child.parent_id, parentId);
    assert.strictEqual(child.session_type, 'subagent');
    assert.strictEqual(child.label, 'Build the helper');
    const parentEvents = (db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(parentId) as { c: number }).c;
    assert.strictEqual(parentEvents, 2);
  });

  it('marks discovered Claude project dirs for subagent scanning', () => {
    const originalHome = process.env.HOME;
    const home = path.join(TMP, 'home-claude');
    const proj = path.join(home, '.claude', 'projects', '-tmp-x');
    writeJsonl(path.join(proj, 's.jsonl'), [{ type: 'user', sessionId: 's', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'hi' } }]);
    process.env.HOME = home;
    try {
      const dirs = discoverSessionDirs({ sessionsPath: null } as never);
      assert.strictEqual(dirs.find(d => d.path === proj)?.subagents, true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('links Codex subagent threads to their parent thread', () => {
    const fp = path.join(TMP, 'codex', 'rollout-child.jsonl');
    writeJsonl(fp, [
      { type: 'session_meta', timestamp: '2026-10-01T00:00:00Z', payload: { id: 'codex-child', timestamp: '2026-10-01T00:00:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent', depth: 1 } } }, originator: 'codex_cli_rs' } },
      { type: 'event_msg', timestamp: '2026-10-01T00:00:01Z', payload: { type: 'user_message', message: 'Child task' } },
    ]);
    indexFile(db, fp, 'codex-cli', stmts, false, {} as never);
    const child = db.prepare('SELECT * FROM sessions WHERE id = ?').get('codex-child') as SessionRow;
    assert.strictEqual(child.parent_id, 'codex-parent');
    assert.strictEqual(child.session_type, 'subagent');
    assert.ok(!child.summary!.includes('[object Object]'));
  });

  it('reads OpenClaw parent links and status from session_nodes, re-indexing on status change', () => {
    const dbp = path.join(TMP, 'openclaw-lineage.sqlite');
    const src = new Database(dbp);
    src.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)');
    src.exec('CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, parent_session_key TEXT, spawned_by TEXT, status TEXT, label TEXT, entry_json TEXT)');
    const ins = src.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)');
    for (const sid of ['oc-parent', 'oc-child', 'oc-child2']) {
      ins.run(sid, 1, JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-10-01T00:00:00Z' }), 1);
      ins.run(sid, 2, JSON.stringify({ type: 'message', id: `${sid}-m`, timestamp: '2026-10-01T00:01:00Z', message: { role: 'user', content: `Hello ${sid}` } }), 2);
    }
    const node = src.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?, ?, ?)');
    node.run('agent:main:signal', 'oc-parent', null, null, null, null, '{}');
    node.run('agent:main:dash:1', 'oc-child', 'agent:main:signal', 'agent:main:signal', 'running', 'Deck work', JSON.stringify({ parentSessionId: 'oc-parent' }));
    // No parentSessionId in entry_json: falls back to the parent key's current session.
    node.run('agent:main:dash:2', 'oc-child2', 'agent:main:signal', null, 'done', null, JSON.stringify({ label: 'From entry' }));

    indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    const child = db.prepare('SELECT * FROM sessions WHERE id = ?').get('oc-child') as SessionRow;
    assert.deepStrictEqual([child.parent_id, child.label, child.source_status, child.session_type], ['oc-parent', 'Deck work', 'running', 'subagent']);
    const child2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get('oc-child2') as SessionRow;
    assert.deepStrictEqual([child2.parent_id, child2.label, child2.source_status], ['oc-parent', 'From entry', 'done']);

    src.prepare("UPDATE session_nodes SET status = 'killed' WHERE current_session_id = 'oc-child'").run();
    src.close();
    const reindexed = indexOpenClawDb(db, dbp, 'main', stmts, false, {} as never);
    assert.deepStrictEqual(reindexed, ['oc-child'], 'a status flip alone re-indexes the session');
    assert.strictEqual((db.prepare('SELECT source_status FROM sessions WHERE id = ?').get('oc-child') as SessionRow).source_status, 'killed');
  });

});

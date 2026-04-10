import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import { open, init, createStmts } from '../src/db.js';
import type { PreparedStatements, CountRow } from '../src/types.js';
import type Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-context-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

interface FetchResult {
  status: number | undefined;
  data: Record<string, unknown>;
}

function fetch(url: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', (c: Buffer) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data as unknown as Record<string, unknown> }); }
      });
    }).on('error', reject);
  });
}

// Inline helpers matching index.js logic
function relativeTime(ts: string | null): string | null {
  if (!ts) return null;
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function normalizeAgentLabel(agent: string | null): string | null {
  if (!agent) return agent;
  if (agent === 'main') return 'openclaw-main';
  if (agent.startsWith('claude-') || agent.startsWith('claude--')) return 'claude-code';
  return agent;
}

describe('context api', () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  before(async () => {
    fs.mkdirSync(TMP, { recursive: true });
    init(TEST_DB);
    db = open(TEST_DB);
    const stmts: PreparedStatements = createStmts(db);

    // Seed test data: 2 sessions, events, file_activity
    stmts.upsertSession.run('ctx-sess-1', '2025-06-01T10:00:00Z', '2025-06-01T10:30:00Z',
      3, 2, 'claude-3', 'Fixed bug in auth module', 'claude-code', null,
      0.05, 1000, 400, 600, 0, 0, 'fix auth bug in /home/user/myrepo', 'msg-1', '2025-06-01T10:00:00Z', null, null);

    stmts.upsertSession.run('ctx-sess-2', '2025-06-02T14:00:00Z', '2025-06-02T14:45:00Z',
      5, 3, 'claude-3', 'Refactored login flow', 'claude-code', null,
      0.08, 2000, 800, 1200, 0, 0, 'refactor /home/user/myrepo/auth', 'msg-2', '2025-06-02T14:00:00Z', null, null);

    stmts.upsertSession.run('ctx-sess-3', '2025-06-03T09:00:00Z', null,
      1, 0, 'claude-3', null, 'aider', null,
      0.01, 200, 100, 100, 0, 0, 'test prompt', 'msg-3', '2025-06-03T09:00:00Z', null, null);

    // Events
    stmts.insertEvent.run('ctx-evt-1', 'ctx-sess-1', '2025-06-01T10:05:00Z', 'tool_call', null, null, 'Read', '{"path":"/home/user/myrepo/auth.js"}', null);
    stmts.insertEvent.run('ctx-evt-2', 'ctx-sess-1', '2025-06-01T10:10:00Z', 'tool_result', null, null, 'Edit', null, 'Error: file not found /home/user/myrepo/missing.js');
    stmts.insertEvent.run('ctx-evt-3', 'ctx-sess-1', '2025-06-01T10:15:00Z', 'tool_call', null, null, 'Edit', '{"path":"/home/user/myrepo/auth.js"}', null);
    stmts.insertEvent.run('ctx-evt-4', 'ctx-sess-2', '2025-06-02T14:10:00Z', 'tool_call', null, null, 'Read', '{"path":"/home/user/myrepo/auth.js"}', null);
    stmts.insertEvent.run('ctx-evt-5', 'ctx-sess-2', '2025-06-02T14:20:00Z', 'tool_call', null, null, 'Write', '{"path":"/home/user/myrepo/login.js"}', null);
    stmts.insertEvent.run('ctx-evt-6', 'ctx-sess-2', '2025-06-02T14:30:00Z', 'tool_result', null, null, 'Bash', null, 'ERROR: test failed');

    // File activity
    stmts.insertFileActivity.run('ctx-sess-1', '/home/user/myrepo/auth.js', 'read', '2025-06-01T10:05:00Z');
    stmts.insertFileActivity.run('ctx-sess-1', '/home/user/myrepo/auth.js', 'edit', '2025-06-01T10:15:00Z');
    stmts.insertFileActivity.run('ctx-sess-1', '/home/user/myrepo/config.js', 'read', '2025-06-01T10:12:00Z');
    stmts.insertFileActivity.run('ctx-sess-2', '/home/user/myrepo/auth.js', 'read', '2025-06-02T14:10:00Z');
    stmts.insertFileActivity.run('ctx-sess-2', '/home/user/myrepo/login.js', 'write', '2025-06-02T14:20:00Z');
    stmts.insertFileActivity.run('ctx-sess-2', '/home/user/myrepo/auth.js', 'edit', '2025-06-02T14:25:00Z');

    // Create mini server replicating context API logic from index.js
    server = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:${port}`);
      const pathname = u.pathname;
      const query: Record<string, string> = {};
      u.searchParams.forEach((v, k) => query[k] = v);
      const jsonRes = (d: unknown, s = 200): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

      if (pathname === '/api/context/file') {
        const fp = query.path || '';
        if (!fp) return jsonRes({ error: 'path parameter is required' }, 400);

        const sessionCount = (db.prepare(
          'SELECT COUNT(DISTINCT session_id) as c FROM file_activity WHERE file_path = ?'
        ).get(fp) as CountRow).c;

        if (sessionCount === 0) {
          return jsonRes({ file: fp, sessionCount: 0, lastModified: null, recentChanges: [], operations: {}, relatedFiles: [], recentErrors: [] });
        }

        const lastTouched = (db.prepare(
          'SELECT MAX(timestamp) as t FROM file_activity WHERE file_path = ?'
        ).get(fp) as { t: string }).t;

        const recentChanges = db.prepare(
          `SELECT DISTINCT s.summary FROM file_activity fa
           JOIN sessions s ON s.id = fa.session_id
           WHERE fa.file_path = ? AND s.summary IS NOT NULL
           ORDER BY s.start_time DESC LIMIT 5`
        ).all(fp).map((r) => (r as { summary: string }).summary);

        const opsRows = db.prepare(
          'SELECT operation, COUNT(*) as c FROM file_activity WHERE file_path = ? GROUP BY operation'
        ).all(fp) as { operation: string; c: number }[];
        const operations: Record<string, number> = {};
        for (const r of opsRows) operations[r.operation] = r.c;

        const relatedFiles = db.prepare(
          `SELECT fa2.file_path, COUNT(*) as c
           FROM file_activity fa1
           JOIN file_activity fa2 ON fa1.session_id = fa2.session_id
           WHERE fa1.file_path = ? AND fa2.file_path != ?
           GROUP BY fa2.file_path
           ORDER BY c DESC LIMIT 5`
        ).all(fp, fp).map((r) => ({ path: (r as { file_path: string; c: number }).file_path, count: (r as { file_path: string; c: number }).c }));

        const sessionIdsArr = db.prepare(
          'SELECT DISTINCT session_id FROM file_activity WHERE file_path = ?'
        ).all(fp).map((r) => (r as { session_id: string }).session_id);

        let recentErrors: string[] = [];
        if (sessionIdsArr.length) {
          const placeholders = sessionIdsArr.map(() => '?').join(',');
          recentErrors = db.prepare(
            `SELECT tool_result FROM events
             WHERE session_id IN (${placeholders})
               AND tool_result IS NOT NULL
               AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
             ORDER BY timestamp DESC LIMIT 3`
          ).all(...sessionIdsArr).map((r) => (r as { tool_result: string }).tool_result.slice(0, 200));
        }

        return jsonRes({
          file: fp, sessionCount,
          lastModified: relativeTime(lastTouched),
          recentChanges, operations, relatedFiles, recentErrors
        });
      }
      else if (pathname === '/api/context/repo') {
        const repoPath = query.path || '';
        if (!repoPath) return jsonRes({ error: 'path parameter is required' }, 400);

        const sessionIdsFromFiles = db.prepare(
          'SELECT DISTINCT session_id FROM file_activity WHERE file_path LIKE ?'
        ).all(repoPath + '%').map((r) => (r as { session_id: string }).session_id);

        const promptSessions = db.prepare(
          'SELECT id FROM sessions WHERE initial_prompt LIKE ?'
        ).all('%' + repoPath + '%').map((r) => (r as { id: string }).id);

        const allIds = [...new Set([...sessionIdsFromFiles, ...promptSessions])];

        if (allIds.length === 0) {
          return jsonRes({ repo: repoPath, sessionCount: 0, totalCost: 0, totalTokens: 0, agents: [], topFiles: [], recentSessions: [], commonTools: [], commonErrors: [] });
        }

        const ph = allIds.map(() => '?').join(',');

        const agg = db.prepare(
          `SELECT COUNT(*) as c, SUM(total_cost) as cost, SUM(total_tokens) as tokens
           FROM sessions WHERE id IN (${ph})`
        ).get(...allIds) as { c: number; cost: number; tokens: number };

        const agents = [...new Set(
          db.prepare(`SELECT DISTINCT agent FROM sessions WHERE id IN (${ph}) AND agent IS NOT NULL`).all(...allIds)
            .map((r) => normalizeAgentLabel((r as { agent: string }).agent)).filter(Boolean) as string[]
        )];

        const topFiles = db.prepare(
          `SELECT file_path, COUNT(*) as c FROM file_activity
           WHERE session_id IN (${ph})
           GROUP BY file_path ORDER BY c DESC LIMIT 10`
        ).all(...allIds).map((r) => ({ path: (r as { file_path: string; c: number }).file_path, count: (r as { file_path: string; c: number }).c }));

        const recentSessions = db.prepare(
          `SELECT id, summary, agent, start_time, end_time FROM sessions
           WHERE id IN (${ph})
           ORDER BY start_time DESC LIMIT 5`
        ).all(...allIds).map((r) => {
          const row = r as { id: string; summary: string | null; agent: string | null; start_time: string; end_time: string | null };
          return {
            id: row.id, summary: row.summary, agent: normalizeAgentLabel(row.agent),
            timestamp: row.start_time, status: row.end_time ? 'completed' : 'in-progress'
          };
        });

        const commonTools = db.prepare(
          `SELECT tool_name, COUNT(*) as c FROM events
           WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
           GROUP BY tool_name ORDER BY c DESC LIMIT 10`
        ).all(...allIds).map((r) => ({ tool: (r as { tool_name: string; c: number }).tool_name, count: (r as { tool_name: string; c: number }).c }));

        const commonErrors = db.prepare(
          `SELECT DISTINCT SUBSTR(tool_result, 1, 200) as err FROM events
           WHERE session_id IN (${ph})
             AND tool_result IS NOT NULL
             AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
           ORDER BY timestamp DESC LIMIT 5`
        ).all(...allIds).map((r) => (r as { err: string }).err);

        return jsonRes({
          repo: repoPath, sessionCount: allIds.length,
          totalCost: agg.cost || 0, totalTokens: agg.tokens || 0,
          agents, topFiles, recentSessions, commonTools, commonErrors
        });
      }
      else if (pathname === '/api/context/agent') {
        const name = query.name || '';
        if (!name) return jsonRes({ error: 'name parameter is required' }, 400);

        const sessions = db.prepare('SELECT * FROM sessions WHERE agent = ?').all(name) as {
          id: string; start_time: string; end_time: string | null; total_cost: number;
          summary: string | null; agent: string | null;
        }[];

        if (sessions.length === 0) {
          return jsonRes({ agent: name, sessionCount: 0, totalCost: 0, avgDuration: 0, topTools: [], recentSessions: [], successRate: 0 });
        }

        const totalCost = sessions.reduce((s, r) => s + (r.total_cost || 0), 0);
        let totalDuration = 0;
        let durationCount = 0;
        for (const s of sessions) {
          if (s.start_time && s.end_time) {
            totalDuration += (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 1000;
            durationCount++;
          }
        }
        const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;
        const withSummary = sessions.filter(s => s.summary).length;
        const successRate = Math.round((withSummary / sessions.length) * 100);

        const ids = sessions.map(s => s.id);
        const ph = ids.map(() => '?').join(',');
        const topTools = db.prepare(
          `SELECT tool_name, COUNT(*) as c FROM events
           WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
           GROUP BY tool_name ORDER BY c DESC LIMIT 10`
        ).all(...ids).map((r) => ({ tool: (r as { tool_name: string; c: number }).tool_name, count: (r as { tool_name: string; c: number }).c }));

        const recentSess = sessions
          .sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''))
          .slice(0, 5)
          .map(s => ({ id: s.id, summary: s.summary, timestamp: s.start_time }));

        return jsonRes({
          agent: name, sessionCount: sessions.length,
          totalCost, avgDuration, topTools, recentSessions: recentSess, successRate
        });
      }
      else {
        jsonRes({ error: 'Not found' }, 404);
      }
    });

    port = 10000 + Math.floor(Math.random() * 50000);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // --- /api/context/file ---

  it('GET /api/context/file returns correct data', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/file?path=/home/user/myrepo/auth.js`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.file, '/home/user/myrepo/auth.js');
    assert.strictEqual(data.sessionCount, 2);
    assert.ok(data.lastModified); // relative time string
    assert.ok(Array.isArray(data.recentChanges));
    assert.ok((data.recentChanges as unknown[]).length >= 1);
    assert.ok((data.operations as Record<string, number>).read >= 2);
    assert.ok((data.operations as Record<string, number>).edit >= 2);
  });

  it('GET /api/context/file returns relatedFiles', async () => {
    const { data } = await fetch(`http://127.0.0.1:${port}/api/context/file?path=/home/user/myrepo/auth.js`);
    assert.ok(Array.isArray(data.relatedFiles));
    const paths = (data.relatedFiles as { path: string }[]).map(r => r.path);
    assert.ok(paths.includes('/home/user/myrepo/config.js') || paths.includes('/home/user/myrepo/login.js'));
    // The queried file should NOT appear in relatedFiles
    assert.ok(!paths.includes('/home/user/myrepo/auth.js'));
  });

  it('GET /api/context/file returns recentErrors', async () => {
    const { data } = await fetch(`http://127.0.0.1:${port}/api/context/file?path=/home/user/myrepo/auth.js`);
    assert.ok(Array.isArray(data.recentErrors));
    assert.ok((data.recentErrors as string[]).length >= 1);
    assert.ok((data.recentErrors as string[]).some(e => e.includes('error') || e.includes('Error') || e.includes('ERROR')));
  });

  it('GET /api/context/file with missing path returns 400', async () => {
    const { status } = await fetch(`http://127.0.0.1:${port}/api/context/file`);
    assert.strictEqual(status, 400);
  });

  it('GET /api/context/file with unknown file returns empty response', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/file?path=/nonexistent/file.js`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.sessionCount, 0);
    assert.deepStrictEqual(data.recentChanges, []);
    assert.deepStrictEqual(data.relatedFiles, []);
  });

  // --- /api/context/repo ---

  it('GET /api/context/repo returns correct aggregates', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/repo?path=/home/user/myrepo`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.repo, '/home/user/myrepo');
    assert.strictEqual(data.sessionCount, 2); // sess-1 and sess-2 match
    assert.ok((data.totalCost as number) > 0);
    assert.ok((data.totalTokens as number) > 0);
    assert.ok(Array.isArray(data.agents));
    assert.ok((data.agents as string[]).includes('claude-code'));
    assert.ok(Array.isArray(data.topFiles));
    assert.ok((data.topFiles as unknown[]).length >= 1);
    assert.ok(Array.isArray(data.recentSessions));
    assert.ok((data.recentSessions as unknown[]).length >= 1);
    assert.ok(Array.isArray(data.commonTools));
    assert.ok(Array.isArray(data.commonErrors));
  });

  it('GET /api/context/repo with missing path returns 400', async () => {
    const { status } = await fetch(`http://127.0.0.1:${port}/api/context/repo`);
    assert.strictEqual(status, 400);
  });

  it('GET /api/context/repo with unknown repo returns empty', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/repo?path=/nonexistent/repo`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.sessionCount, 0);
    assert.deepStrictEqual(data.topFiles, []);
  });

  // --- /api/context/agent ---

  it('GET /api/context/agent returns correct stats', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/agent?name=claude-code`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.agent, 'claude-code');
    assert.strictEqual(data.sessionCount, 2);
    assert.ok((data.totalCost as number) > 0);
    assert.ok((data.avgDuration as number) > 0);
    assert.ok(Array.isArray(data.topTools));
    assert.ok(Array.isArray(data.recentSessions));
    assert.strictEqual((data.recentSessions as unknown[]).length, 2);
    assert.strictEqual(data.successRate, 100); // both have summaries
  });

  it('GET /api/context/agent with missing name returns 400', async () => {
    const { status } = await fetch(`http://127.0.0.1:${port}/api/context/agent`);
    assert.strictEqual(status, 400);
  });

  it('GET /api/context/agent with unknown agent returns empty', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/context/agent?name=nonexistent`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.sessionCount, 0);
    assert.strictEqual(data.totalCost, 0);
    assert.deepStrictEqual(data.topTools, []);
  });

  it('GET /api/context/agent successRate handles sessions without summary', async () => {
    const { data } = await fetch(`http://127.0.0.1:${port}/api/context/agent?name=aider`);
    assert.strictEqual(data.sessionCount, 1);
    assert.strictEqual(data.successRate, 0); // no summary
  });
});

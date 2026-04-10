import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import { open, init, createStmts } from '../src/db.js';
import type { PreparedStatements, CountRow } from '../src/types.js';
import type Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-api-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');
const SESSIONS_DIR = path.join(TMP, 'sessions');

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

describe('api', () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  before(async () => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    // Write a session file
    const lines = [
      JSON.stringify({ type: 'session', id: 'api-sess-1', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'message', id: 'api-msg-1', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: 'test api query' } }),
      JSON.stringify({ type: 'message', id: 'api-msg-2', timestamp: '2025-01-01T00:02:00Z', message: { role: 'assistant', content: 'test response' } })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(SESSIONS_DIR, 'api-sess-1.jsonl'), lines);

    process.env.AGENTACTA_DB_PATH = TEST_DB;
    process.env.AGENTACTA_SESSIONS_PATH = SESSIONS_DIR;
    process.env.AGENTACTA_HOST = '127.0.0.1';

    // Pick random port
    port = 10000 + Math.floor(Math.random() * 50000);
    process.env.PORT = String(port);

    init(TEST_DB);
    db = open(TEST_DB);
    const stmts: PreparedStatements = createStmts(db);

    // Insert test data directly
    stmts.upsertSession.run('api-sess-1', '2025-01-01T00:00:00Z', '2025-01-01T00:02:00Z',
      2, 0, 'test-model', 'test api query', 'main', null, 0.01, 500, 200, 300, 0, 0, 'test api query', 'api-msg-1', '2025-01-01T00:01:00Z', null, null);
    stmts.insertEvent.run('api-evt-1', 'api-sess-1', '2025-01-01T00:01:00Z', 'message', 'user', 'test api query', null, null, null);
    stmts.insertEvent.run('api-evt-2', 'api-sess-1', '2025-01-01T00:02:00Z', 'message', 'assistant', 'test response', null, null, null);

    // Create a minimal HTTP server that mimics the API
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      const p = url.pathname;
      const json = (d: unknown, s = 200): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

      if (p === '/api/stats') {
        const sessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
        const events = (db.prepare('SELECT COUNT(*) as c FROM events').get() as CountRow).c;
        json({ sessions, events });
      } else if (p === '/api/sessions') {
        const rows = db.prepare('SELECT * FROM sessions ORDER BY start_time DESC LIMIT 50').all();
        json({ sessions: rows, total: rows.length });
      } else if (p.match(/^\/api\/sessions\/[^/]+$/)) {
        const id = p.split('/')[3];
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        if (!session) return json({ error: 'Not found' }, 404);
        const events = db.prepare('SELECT * FROM events WHERE session_id = ?').all(id);
        json({ session, events });
      } else if (p === '/api/health') {
        const sessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
        let dbSizeBytes = 0;
        try { dbSizeBytes = fs.statSync(TEST_DB).size; } catch {}
        json({
          status: 'ok',
          version: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version,
          uptime: Math.round(process.uptime()),
          sessions,
          dbSizeBytes,
          node: process.version
        });
      } else if (p === '/api/search') {
        const q = url.searchParams.get('q') || '';
        if (!q) return json({ results: [], total: 0 });
        try {
          const results = db.prepare("SELECT e.* FROM events_fts fts JOIN events e ON e.rowid = fts.rowid WHERE events_fts MATCH ? LIMIT 50").all(q);
          json({ results, total: results.length });
        } catch (err) { json({ error: (err as Error).message }, 400); }
      } else {
        json({ error: 'Not found' }, 404);
      }
    });

    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('GET /api/stats returns counts', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.sessions, 1);
    assert.strictEqual(data.events, 2);
  });

  it('GET /api/sessions returns sessions list', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.strictEqual(status, 200);
    assert.ok((data.sessions as unknown[]).length >= 1);
    assert.strictEqual((data.sessions as Record<string, unknown>[])[0].id, 'api-sess-1');
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/sessions/api-sess-1`);
    assert.strictEqual(status, 200);
    assert.strictEqual((data.session as Record<string, unknown>).id, 'api-sess-1');
    assert.strictEqual((data.events as unknown[]).length, 2);
  });

  it('GET /api/sessions/:id returns 404 for missing', async () => {
    const { status } = await fetch(`http://127.0.0.1:${port}/api/sessions/nonexistent`);
    assert.strictEqual(status, 404);
  });

  it('GET /api/search with FTS query returns results', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/search?q=test`);
    assert.strictEqual(status, 200);
    assert.ok((data.results as unknown[]).length >= 1);
  });

  it('GET /api/health returns status and fields', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, 'ok');
    assert.ok(typeof data.version === 'string');
    assert.ok(typeof data.uptime === 'number');
    assert.ok(typeof data.sessions === 'number');
    assert.ok(typeof data.dbSizeBytes === 'number');
    assert.ok(typeof data.node === 'string');
    assert.ok((data.node as string).startsWith('v'));
  });

  it('GET /api/search with empty query returns empty', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/search?q=`);
    assert.strictEqual(status, 200);
    assert.strictEqual((data.results as unknown[]).length, 0);
  });
});

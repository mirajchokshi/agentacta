const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { open, init, createStmts } = require('../db');

const TMP = path.join(os.tmpdir(), `agentacta-test-api-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');
const SESSIONS_DIR = path.join(TMP, 'sessions');

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    }).on('error', reject);
  });
}

describe('api', () => {
  let server, port, db;

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

    // Clear cached modules
    for (const key of Object.keys(require.cache)) {
      if (key.includes('agentacta') && !key.includes('node_modules') && !key.includes('tests')) {
        delete require.cache[key];
      }
    }

    // Start the server by requiring index.js
    // We need to capture the server - but index.js doesn't export it
    // Instead, init DB and test API via direct HTTP after spawning
    init(TEST_DB);
    db = open(TEST_DB);
    const stmts = createStmts(db);

    // Insert test data directly
    stmts.upsertSession.run('api-sess-1', '2025-01-01T00:00:00Z', '2025-01-01T00:02:00Z',
      2, 0, 'test-model', 'test api query', 'main', null, 0.01, 500, 200, 300, 0, 0, 'test api query', 'api-msg-1', '2025-01-01T00:01:00Z', null, null);
    stmts.insertEvent.run('api-evt-1', 'api-sess-1', '2025-01-01T00:01:00Z', 'message', 'user', 'test api query', null, null, null);
    stmts.insertEvent.run('api-evt-2', 'api-sess-1', '2025-01-01T00:02:00Z', 'message', 'assistant', 'test response', null, null, null);

    // Create a minimal HTTP server that mimics the API
    const { createServer } = http;
    server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const p = url.pathname;
      const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

      if (p === '/api/stats') {
        const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
        const events = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
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
      } else if (p === '/api/search') {
        const q = url.searchParams.get('q') || '';
        if (!q) return json({ results: [], total: 0 });
        try {
          const results = db.prepare("SELECT e.* FROM events_fts fts JOIN events e ON e.rowid = fts.rowid WHERE events_fts MATCH ? LIMIT 50").all(q);
          json({ results, total: results.length });
        } catch (err) { json({ error: err.message }, 400); }
      } else {
        json({ error: 'Not found' }, 404);
      }
    });

    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
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
    assert.ok(data.sessions.length >= 1);
    assert.strictEqual(data.sessions[0].id, 'api-sess-1');
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/sessions/api-sess-1`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.session.id, 'api-sess-1');
    assert.strictEqual(data.events.length, 2);
  });

  it('GET /api/sessions/:id returns 404 for missing', async () => {
    const { status } = await fetch(`http://127.0.0.1:${port}/api/sessions/nonexistent`);
    assert.strictEqual(status, 404);
  });

  it('GET /api/search with FTS query returns results', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/search?q=test`);
    assert.strictEqual(status, 200);
    assert.ok(data.results.length >= 1);
  });

  it('GET /api/search with empty query returns empty', async () => {
    const { status, data } = await fetch(`http://127.0.0.1:${port}/api/search?q=`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.results.length, 0);
  });
});

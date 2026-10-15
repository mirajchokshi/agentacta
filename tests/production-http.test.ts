import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-production-http-'));
const DB_PATH = path.join(TMP, 'test.db');
const SESSIONS_DIR = path.join(TMP, 'sessions');
const PORT = 10000 + Math.floor(Math.random() * 50000);

interface Response {
  status: number | undefined;
  body: string;
}

function request(requestPath: string, method: string = 'GET'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: requestPath, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out:\n${output}`)), 10_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(`AgentActa running on http://127.0.0.1:${PORT}`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}:\n${output}`));
    });
  });
}

describe('production HTTP routes', () => {
  let child: ChildProcess;

  before(async () => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, 'session.jsonl'), [
      JSON.stringify({ type: 'session', id: 'production-http-session', timestamp: '2025-01-01T12:00:00Z' }),
      JSON.stringify({ type: 'message', id: 'production-http-event', timestamp: '2025-01-01T12:01:00Z', message: { role: 'user', content: 'production route test' } }),
    ].join('\n') + '\n');
    // A Codex subagent thread spawned from the session above.
    fs.writeFileSync(path.join(SESSIONS_DIR, 'child.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp: '2025-01-01T12:02:00Z', payload: { id: 'production-http-child', timestamp: '2025-01-01T12:02:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'production-http-session' } } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2025-01-01T12:03:00Z', payload: { type: 'user_message', message: 'child task' } }),
    ].join('\n') + '\n');
    // A session that reads the same file three times.
    fs.writeFileSync(path.join(SESSIONS_DIR, 'touches.jsonl'), [
      JSON.stringify({ type: 'session', id: 'production-http-touches', timestamp: '2025-01-03T00:00:00Z' }),
      ...[1, 2, 3].map(n => JSON.stringify({ type: 'message', id: `touch-${n}`, timestamp: `2025-01-03T00:0${n}:00Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tc-${n}`, name: 'Read', input: { path: '/tmp/touched.js' } }] } })),
    ].join('\n') + '\n');
    // A later subagent of the same parent: its activity is newer than every root.
    fs.writeFileSync(path.join(SESSIONS_DIR, 'child-late.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp: '2025-01-09T00:00:00Z', payload: { id: 'production-http-child-late', timestamp: '2025-01-09T00:00:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'production-http-session' } } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2025-01-09T00:01:00Z', payload: { type: 'user_message', message: 'late child task' } }),
    ].join('\n') + '\n');
    // A session that started but never recorded any message, so it has no end.
    fs.writeFileSync(path.join(SESSIONS_DIR, 'stale.jsonl'), JSON.stringify({ type: 'session', id: 'production-http-stale', timestamp: '2025-01-02T00:00:00Z' }) + '\n');

    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        AGENTACTA_HOST: '127.0.0.1',
        AGENTACTA_DB_PATH: DB_PATH,
        AGENTACTA_SESSIONS_PATH: SESSIONS_DIR,
        AGENTACTA_DEMO_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(child);
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('serves timeline events for the requested local calendar day', async () => {
    const response = await request('/api/timeline?date=2025-01-01');
    assert.strictEqual(response.status, 200);
    const data = JSON.parse(response.body) as { date: string; events: Array<{ session_id: string; session_label?: unknown }> };
    assert.strictEqual(data.date, '2025-01-01');
    assert.ok(data.events.every(e => 'session_label' in e), 'timeline rows carry the session title');
    assert.strictEqual(data.events.filter(e => e.session_id === 'production-http-session').length, 1);
  });

  it('rejects malformed and impossible timeline dates', async () => {
    for (const date of ['not-a-date', '2026-02-30']) {
      const response = await request(`/api/timeline?date=${date}`);
      assert.strictEqual(response.status, 400);
      assert.match(response.body, /YYYY-MM-DD/);
    }
  });

  it('rejects encoded static path traversal', async () => {
    const response = await request('/%2e%2e/package.json');
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.body, '');
  });

  it('nests subagent sessions under their parent with roots=1', async () => {
    const flat = JSON.parse((await request('/api/sessions')).body) as { sessions: Array<{ id: string }> };
    assert.ok(flat.sessions.some(s => s.id === 'production-http-child'), 'flat list still includes children');

    const tree = JSON.parse((await request('/api/sessions?roots=1')).body) as { sessions: Array<{ id: string; child_count: number; children: Array<{ id: string }> }> };
    assert.ok(!tree.sessions.some(s => s.id === 'production-http-child'), 'child is not a top-level row');
    const parent = tree.sessions.find(s => s.id === 'production-http-session');
    assert.strictEqual(parent?.child_count, 2);
    assert.deepStrictEqual(parent?.children.map(c => c.id), ['production-http-child-late', 'production-http-child'], 'newest child first');
    assert.strictEqual(tree.sessions[0].id, 'production-http-session', 'a group sorts by its newest activity, including subagents');

    const detail = JSON.parse((await request('/api/sessions/production-http-child')).body) as { parent: { id: string } };
    assert.strictEqual(detail.parent.id, 'production-http-session');
  });

  it('reports a session that never recorded an end as stale', async () => {
    const detail = JSON.parse((await request('/api/sessions/production-http-stale')).body) as { session: { status: string } };
    assert.strictEqual(detail.session.status, 'stale');
  });

  it('lists each session once on a file\'s session list', async () => {
    const data = JSON.parse((await request('/api/files/sessions?path=' + encodeURIComponent('/tmp/touched.js'))).body) as { sessions: Array<{ id: string; touch_time: string }> };
    assert.deepStrictEqual(data.sessions.map(s => s.id), ['production-http-touches']);
    assert.strictEqual(data.sessions[0].touch_time, '2025-01-03T00:03:00Z');
  });

  it('gzips JSON responses when the client accepts it', async () => {
    const res = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/sessions?limit=50', headers: { 'Accept-Encoding': 'gzip' } }, r => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.encoding, 'gzip');
    const data = JSON.parse(zlib.gunzipSync(res.body).toString('utf8')) as { sessions: unknown[] };
    assert.ok(data.sessions.length >= 1);
  });

  it('pages a session\'s events with ?limit while the shape covers all of them', async () => {
    const full = JSON.parse((await request('/api/sessions/production-http-session')).body) as { events: Array<Record<string, unknown>>; eventTotal: number; shape: { tools: unknown[]; activity: unknown } };
    assert.strictEqual(full.events.length, full.eventTotal);
    assert.ok(full.shape && Array.isArray(full.shape.tools), 'shape is included');
    const page = JSON.parse((await request('/api/sessions/production-http-session?limit=1')).body) as typeof full;
    assert.strictEqual(page.events.length, Math.min(1, full.eventTotal));
    assert.strictEqual(page.eventTotal, full.eventTotal);
    assert.deepStrictEqual(page.shape, full.shape);
    for (const key of ['session_id', 'tool_result', 'project_confidence']) assert.ok(!(key in page.events[0]), `${key} is not sent in a limited page`);
    assert.ok('session_id' in full.events[0], 'the unlimited response keeps every field');
  });

  it('serves older session events after a cursor', async () => {
    const full = JSON.parse((await request('/api/sessions/production-http-session')).body) as { events: Array<{ id: string; timestamp: string }> };
    const first = full.events[0];
    const older = JSON.parse((await request(`/api/sessions/production-http-session?before=${encodeURIComponent(`${first.timestamp}|${first.id}`)}&limit=500`)).body) as { events: Array<{ id: string }>; hasMore: boolean };
    assert.deepStrictEqual(older.events.map(e => e.id), full.events.slice(1).map(e => e.id));
    assert.strictEqual(older.hasMore, false);
  });

  it('pages the session list with offset', async () => {
    const first = JSON.parse((await request('/api/sessions?roots=1&limit=1&offset=0')).body) as { sessions: Array<{ id: string }>; total: number };
    const second = JSON.parse((await request('/api/sessions?roots=1&limit=1&offset=1')).body) as typeof first;
    assert.ok(first.total >= 2);
    assert.notStrictEqual(first.sessions[0].id, second.sessions[0].id);
  });

  it('revalidates static files with an ETag', async () => {
    const etag = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/app.js' }, r => { r.resume(); r.on('end', () => resolve(String(r.headers.etag))); }).on('error', reject);
    });
    assert.ok(etag && etag !== 'undefined');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/app.js', headers: { 'If-None-Match': etag } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.strictEqual(status, 304);
  });

  it('reports per-day and per-agent activity for the viewer\'s timezone', async () => {
    const data = JSON.parse((await request('/api/activity?days=14&tz=0')).body) as { today: string; days: Array<{ day: string; events: number }>; agents: unknown[] };
    assert.strictEqual(data.days.length, 14);
    assert.strictEqual(data.days[13].day, data.today);
    assert.match(data.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(data.agents));
  });
});

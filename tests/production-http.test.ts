import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
    const data = JSON.parse(response.body) as { date: string; events: Array<{ session_id: string }> };
    assert.strictEqual(data.date, '2025-01-01');
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
    assert.strictEqual(parent?.child_count, 1);
    assert.strictEqual(parent?.children[0].id, 'production-http-child');

    const detail = JSON.parse((await request('/api/sessions/production-http-child')).body) as { parent: { id: string } };
    assert.strictEqual(detail.parent.id, 'production-http-session');
  });

  it('reports a session that never recorded an end as stale', async () => {
    const detail = JSON.parse((await request('/api/sessions/production-http-stale')).body) as { session: { status: string } };
    assert.strictEqual(detail.session.status, 'stale');
  });
});

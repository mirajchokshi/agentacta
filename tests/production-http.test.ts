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

function request(requestPath: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: requestPath }, res => {
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
    const data = JSON.parse(response.body) as { date: string; events: unknown[] };
    assert.strictEqual(data.date, '2025-01-01');
    assert.strictEqual(data.events.length, 1);
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
});

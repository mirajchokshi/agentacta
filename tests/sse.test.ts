import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { EventEmitter } from 'events';

import { open, init, createStmts } from '../src/db.js';
import type { PreparedStatements, EventRow } from '../src/types.js';
import type Database from 'better-sqlite3';

const TMP = path.join(os.tmpdir(), `agentacta-test-sse-${Date.now()}`);
const TEST_DB = path.join(TMP, 'test.db');

function parseCursor(cursor: string | undefined, fallbackAfter: string, fallbackAfterId?: string): { after: string; afterId: string | null } {
  const raw = (cursor || '').trim();
  if (!raw) return { after: fallbackAfter, afterId: fallbackAfterId || null };
  const sep = raw.indexOf('|');
  if (sep === -1) return { after: raw, afterId: null };
  return { after: raw.slice(0, sep), afterId: raw.slice(sep + 1) };
}

function httpGet(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get(url, resolve).on('error', reject);
  });
}

describe('SSE endpoint', () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;
  let stmts: PreparedStatements;
  let sseEmitter: EventEmitter;

  before(async () => {
    fs.mkdirSync(TMP, { recursive: true });
    init(TEST_DB);
    db = open(TEST_DB);
    stmts = createStmts(db);
    sseEmitter = new EventEmitter();

    stmts.upsertSession.run('sse-sess-1', '2025-01-01T00:00:00Z', '2025-01-01T00:02:00Z',
      1, 0, 'test-model', 'test sse', 'main', null, 0, 0, 0, 0, 0, 0, null, null, null, null, null);
    stmts.insertEvent.run('sse-evt-1', 'sse-sess-1', '2025-01-01T00:01:00Z', 'message', 'user', 'hello', null, null, null);

    const jsonRes = (res: http.ServerResponse, d: unknown, s = 200): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const p = url.pathname;
      const q: Record<string, string> = {};
      url.searchParams.forEach((v, k) => q[k] = v);

      if (p.match(/^\/api\/sessions\/[^/]+\/stream$/)) {
        const id = p.split('/')[3];
        const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
        if (!session) return jsonRes(res, { error: 'Not found' }, 404);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write(': connected\n\n');

        let cursor = parseCursor(req.headers['last-event-id'] as string | undefined, q.after || new Date().toISOString(), q.afterId || '');

        const onUpdate = (sessionId: string): void => {
          if (sessionId !== id) return;
          try {
            const rows = cursor.afterId === null
              ? db.prepare(
                `SELECT * FROM events
                 WHERE session_id = ? AND timestamp > ?
                 ORDER BY timestamp ASC, id ASC`
              ).all(id, cursor.after) as EventRow[]
              : db.prepare(
                `SELECT * FROM events
                 WHERE session_id = ?
                   AND (timestamp > ? OR (timestamp = ? AND id > ?))
                 ORDER BY timestamp ASC, id ASC`
              ).all(id, cursor.after, cursor.after, cursor.afterId) as EventRow[];
            if (rows.length) {
              const tail = rows[rows.length - 1];
              cursor = { after: tail.timestamp, afterId: tail.id };
              res.write(`id: ${tail.timestamp}|${tail.id}\ndata: ${JSON.stringify(rows)}\n\n`);
            }
          } catch {}
        };

        sseEmitter.on('session-update', onUpdate);
        req.on('close', () => sseEmitter.off('session-update', onUpdate));
      } else {
        jsonRes(res, { error: 'Not found' }, 404);
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

  it('returns SSE headers for valid session', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/sessions/sse-sess-1/stream`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
    res.destroy();
  });

  it('returns 404 for missing session', async () => {
    const res = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/sessions/nonexistent/stream`, res => {
        let data = '';
        res.on('data', (c: Buffer) => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 404);
  });

  it('pushes new events when emitter fires', async () => {
    const events = await new Promise<EventRow[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SSE')), 5000);

      const req = http.get(
        `http://127.0.0.1:${port}/api/sessions/sse-sess-1/stream?after=2025-01-01T00:01:00Z`,
        res => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const match = buf.match(/^data: (.+)$/m);
            if (match) {
              clearTimeout(timeout);
              res.destroy();
              resolve(JSON.parse(match[1]) as EventRow[]);
            }
          });
        }
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });

      // Insert a new event and emit after short delay
      setTimeout(() => {
        stmts.insertEvent.run('sse-evt-2', 'sse-sess-1', '2025-01-01T00:03:00Z',
          'message', 'assistant', 'world', null, null, null);
        sseEmitter.emit('session-update', 'sse-sess-1');
      }, 100);
    });

    assert.ok(events.length >= 1);
    assert.strictEqual(events[0].id, 'sse-evt-2');
    assert.strictEqual(events[0].content, 'world');
  });

  it('dedupes via Last-Event-ID on reconnect', async () => {
    // Simulate reconnect with Last-Event-ID header
    const events = await new Promise<EventRow[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/sessions/sse-sess-1/stream',
        headers: { 'Last-Event-ID': '2025-01-01T00:03:00Z' }
      }, res => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const match = buf.match(/^data: (.+)$/m);
          if (match) {
            clearTimeout(timeout);
            res.destroy();
            resolve(JSON.parse(match[1]) as EventRow[]);
          }
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });

      setTimeout(() => {
        stmts.insertEvent.run('sse-evt-3', 'sse-sess-1', '2025-01-01T00:05:00Z',
          'message', 'user', 'reconnect test', null, null, null);
        sseEmitter.emit('session-update', 'sse-sess-1');
      }, 100);
    });

    // Should only get evt-3, not evt-1 or evt-2
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].id, 'sse-evt-3');
  });

  it('uses timestamp plus event id cursor so same-timestamp events are not skipped', async () => {
    const events = await new Promise<EventRow[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

      const req = http.get(
        `http://127.0.0.1:${port}/api/sessions/sse-sess-1/stream?after=2025-01-01T00:06:00Z&afterId=sse-evt-4`,
        res => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const match = buf.match(/^data: (.+)$/m);
            if (match) {
              clearTimeout(timeout);
              res.destroy();
              resolve(JSON.parse(match[1]) as EventRow[]);
            }
          });
        }
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });

      setTimeout(() => {
        stmts.insertEvent.run('sse-evt-4', 'sse-sess-1', '2025-01-01T00:06:00Z',
          'message', 'assistant', 'already seen', null, null, null);
        stmts.insertEvent.run('sse-evt-5', 'sse-sess-1', '2025-01-01T00:06:00Z',
          'message', 'assistant', 'same timestamp new event', null, null, null);
        sseEmitter.emit('session-update', 'sse-sess-1');
      }, 100);
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].id, 'sse-evt-5');
  });

  it('ignores updates for other sessions', async () => {
    // Insert another session
    stmts.upsertSession.run('sse-sess-2', '2025-01-01T00:00:00Z', null,
      0, 0, null, 'other', 'main', null, 0, 0, 0, 0, 0, 0, null, null, null, null, null);

    let received = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 500); // Expect no data

      const req = http.get(
        `http://127.0.0.1:${port}/api/sessions/sse-sess-1/stream?after=2025-01-01T00:10:00Z`,
        res => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            if (buf.match(/^data:/m)) {
              received = true;
              clearTimeout(timeout);
              res.destroy();
              resolve();
            }
          });
        }
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });

      // Emit for a DIFFERENT session
      setTimeout(() => {
        sseEmitter.emit('session-update', 'sse-sess-2');
      }, 100);

      // After 500ms, if nothing received, test passes
      setTimeout(() => {
        req.destroy();
      }, 500);
    });

    assert.strictEqual(received, false);
  });
});

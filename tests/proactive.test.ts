import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { init, open, createStmts } from '../src/db.js';
import { indexFile } from '../src/indexer.js';
import { buildTrace, getSessionTrace } from '../src/tasks.js';
import { analyzeSession, analyzeAll, syncAlerts } from '../src/insights.js';
import { getDigest, listAlerts, acknowledgeAlerts } from '../src/digest.js';
import { buildSessionBriefInput } from '../src/ai.js';
import type { AgentActaConfig, SessionRow, EventRow } from '../src/types.js';

// Builds a realistic Claude Code transcript: a todo plan, a spawned subagent,
// a failing tool result, a destructive command and a leaked-looking key.

const config: AgentActaConfig = { port: 0, storage: 'reference', sessionsPath: null, dbPath: ':memory:', projectAliases: {}, authToken: null };

function ccTranscript(sessionId: string, startMs: number): { main: string; sub: string } {
  const t = (min: number) => new Date(startMs + min * 60_000).toISOString();
  const lines: string[] = [];
  let n = 0;
  const line = (type: string, message: unknown, ts: string, extra: Record<string, unknown> = {}) =>
    lines.push(JSON.stringify({ type, uuid: `u${++n}`, parentUuid: n > 1 ? `u${n - 1}` : null, sessionId, timestamp: ts, cwd: '/home/demo/app', ...extra, message }));
  const todos = (id: string, items: Array<[string, string]>) => ({ type: 'tool_use', id, name: 'TodoWrite', input: { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) } });
  const result = (id: string, content: string, ts: string, isError = false) =>
    line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ts);

  line('user', { role: 'user', content: 'Add rate limiting and clean up build artifacts. Audit the Dockerfile in a subagent.' }, t(0));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Planning.' }, todos('td1', [['Add rate limiter', 'in_progress'], ['Remove dist', 'pending'], ['Verify deploy', 'pending']])], usage: { input_tokens: 10, output_tokens: 50 } }, t(0.5));
  result('td1', 'Todos have been modified successfully.', t(0.6));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Audit Dockerfile', prompt: 'Audit the Dockerfile for security issues and report back.' } }] }, t(1));
  result('ag1', 'Async agent launched successfully.', t(1.1));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] }, t(2));
  result('b1', 'FAIL tests/routes.test.js\nTypeError: rateLimit is not a function\nexit code 1', t(2.5), true);
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/demo/app/routes.js', old_string: 'a', new_string: 'b' } }] }, t(3));
  result('e1', 'The file /home/demo/app/routes.js has been updated successfully.', t(3.1));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm test' } }] }, t(3.5));
  result('b2', 'PASS tests/routes.test.js', t(4));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [todos('td2', [['Add rate limiter', 'completed'], ['Remove dist', 'in_progress'], ['Verify deploy', 'pending']])] }, t(5));
  result('td2', 'Todos have been modified successfully.', t(5.1));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'b3', name: 'Bash', input: { command: 'rm -rf dist/ && cat .env' } }] }, t(6));
  result('b3', 'API_KEY=sk-proj-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1\nPORT=3000', t(6.5));
  line('assistant', { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Rate limiting is in; dist removed. Deploy verification is still pending.' }] }, t(7));

  const sub: string[] = [];
  const sline = (type: string, message: unknown, ts: string) =>
    sub.push(JSON.stringify({ type, uuid: `s${sub.length + 1}`, parentUuid: sub.length ? `s${sub.length}` : null, isSidechain: true, agentId: 'abc123', sessionId, timestamp: ts, cwd: '/home/demo/app', message }));
  sline('user', { role: 'user', content: 'Audit the Dockerfile for security issues and report back.' }, t(1.2));
  sline('assistant', { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/home/demo/app/Dockerfile' } }] }, t(1.4));
  sline('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'FROM node:18' }] }, t(1.5));
  sline('assistant', { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Pin the base image and add USER node.' }] }, t(2.4));

  return { main: lines.join('\n') + '\n', sub: sub.join('\n') + '\n' };
}

describe('Proactive layer: Claude Code parsing, task trace, insights, alerts, digest', () => {
  let dir: string;
  let db: Database.Database;
  const sessionId = 'cc-session-1';
  const startMs = Date.now() - 60 * 60_000; // one hour ago: quiet long enough for unfinished_tasks

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-proactive-'));
    const dbPath = path.join(dir, 'test.db');
    init(dbPath);
    db = open(dbPath);
    const stmts = createStmts(db);
    const { main, sub } = ccTranscript(sessionId, startMs);
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), main);
    fs.mkdirSync(path.join(dir, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId, 'subagents', 'agent-abc123.jsonl'), sub);
    indexFile(db, path.join(dir, `${sessionId}.jsonl`), 'claude-code', stmts, false, config);
    indexFile(db, path.join(dir, sessionId, 'subagents', 'agent-abc123.jsonl'), 'claude-code', stmts, false, config);
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('indexes Claude Code tool results with error flags and resolved tool names', () => {
    const results = db.prepare("SELECT * FROM events WHERE session_id = ? AND type = 'tool_result' ORDER BY timestamp").all(sessionId) as EventRow[];
    assert.strictEqual(results.length, 7);
    const failing = results.find(r => r.id === 'b1:result')!;
    assert.strictEqual(failing.is_error, 1);
    assert.strictEqual(failing.tool_name, 'Bash');
    assert.match(failing.content || '', /rateLimit is not a function/);
    assert.strictEqual(results.filter(r => r.is_error).length, 1);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow;
    assert.strictEqual(session.tool_count, 7);
    assert.strictEqual(session.agent, 'claude-code');
  });

  test('links subagent transcripts to the parent session instead of clobbering it', () => {
    const parent = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow;
    assert.ok(parent, 'parent session still exists after indexing the subagent file');
    const child = db.prepare('SELECT * FROM sessions WHERE id = ?').get('agent-abc123') as SessionRow;
    assert.ok(child);
    assert.strictEqual(child.parent_session_id, sessionId);
    assert.strictEqual(child.session_type, 'subagent');
    assert.strictEqual(child.tool_count, 1);
  });

  test('reconstructs the task trace: statuses, durations, attribution, subagent span, turns', () => {
    const trace = getSessionTrace(db, sessionId)!;
    assert.strictEqual(trace.summary.total, 3);
    assert.strictEqual(trace.summary.completed, 1);
    assert.strictEqual(trace.summary.in_progress, 1);
    assert.strictEqual(trace.summary.pending, 1);
    assert.strictEqual(trace.summary.has_plan, true);
    assert.strictEqual(trace.turns.length, 1);

    const limiter = trace.tasks.find(t => t.title === 'Add rate limiter')!;
    assert.strictEqual(limiter.status, 'completed');
    assert.ok(limiter.started_at && limiter.completed_at);
    assert.strictEqual(limiter.duration_ms, 4.5 * 60_000);
    // Agent spawn + 2 Bash + 1 Edit happened while this task was in progress.
    assert.strictEqual(limiter.tool_calls, 4);
    assert.strictEqual(limiter.errors, 1);
    assert.deepStrictEqual(limiter.files_touched, ['/home/demo/app/routes.js']);
    assert.deepStrictEqual(limiter.transitions.map(x => x.status), ['pending', 'in_progress', 'completed']);

    const dist = trace.tasks.find(t => t.title === 'Remove dist')!;
    assert.strictEqual(dist.status, 'in_progress');
    assert.strictEqual(dist.tool_calls, 1);

    assert.strictEqual(trace.subagents.length, 1);
    const sub = trace.subagents[0];
    assert.strictEqual(sub.title, 'Audit Dockerfile');
    assert.strictEqual(sub.child_session_id, 'agent-abc123');
    assert.strictEqual(sub.status, 'done');
    assert.strictEqual(sub.tool_calls, 1);
    assert.ok(sub.duration_ms && sub.duration_ms > 0);
  });

  test('buildTrace understands Codex update_plan and TaskCreate/TaskUpdate', () => {
    const session = { id: 'x', start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:10:00Z' } as SessionRow;
    const ev = (id: string, min: number, tool: string, args: unknown, extra: Partial<EventRow> = {}): EventRow => ({
      id, session_id: 'x', timestamp: new Date(Date.parse(session.start_time) + min * 60_000).toISOString(), type: 'tool_call', role: 'assistant', content: null, tool_name: tool, tool_args: JSON.stringify(args), tool_result: null, ...extra,
    });
    const codex = buildTrace(session, [
      ev('p1', 0, 'update_plan', { plan: [{ step: 'Read code', status: 'in_progress' }, { step: 'Write fix', status: 'pending' }] }),
      ev('p2', 4, 'update_plan', { plan: [{ step: 'Read code', status: 'completed' }, { step: 'Write fix', status: 'in_progress' }] }),
      ev('p3', 9, 'update_plan', { plan: [{ step: 'Read code', status: 'completed' }, { step: 'Write fix', status: 'completed' }] }),
    ]);
    assert.strictEqual(codex.summary.completed, 2);
    assert.strictEqual(codex.tasks[0].source, 'plan');
    assert.strictEqual(codex.tasks[1].duration_ms, 5 * 60_000);

    const tasks = buildTrace(session, [
      ev('c1', 0, 'TaskCreate', { subject: 'Ship it', description: 'd' }),
      ev('c2', 0.1, 'TaskCreate', { subject: 'Test it', description: 'd' }),
      ev('u1', 1, 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
      ev('u2', 3, 'TaskUpdate', { taskId: '2', status: 'completed' }),
      ev('u3', 4, 'TaskUpdate', { taskId: '1', status: 'deleted' }),
    ]);
    assert.strictEqual(tasks.tasks.find(t => t.id === 'task:2')!.status, 'completed');
    assert.strictEqual(tasks.tasks.find(t => t.id === 'task:1')!.status, 'deleted');
    assert.strictEqual(tasks.summary.unfinished, 0);
  });

  test('detects destructive commands, secrets and unfinished tasks; retry loops need identical calls', () => {
    const result = analyzeSession(db, sessionId)!;
    const types = result.signals.map(s => s.type);
    assert.ok(types.includes('destructive_command'), types.join(','));
    assert.ok(types.includes('secret_exposure'));
    assert.ok(types.includes('unfinished_tasks'));
    assert.ok(!types.includes('tool_retry_loop'), 'two different npm test calls are not a loop');
    assert.ok(!types.includes('high_error_rate'), '1 of 7 results failing is not a high error rate');
    const destructive = result.signals.find(s => s.type === 'destructive_command')!;
    assert.deepStrictEqual(destructive.type === 'destructive_command' && destructive.commands, ['rm -rf']);
    const unfinished = result.signals.find(s => s.type === 'unfinished_tasks')!;
    assert.strictEqual(unfinished.type === 'unfinished_tasks' && unfinished.unfinished, 2);
    assert.ok(result.flagged);
    assert.ok(result.confusion_score >= 60);
  });

  test('persists alerts once, retracts cleared ones, and acknowledges', () => {
    analyzeAll(db);
    const alerts = listAlerts(db, {});
    const forSession = alerts.filter(a => a.session_id === sessionId);
    assert.deepStrictEqual(forSession.map(a => a.type).sort(), ['destructive_command', 'secret_exposure', 'unfinished_tasks']);
    assert.strictEqual(forSession.find(a => a.type === 'secret_exposure')!.severity, 'critical');

    // Re-analysis creates nothing new.
    const again = syncAlerts(db, analyzeSession(db, sessionId)!);
    assert.strictEqual(again.length, 0);

    // A result whose signals cleared retracts unacknowledged alerts of other types.
    const stripped = { ...analyzeSession(db, sessionId)!, signals: [] };
    syncAlerts(db, stripped);
    assert.strictEqual(listAlerts(db, {}).filter(a => a.session_id === sessionId).length, 0);

    // Restore, then acknowledge.
    syncAlerts(db, analyzeSession(db, sessionId)!);
    const n = acknowledgeAlerts(db, 'all');
    assert.ok(n >= 3);
    assert.strictEqual(listAlerts(db, {}).length, 0);
    assert.ok(listAlerts(db, { includeAcknowledged: true }).length >= 3);
    // Acknowledged alerts survive re-analysis (not retracted, not duplicated).
    syncAlerts(db, analyzeSession(db, sessionId)!);
    assert.strictEqual(listAlerts(db, { includeAcknowledged: true }).filter(a => a.session_id === sessionId).length, 3);
  });

  test('digest summarizes the window with comparisons, attention items and series', () => {
    acknowledgeAlerts(db, []);
    // un-acknowledge for this check
    db.prepare('UPDATE alerts SET acknowledged = 0').run();
    const digest = getDigest(db, 24);
    assert.strictEqual(digest.window_hours, 24);
    assert.strictEqual(digest.metrics.sessions.current, 2);
    assert.strictEqual(digest.metrics.errors.current, 1);
    assert.strictEqual(digest.metrics.flagged.current >= 1, true);
    assert.match(digest.headline, /2 sessions in the last 24 hours/);
    assert.match(digest.headline, /2 critical/);
    assert.ok(digest.attention.length >= 3);
    assert.strictEqual(digest.attention[0].severity, 'critical');
    assert.strictEqual(digest.attention[0].href, `#session/${sessionId}`);
    assert.strictEqual(digest.series.length, 14);
    const today = digest.series[digest.series.length - 1];
    assert.ok(today.sessions >= 1);
    assert.ok(digest.agents.some(a => a.agent === 'claude-code' && a.sessions === 2));
  });

  test('session brief input is compact and grounded in the log', () => {
    const built = buildSessionBriefInput(db, sessionId)!;
    assert.ok(built.input.length < 14_000);
    assert.match(built.input, /PLANNED TASKS/);
    assert.match(built.input, /\[completed\] Add rate limiter/);
    assert.match(built.input, /ERROR SAMPLES/);
    assert.match(built.input, /destructive_command/);
    assert.strictEqual(built.hash.length, 16);
    assert.strictEqual(buildSessionBriefInput(db, 'nope'), null);
  });
});

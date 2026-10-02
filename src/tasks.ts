import type Database from 'better-sqlite3';
import type { EventRow, SessionRow } from './types.js';

// ─── Task tracing ────────────────────────────────────────────────────
// Reconstructs the "plan" an agent followed inside a session from the
// planning tools it called (Claude Code TodoWrite / TaskCreate / TaskUpdate,
// Codex update_plan), the subagents it spawned, and the user turns that
// framed the work. Everything is derived from indexed events; nothing is
// stored, so the trace is always consistent with the event log.

export type TraceStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type TraceSource = 'todo' | 'task' | 'plan';

export interface TraceTransition {
  status: TraceStatus;
  at: string;
  event_id: string;
}

export interface TraceTask {
  id: string;
  source: TraceSource;
  title: string;
  status: TraceStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  duration_ms: number | null;
  tool_calls: number;
  errors: number;
  files_touched: string[];
  first_event_id: string;
  transitions: TraceTransition[];
}

export interface TraceSubagent {
  id: string;
  title: string;
  subagent_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: 'running' | 'done' | 'error';
  child_session_id: string | null;
  tool_calls: number | null;
  event_id: string;
}

export interface TraceTurn {
  index: number;
  prompt: string;
  event_id: string;
  started_at: string;
  ended_at: string;
  tool_calls: number;
  errors: number;
  assistant_messages: number;
}

export interface SessionTrace {
  session_id: string;
  start_time: string;
  end_time: string | null;
  tasks: TraceTask[];
  subagents: TraceSubagent[];
  turns: TraceTurn[];
  summary: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
    deleted: number;
    unfinished: number;
    subagents: number;
    turns: number;
    unattributed_tool_calls: number;
    has_plan: boolean;
  };
}

interface PlanItem {
  key: string;
  title: string;
  status: TraceStatus;
}

const TODO_TOOLS = new Set(['TodoWrite', 'todo_write', 'todowrite']);
const PLAN_TOOLS = new Set(['update_plan', 'UpdatePlan']);
const TASK_CREATE_TOOLS = new Set(['TaskCreate']);
const TASK_UPDATE_TOOLS = new Set(['TaskUpdate']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'sessions_spawn', 'spawn_agent']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit', 'apply_patch']);

function parseArgs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeStatus(s: unknown): TraceStatus {
  const v = String(s || '').toLowerCase();
  if (v === 'completed' || v === 'done' || v === 'complete') return 'completed';
  if (v === 'in_progress' || v === 'in-progress' || v === 'active' || v === 'running') return 'in_progress';
  if (v === 'deleted' || v === 'cancelled' || v === 'canceled' || v === 'removed') return 'deleted';
  return 'pending';
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function snapshotItems(args: Record<string, unknown>): PlanItem[] {
  const list = (Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : []) as Array<Record<string, unknown>>;
  const items: PlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.content || raw.step || raw.subject || raw.title || '').trim();
    if (!title) continue;
    const explicitId = raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
    items.push({ key: explicitId ? `id:${explicitId}` : `t:${slug(title)}`, title, status: normalizeStatus(raw.status) });
  }
  return items;
}

function extractFilePath(args: Record<string, unknown>): string | null {
  const candidates = [args.file_path, args.path, args.filePath, args.notebook_path];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
}

function elapsed(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Build the task trace for a session from its ordered events.
 * `children` are sessions whose parent_session_id points at this one and are
 * used to attach durations and tool counts to spawned subagents.
 */
export function buildTrace(session: SessionRow, events: EventRow[], children: SessionRow[] = []): SessionTrace {
  const tasks = new Map<string, TraceTask>();
  const order: string[] = [];
  const subagents: TraceSubagent[] = [];
  const turns: TraceTurn[] = [];
  const toolNameById = new Map<string, string>();
  const subagentById = new Map<string, TraceSubagent>();
  let unattributed = 0;
  let sawPlanTool = false;
  let taskCounter = 0;

  // Most recently started in-progress task wins attribution of tool calls.
  const activeStack: string[] = [];

  function ensureTask(key: string, source: TraceSource, title: string, ev: EventRow): TraceTask {
    let t = tasks.get(key);
    if (!t) {
      t = {
        id: key,
        source,
        title,
        status: 'pending',
        created_at: ev.timestamp,
        started_at: null,
        completed_at: null,
        updated_at: ev.timestamp,
        duration_ms: null,
        tool_calls: 0,
        errors: 0,
        files_touched: [],
        first_event_id: ev.id,
        transitions: [{ status: 'pending', at: ev.timestamp, event_id: ev.id }],
      };
      tasks.set(key, t);
      order.push(key);
    } else if (title && title !== t.title) {
      t.title = title;
    }
    return t;
  }

  function setStatus(t: TraceTask, status: TraceStatus, ev: EventRow): void {
    if (t.status === status) return;
    t.status = status;
    t.updated_at = ev.timestamp;
    t.transitions.push({ status, at: ev.timestamp, event_id: ev.id });
    if (status === 'in_progress') {
      if (!t.started_at) t.started_at = ev.timestamp;
      const i = activeStack.indexOf(t.id);
      if (i !== -1) activeStack.splice(i, 1);
      activeStack.push(t.id);
    } else {
      const i = activeStack.indexOf(t.id);
      if (i !== -1) activeStack.splice(i, 1);
      if (status === 'completed') t.completed_at = ev.timestamp;
    }
  }

  function applySnapshot(items: PlanItem[], source: TraceSource, ev: EventRow): void {
    sawPlanTool = true;
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${source}:${item.key}`;
      seen.add(key);
      const t = ensureTask(key, source, item.title, ev);
      setStatus(t, item.status, ev);
    }
    // Items dropped from a full-list snapshot were removed by the agent.
    for (const key of order) {
      const t = tasks.get(key)!;
      if (t.source !== source || seen.has(key)) continue;
      if (t.status !== 'completed' && t.status !== 'deleted') setStatus(t, 'deleted', ev);
    }
  }

  let currentTurn: TraceTurn | null = null;

  for (const ev of events) {
    if (ev.type === 'message' && ev.role === 'user') {
      if (currentTurn) currentTurn.ended_at = ev.timestamp;
      currentTurn = {
        index: turns.length + 1,
        prompt: (ev.content || '').slice(0, 240),
        event_id: ev.id,
        started_at: ev.timestamp,
        ended_at: ev.timestamp,
        tool_calls: 0,
        errors: 0,
        assistant_messages: 0,
      };
      turns.push(currentTurn);
      continue;
    }

    if (currentTurn) currentTurn.ended_at = ev.timestamp;

    if (ev.type === 'message' && ev.role === 'assistant') {
      if (currentTurn) currentTurn.assistant_messages++;
      continue;
    }

    if (ev.type === 'tool_call') {
      const name = ev.tool_name || '';
      toolNameById.set(ev.id, name);
      const args = parseArgs(ev.tool_args);

      if (TODO_TOOLS.has(name)) { applySnapshot(snapshotItems(args), 'todo', ev); continue; }
      if (PLAN_TOOLS.has(name)) { applySnapshot(snapshotItems(args), 'plan', ev); continue; }

      if (TASK_CREATE_TOOLS.has(name)) {
        sawPlanTool = true;
        taskCounter++;
        const subject = String(args.subject || args.title || args.description || `Task ${taskCounter}`).trim();
        const t = ensureTask(`task:${taskCounter}`, 'task', subject, ev);
        setStatus(t, 'pending', ev);
        continue;
      }

      if (TASK_UPDATE_TOOLS.has(name)) {
        sawPlanTool = true;
        const taskId = String(args.taskId || args.id || '').trim();
        if (taskId) {
          const key = `task:${taskId}`;
          const existing = tasks.get(key);
          const t = existing || ensureTask(key, 'task', String(args.subject || `Task ${taskId}`), ev);
          if (typeof args.subject === 'string' && args.subject) t.title = args.subject;
          if (args.status !== undefined) setStatus(t, normalizeStatus(args.status), ev);
          else t.updated_at = ev.timestamp;
        }
        continue;
      }

      if (SUBAGENT_TOOLS.has(name)) {
        const title = String(args.description || args.task || args.label || args.prompt || name).slice(0, 160);
        const sub: TraceSubagent = {
          id: ev.id,
          title,
          subagent_type: typeof args.subagent_type === 'string' ? args.subagent_type : (typeof args.agent === 'string' ? args.agent : null),
          started_at: ev.timestamp,
          ended_at: null,
          duration_ms: null,
          status: 'running',
          child_session_id: null,
          tool_calls: null,
          event_id: ev.id,
        };
        const prompt = typeof args.prompt === 'string' ? args.prompt : (typeof args.task === 'string' ? args.task : '');
        if (prompt && children.length) {
          const probe = prompt.slice(0, 120);
          const child = children.find(c => c.initial_prompt && c.initial_prompt.startsWith(probe) && !subagents.some(s => s.child_session_id === c.id));
          if (child) {
            sub.child_session_id = child.id;
            sub.tool_calls = child.tool_count;
            if (child.end_time) {
              sub.ended_at = child.end_time;
              sub.status = 'done';
            }
          }
        }
        subagents.push(sub);
        subagentById.set(ev.id, sub);
      }

      if (currentTurn) currentTurn.tool_calls++;
      const activeId = activeStack[activeStack.length - 1];
      if (activeId) {
        const t = tasks.get(activeId)!;
        t.tool_calls++;
        if (WRITE_TOOLS.has(name)) {
          const fp = extractFilePath(args);
          if (fp && !t.files_touched.includes(fp) && t.files_touched.length < 25) t.files_touched.push(fp);
        }
      } else {
        unattributed++;
      }
      continue;
    }

    if (ev.type === 'tool_result') {
      const callId = ev.id.endsWith(':result') ? ev.id.slice(0, -':result'.length) : null;
      if (callId && subagentById.has(callId)) {
        const sub = subagentById.get(callId)!;
        const content = ev.content || '';
        // Async launches return immediately; the real span comes from the child session.
        const asyncLaunch = /launched successfully|running in the background/i.test(content);
        if (!asyncLaunch && !sub.ended_at) {
          sub.ended_at = ev.timestamp;
          sub.status = ev.is_error ? 'error' : 'done';
        }
      }
      if (ev.is_error) {
        if (currentTurn) currentTurn.errors++;
        const activeId = activeStack[activeStack.length - 1];
        if (activeId) tasks.get(activeId)!.errors++;
      }
    }
  }

  const sessionEnd = session.end_time || (events.length ? events[events.length - 1].timestamp : null);
  for (const sub of subagents) sub.duration_ms = elapsed(sub.started_at, sub.ended_at);

  const taskList = order.map(k => tasks.get(k)!);
  for (const t of taskList) {
    const endRef = t.completed_at || (t.status === 'in_progress' ? sessionEnd : null);
    t.duration_ms = elapsed(t.started_at, endRef);
  }

  const counts = { completed: 0, in_progress: 0, pending: 0, deleted: 0 };
  for (const t of taskList) counts[t.status]++;

  return {
    session_id: session.id,
    start_time: session.start_time,
    end_time: session.end_time,
    tasks: taskList,
    subagents,
    turns,
    summary: {
      total: taskList.length,
      completed: counts.completed,
      in_progress: counts.in_progress,
      pending: counts.pending,
      deleted: counts.deleted,
      unfinished: counts.in_progress + counts.pending,
      subagents: subagents.length,
      turns: turns.length,
      unattributed_tool_calls: unattributed,
      has_plan: sawPlanTool,
    },
  };
}

export function getSessionTrace(db: Database.Database, sessionId: string): SessionTrace | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session) return null;
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC').all(sessionId) as EventRow[];
  const children = db.prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY start_time ASC').all(sessionId) as SessionRow[];
  return buildTrace(session, events, children);
}

/** Lightweight per-session plan summary used by insights and the digest. */
export function summarizeTasks(db: Database.Database, sessionId: string): SessionTrace['summary'] | null {
  const trace = getSessionTrace(db, sessionId);
  return trace ? trace.summary : null;
}

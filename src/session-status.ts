// Session lifecycle status and parent/child tree helpers.
//
// AgentActa is a passive indexer: transcripts never say "this session is still
// running", so liveness is inferred. A session is:
//   live   - activity within LIVE_WINDOW_MS (same window as Overview "Active Now")
//   stale  - never recorded an end (end_time NULL) and has been quiet past the window
//   ended  - reported finished by its source (OpenClaw done/failed/killed), or
//            simply quiet past the window

import type { SessionRow } from './types.js';

export const LIVE_WINDOW_MS = 15 * 60 * 1000;

const TERMINAL_SOURCE_STATUSES = new Set([
  'done', 'completed', 'complete', 'failed', 'error', 'killed', 'aborted', 'cancelled', 'canceled', 'ended', 'stopped'
]);

export type SessionStatus = 'live' | 'stale' | 'ended';
export type EndedReason = 'source' | 'inactive' | null;

export interface StatusFields {
  status: SessionStatus;
  ended_reason: EndedReason;
  ended_at: string | null;
}


function toMs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(ts);
}

export function computeSessionStatus(s: SessionRow, nowMs: number = Date.now()): StatusFields {
  const lastMs = toMs(s.end_time || s.start_time);
  if (s.source_status && TERMINAL_SOURCE_STATUSES.has(s.source_status.toLowerCase())) {
    return { status: 'ended', ended_reason: 'source', ended_at: s.end_time };
  }
  if (Number.isFinite(lastMs) && nowMs - lastMs <= LIVE_WINDOW_MS) {
    return { status: 'live', ended_reason: null, ended_at: null };
  }
  if (!s.end_time) {
    return { status: 'stale', ended_reason: null, ended_at: null };
  }
  return { status: 'ended', ended_reason: 'inactive', ended_at: s.end_time };
}

export function withStatus<T extends SessionRow>(s: T, nowMs: number = Date.now()): T & StatusFields {
  return { ...s, ...computeSessionStatus(s, nowMs) };
}

export interface SessionTreeNode {
  id: string;
  parent_id?: string | null;
  status?: SessionStatus;
  children?: SessionTreeNode[];
  child_count?: number;
  descendant_count?: number;
  live_descendant_count?: number;
}

// Attaches descendants (from `pool`) to each root, newest child first, and
// annotates every node with child/descendant counts. Cycles and self-parenting
// are ignored so a bad parent link can never hang the request.
export function attachChildren<T extends SessionTreeNode>(roots: T[], pool: T[], sortKey: (s: T) => string): Array<T & SessionTreeNode> {
  const byParent = new Map<string, T[]>();
  for (const s of pool) {
    if (!s.parent_id || s.parent_id === s.id) continue;
    const list = byParent.get(s.parent_id);
    if (list) list.push(s); else byParent.set(s.parent_id, [s]);
  }
  for (const list of byParent.values()) list.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  const visit = (node: T, seen: Set<string>): void => {
    seen.add(node.id);
    const kids = (byParent.get(node.id) || []).filter(k => !seen.has(k.id));
    let descendants = 0;
    let liveDescendants = 0;
    for (const k of kids) {
      visit(k, seen);
      descendants += 1 + (k.descendant_count || 0);
      liveDescendants += (k.status === 'live' ? 1 : 0) + (k.live_descendant_count || 0);
    }
    node.children = kids;
    node.child_count = kids.length;
    node.descendant_count = descendants;
    node.live_descendant_count = liveDescendants;
  };
  for (const r of roots) visit(r, new Set());
  return roots;
}

// The session page's "shape": events over the session in 12-40 time buckets,
// and tool-call counts by raw tool name. Computed here from every event so the
// page can open with only its first page of events.
export interface SessionShape {
  activity: { startMs: number; endMs: number; counts: number[] } | null;
  tools: Array<[string, number]>;
}

export function sessionShape(session: Pick<SessionRow, 'start_time' | 'end_time'>, eventsNewestFirst: Array<{ timestamp: string; type: string; tool_name: string | null }>): SessionShape {
  const startMs = Date.parse(session.start_time);
  const endMs = Date.parse(session.end_time || '') || (eventsNewestFirst.length ? Date.parse(eventsNewestFirst[0].timestamp) : startMs);
  const durMs = Math.max(0, endMs - startMs);
  const stamped = eventsNewestFirst.map(e => Date.parse(e.timestamp)).filter(t => Number.isFinite(t) && t >= startMs);
  let activity: SessionShape['activity'] = null;
  if (stamped.length >= 6 && durMs >= 60000) {
    const n = Math.min(40, Math.max(12, Math.round(durMs / 60000)));
    const step = durMs / n;
    const counts = new Array<number>(n).fill(0);
    for (const t of stamped) counts[Math.min(n - 1, Math.floor((t - startMs) / step))]++;
    activity = { startMs, endMs, counts };
  }
  const tools = new Map<string, number>();
  for (const e of eventsNewestFirst) if (e.type === 'tool_call' && e.tool_name) tools.set(e.tool_name, (tools.get(e.tool_name) || 0) + 1);
  return { activity, tools: [...tools.entries()] };
}

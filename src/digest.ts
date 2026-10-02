import type Database from 'better-sqlite3';
import type { AlertWithSession, InsightSignal } from './types.js';

// ─── Digest ──────────────────────────────────────────────────────────
// The digest is the proactive summary of "what happened and what needs a
// human" over a window. It is deliberately plain-data so the UI, the Context
// API consumers (agents) and the optional AI brief can all read the same thing.

export interface DigestMetric {
  current: number;
  previous: number;
  delta_pct: number | null;
}

export interface DigestAttentionItem {
  kind: 'alert' | 'flagged_session' | 'unfinished_tasks' | 'failing_tool' | 'churned_file' | 'active_session';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string | null;
  session_id: string | null;
  href: string;
  at: string | null;
  score?: number;
}

export interface DigestSeriesPoint {
  day: string;
  sessions: number;
  tool_calls: number;
  errors: number;
  tokens: number;
  flagged: number;
}

export interface Digest {
  window_hours: number;
  since: string;
  until: string;
  headline: string;
  metrics: {
    sessions: DigestMetric;
    tool_calls: DigestMetric;
    messages: DigestMetric;
    tokens: DigestMetric;
    cost: DigestMetric;
    errors: DigestMetric;
    flagged: DigestMetric;
  };
  attention: DigestAttentionItem[];
  alerts: AlertWithSession[];
  failing_tools: Array<{ tool_name: string; errors: number; total: number; rate: number }>;
  churned_files: Array<{ file_path: string; edits: number; sessions: number }>;
  agents: Array<{ agent: string; sessions: number; flagged: number; tool_calls: number; tokens: number }>;
  series: DigestSeriesPoint[];
  active_sessions: Array<{ id: string; summary: string | null; agent: string | null; end_time: string | null; tool_count: number }>;
}

interface SumRow { sessions: number; tool_calls: number; messages: number; tokens: number; cost: number }
interface CountRow { c: number }

function pct(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function metric(current: number, previous: number): DigestMetric {
  return { current, previous, delta_pct: pct(current, previous) };
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

function windowTotals(db: Database.Database, since: string, until: string): SumRow & { errors: number; flagged: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS sessions,
           COALESCE(SUM(tool_count), 0) AS tool_calls,
           COALESCE(SUM(message_count), 0) AS messages,
           COALESCE(SUM(CASE WHEN total_tokens > 0 THEN total_tokens ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens END), 0) AS tokens,
           COALESCE(SUM(total_cost), 0) AS cost
    FROM sessions WHERE start_time >= ? AND start_time < ?
  `).get(since, until) as SumRow;
  const errors = (db.prepare(
    'SELECT COUNT(*) AS c FROM events WHERE type = \'tool_result\' AND is_error = 1 AND timestamp >= ? AND timestamp < ?'
  ).get(since, until) as CountRow).c;
  const flagged = (db.prepare(
    'SELECT COUNT(*) AS c FROM session_insights si JOIN sessions s ON s.id = si.session_id WHERE si.flagged = 1 AND s.start_time >= ? AND s.start_time < ?'
  ).get(since, until) as CountRow).c;
  return { ...row, errors, flagged };
}

export function listAlerts(db: Database.Database, opts: { since?: string; includeAcknowledged?: boolean; limit?: number } = {}): AlertWithSession[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since) { where.push('a.created_at >= ?'); params.push(opts.since); }
  if (!opts.includeAcknowledged) where.push('a.acknowledged = 0');
  const sql = `
    SELECT a.*, s.summary, s.agent, s.start_time
    FROM alerts a JOIN sessions s ON s.id = a.session_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC
    LIMIT ?`;
  params.push(Math.min(Math.max(opts.limit || 50, 1), 500));
  return db.prepare(sql).all(...params) as AlertWithSession[];
}

export function acknowledgeAlerts(db: Database.Database, ids: number[] | 'all'): number {
  if (ids === 'all') return db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run().changes;
  if (!ids.length) return 0;
  const stmt = db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?');
  let n = 0;
  const run = db.transaction(() => { for (const id of ids) n += stmt.run(id).changes; });
  run();
  return n;
}

export function getDigest(db: Database.Database, windowHours: number = 24): Digest {
  const hours = Math.min(Math.max(windowHours, 1), 24 * 90);
  const nowMs = Date.now();
  const sinceMs = nowMs - hours * 3_600_000;
  const prevSinceMs = sinceMs - hours * 3_600_000;
  const since = iso(sinceMs);
  const until = iso(nowMs);
  const prevSince = iso(prevSinceMs);

  const cur = windowTotals(db, since, until);
  const prev = windowTotals(db, prevSince, since);

  const alerts = listAlerts(db, { since, limit: 50 });

  const flaggedSessions = db.prepare(`
    SELECT s.id, s.summary, s.agent, s.start_time, si.confusion_score, si.signals
    FROM session_insights si JOIN sessions s ON s.id = si.session_id
    WHERE si.flagged = 1 AND s.start_time >= ?
    ORDER BY si.confusion_score DESC LIMIT 10
  `).all(since) as Array<{ id: string; summary: string | null; agent: string | null; start_time: string; confusion_score: number; signals: string }>;

  const failingTools = db.prepare(`
    SELECT tool_name, SUM(is_error) AS errors, COUNT(*) AS total
    FROM events WHERE type = 'tool_result' AND tool_name IS NOT NULL AND tool_name != '' AND timestamp >= ?
    GROUP BY tool_name HAVING total >= 5 AND errors > 0
    ORDER BY (SUM(is_error) * 1.0 / COUNT(*)) DESC, errors DESC LIMIT 5
  `).all(since) as Array<{ tool_name: string; errors: number; total: number }>;

  const churnedFiles = db.prepare(`
    SELECT file_path, COUNT(*) AS edits, COUNT(DISTINCT session_id) AS sessions
    FROM file_activity WHERE operation IN ('write', 'edit') AND timestamp >= ?
    GROUP BY file_path HAVING edits >= 3 ORDER BY edits DESC LIMIT 5
  `).all(since) as Array<{ file_path: string; edits: number; sessions: number }>;

  const agents = db.prepare(`
    SELECT COALESCE(s.agent, 'unknown') AS agent,
           COUNT(*) AS sessions,
           COALESCE(SUM(si.flagged), 0) AS flagged,
           COALESCE(SUM(s.tool_count), 0) AS tool_calls,
           COALESCE(SUM(CASE WHEN s.total_tokens > 0 THEN s.total_tokens ELSE s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens END), 0) AS tokens
    FROM sessions s LEFT JOIN session_insights si ON si.session_id = s.id
    WHERE s.start_time >= ? GROUP BY COALESCE(s.agent, 'unknown') ORDER BY sessions DESC
  `).all(since) as Digest['agents'];

  const activeSessions = db.prepare(`
    SELECT id, summary, agent, end_time, tool_count FROM sessions
    WHERE COALESCE(end_time, start_time) >= ? ORDER BY COALESCE(end_time, start_time) DESC LIMIT 6
  `).all(iso(nowMs - 15 * 60_000)) as Digest['active_sessions'];

  // 14-day daily series for sparklines
  const seriesDays = 14;
  const seriesSince = iso(nowMs - seriesDays * 86_400_000);
  const perDaySessions = db.prepare(`
    SELECT substr(s.start_time, 1, 10) AS day, COUNT(*) AS sessions, COALESCE(SUM(s.tool_count), 0) AS tool_calls,
           COALESCE(SUM(CASE WHEN s.total_tokens > 0 THEN s.total_tokens ELSE s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens END), 0) AS tokens,
           COALESCE(SUM(si.flagged), 0) AS flagged
    FROM sessions s LEFT JOIN session_insights si ON si.session_id = s.id
    WHERE s.start_time >= ? GROUP BY day
  `).all(seriesSince) as Array<{ day: string; sessions: number; tool_calls: number; tokens: number; flagged: number }>;
  const perDayErrors = db.prepare(`
    SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS errors FROM events
    WHERE type = 'tool_result' AND is_error = 1 AND timestamp >= ? GROUP BY day
  `).all(seriesSince) as Array<{ day: string; errors: number }>;
  const byDay = new Map<string, DigestSeriesPoint>();
  for (let i = seriesDays - 1; i >= 0; i--) {
    const day = iso(nowMs - i * 86_400_000).slice(0, 10);
    byDay.set(day, { day, sessions: 0, tool_calls: 0, errors: 0, tokens: 0, flagged: 0 });
  }
  for (const r of perDaySessions) {
    const p = byDay.get(r.day); if (!p) continue;
    p.sessions = r.sessions; p.tool_calls = r.tool_calls; p.tokens = r.tokens; p.flagged = r.flagged;
  }
  for (const r of perDayErrors) { const p = byDay.get(r.day); if (p) p.errors = r.errors; }

  // Attention feed: one ranked list the overview can render directly.
  const attention: DigestAttentionItem[] = [];
  for (const a of alerts) {
    attention.push({
      kind: 'alert', severity: a.severity, title: a.title, detail: a.summary || a.detail,
      session_id: a.session_id, href: `#session/${a.session_id}`, at: a.created_at,
    });
  }
  const alertedSessions = new Set(alerts.map(a => a.session_id));
  for (const s of flaggedSessions) {
    if (alertedSessions.has(s.id)) continue;
    const signals = JSON.parse(s.signals || '[]') as InsightSignal[];
    const names = signals.map(sig => sig.type.replace(/_/g, ' ')).slice(0, 3).join(', ');
    attention.push({
      kind: 'flagged_session', severity: s.confusion_score >= 60 ? 'warning' : 'info',
      title: `Session scored ${100 - s.confusion_score}/100 reliability${names ? ` (${names})` : ''}`,
      detail: s.summary, session_id: s.id, href: `#session/${s.id}`, at: s.start_time, score: s.confusion_score,
    });
  }
  for (const t of failingTools) {
    const rate = Math.round((t.errors / t.total) * 100);
    if (rate < 25) continue;
    attention.push({
      kind: 'failing_tool', severity: rate >= 50 ? 'warning' : 'info',
      title: `${t.tool_name} failed ${rate}% of the time`, detail: `${t.errors} of ${t.total} calls in this window`,
      session_id: null, href: `#search/${encodeURIComponent(t.tool_name)}`, at: null,
    });
  }
  for (const f of churnedFiles) {
    if (f.edits < 8) continue;
    attention.push({
      kind: 'churned_file', severity: 'info',
      title: `${f.file_path.split('/').pop()} edited ${f.edits} times across ${f.sessions} session${f.sessions === 1 ? '' : 's'}`,
      detail: f.file_path, session_id: null, href: `#file/${encodeURIComponent(f.file_path)}`, at: null,
    });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  attention.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.at || '').localeCompare(a.at || ''));

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const warningCount = alerts.filter(a => a.severity === 'warning').length;
  const label = hours === 24 ? 'the last 24 hours' : hours === 24 * 7 ? 'the last 7 days' : `the last ${hours} hours`;
  const sessionsDelta = pct(cur.sessions, prev.sessions);
  const parts: string[] = [];
  let trend = '';
  if (sessionsDelta !== null && sessionsDelta !== 0 && prev.sessions > 0) {
    trend = sessionsDelta > 0 ? `, up from ${prev.sessions}` : `, down from ${prev.sessions}`;
  }
  parts.push(`${cur.sessions} session${cur.sessions === 1 ? '' : 's'} in ${label}${trend}.`);
  if (criticalCount || warningCount) {
    const bits: string[] = [];
    if (criticalCount) bits.push(`${criticalCount} critical alert${criticalCount === 1 ? '' : 's'}`);
    if (warningCount) bits.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
    parts.push(`${bits.join(' and ')} to review.`);
  } else if (cur.sessions > 0) {
    parts.push(cur.flagged ? `${cur.flagged} flagged for low reliability, nothing critical.` : 'Nothing needs attention.');
  }

  return {
    window_hours: hours,
    since,
    until,
    headline: parts.join(' '),
    metrics: {
      sessions: metric(cur.sessions, prev.sessions),
      tool_calls: metric(cur.tool_calls, prev.tool_calls),
      messages: metric(cur.messages, prev.messages),
      tokens: metric(cur.tokens, prev.tokens),
      cost: metric(Math.round(cur.cost * 10000) / 10000, Math.round(prev.cost * 10000) / 10000),
      errors: metric(cur.errors, prev.errors),
      flagged: metric(cur.flagged, prev.flagged),
    },
    attention: attention.slice(0, 25),
    alerts,
    failing_tools: failingTools.map(t => ({ ...t, rate: Math.round((t.errors / t.total) * 100) })),
    churned_files: churnedFiles,
    agents,
    series: [...byDay.values()],
    active_sessions: activeSessions,
  };
}

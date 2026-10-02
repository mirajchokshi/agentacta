import type Database from 'better-sqlite3';
import type {
  SessionRow,
  EventRow,
  InsightSignal,
  InsightResult,
  InsightsSummary,
  SessionInsightJoinedRow,
  AgentInsights,
  TopFlaggedSession,
  AlertRow,
  AlertSeverity,
} from './types.js';
import { buildTrace } from './tasks.js';

// ─── Detection helpers ───────────────────────────────────────────────

const SHELL_TOOLS = new Set(['Bash', 'bash', 'exec', 'shell', 'execute_command', 'run_command', 'terminal', 'container.exec', 'local_shell']);

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, label: 'rm -rf' },
  { re: /\bgit\s+push\b[^\n;&|]*\s(--force|-f)\b/, label: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'git clean -f' },
  { re: /\bgit\s+checkout\s+--\s+\./, label: 'git checkout -- .' },
  { re: /\bgit\s+branch\s+-D\b/, label: 'git branch -D' },
  { re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, label: 'DROP/TRUNCATE' },
  { re: /\bDELETE\s+FROM\s+\w+\s*;?\s*$/im, label: 'DELETE without WHERE' },
  { re: /\bkubectl\s+delete\b/, label: 'kubectl delete' },
  { re: /\bterraform\s+destroy\b/, label: 'terraform destroy' },
  { re: /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)\b/, label: 'docker prune/rm' },
  { re: /\bmkfs(\.\w+)?\b/, label: 'mkfs' },
  { re: /\bdd\s+if=.*\bof=\/dev\//, label: 'dd to device' },
  { re: /\bchmod\s+(-R\s+)?777\b/, label: 'chmod 777' },
  { re: /\bshutdown\b|\breboot\b/, label: 'shutdown/reboot' },
];

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, label: 'Anthropic API key' },
  { re: /\bsk-(proj-|live-|test-)?[A-Za-z0-9_-]{20,}/, label: 'API key (sk-)' },
  { re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, label: 'GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, label: 'Private key' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'JWT' },
];

const ERROR_TEXT = /^(\s*(error|fatal|traceback|panic:|exception|failed)\b)|\b(command not found|no such file or directory|permission denied|exit code [1-9]\d*|ENOENT|EACCES|ECONNREFUSED|segmentation fault|is not recognized as an internal|modulenotfounderror|syntaxerror|typeerror)\b/im;

function looksLikeError(ev: EventRow): boolean {
  if (ev.is_error) return true;
  const c = (ev.content || ev.tool_result || '').slice(0, 400);
  return ERROR_TEXT.test(c);
}

function shellCommandFromArgs(toolName: string | null, rawArgs: string | null): string | null {
  if (!toolName || !rawArgs || !SHELL_TOOLS.has(toolName)) return null;
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const cmd = args.command ?? args.cmd ?? args.script ?? args.input;
    if (typeof cmd === 'string') return cmd;
    if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  } catch { /* not JSON: treat the raw string as the command */ }
  return rawArgs;
}

function editedFilePath(toolName: string | null, rawArgs: string | null): string | null {
  if (!toolName || !rawArgs) return null;
  const lower = toolName.toLowerCase();
  if (!(lower === 'write' || lower === 'edit' || lower === 'multiedit' || lower.includes('write') || lower.includes('edit') || lower === 'apply_patch')) return null;
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const fp = args.file_path ?? args.path ?? args.filePath;
    return typeof fp === 'string' ? fp : null;
  } catch {
    return null;
  }
}

function callSignature(ev: EventRow): string {
  const raw = ev.tool_args || '';
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    const primary = args.command ?? args.cmd ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.prompt;
    if (typeof primary === 'string') return primary.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  } catch { /* fall through */ }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
}

function sameCall(a: EventRow, b: EventRow): boolean {
  return callSignature(a) === callSignature(b);
}

function sessionTokenVolume(s: SessionRow): number {
  if (s.total_tokens && s.total_tokens > 0) return s.total_tokens;
  return (s.input_tokens || 0) + (s.output_tokens || 0) + (s.cache_read_tokens || 0) + (s.cache_write_tokens || 0);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

interface TokenBaseline { median: number; count: number }
const tokenBaselineCache = new Map<string, { at: number; baseline: TokenBaseline }>();

function tokenBaseline(db: Database.Database, agent: string | null): TokenBaseline {
  const key = agent || '';
  const cached = tokenBaselineCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.baseline;
  const rows = db.prepare(
    'SELECT total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE COALESCE(agent, \'\') = ? ORDER BY start_time DESC LIMIT 500'
  ).all(key) as SessionRow[];
  const volumes = rows.map(sessionTokenVolume).filter(v => v > 0);
  const baseline = { median: median(volumes), count: volumes.length };
  tokenBaselineCache.set(key, { at: Date.now(), baseline });
  return baseline;
}

export function invalidateBaselines(): void {
  tokenBaselineCache.clear();
}

// ─── Per-session analysis ────────────────────────────────────────────

export function analyzeSession(db: Database.Database, sessionId: string): InsightResult | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session) return null;

  const events = db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC'
  ).all(sessionId) as EventRow[];

  const signals: InsightSignal[] = [];
  const toolCalls = events.filter((e: EventRow) => e.type === 'tool_call');

  // 1. tool_retry_loop: the same call (tool + near-identical arguments) repeated
  // 3+ times in a row. Comparing arguments, not just the tool name, keeps a
  // normal run of distinct shell commands from reading as a loop.
  if (toolCalls.length >= 3) {
    const worstStreakByTool: Record<string, number> = {};
    let consecutive = 1;
    const record = (idx: number): void => {
      if (consecutive >= 3) {
        const tool = toolCalls[idx].tool_name as string;
        if (!worstStreakByTool[tool] || consecutive > worstStreakByTool[tool]) worstStreakByTool[tool] = consecutive;
      }
    };
    for (let i = 1; i < toolCalls.length; i++) {
      if (toolCalls[i].tool_name === toolCalls[i - 1].tool_name && sameCall(toolCalls[i], toolCalls[i - 1])) {
        consecutive++;
      } else {
        record(i - 1);
        consecutive = 1;
      }
    }
    record(toolCalls.length - 1);
    for (const [tool, count] of Object.entries(worstStreakByTool)) {
      signals.push({ type: 'tool_retry_loop', tool, count });
    }
  }

  // 2. session_bail: >20 tool calls but no file write events
  if (toolCalls.length > 20) {
    const hasWrite = toolCalls.some((e: EventRow) =>
      e.tool_name && (e.tool_name === 'Write' || e.tool_name === 'Edit' ||
        e.tool_name.toLowerCase().includes('write') || e.tool_name.toLowerCase().includes('edit'))
    );
    if (!hasWrite) signals.push({ type: 'session_bail', tool_calls: toolCalls.length });
  }

  // 3. high_error_rate: >30% of tool results were errors
  const toolResults = events.filter((e: EventRow) => e.type === 'tool_result');
  if (toolResults.length >= 3) {
    const errorResults = toolResults.filter(looksLikeError);
    const errorRate: number = errorResults.length / toolResults.length;
    if (errorRate > 0.3) {
      signals.push({
        type: 'high_error_rate',
        error_count: errorResults.length,
        total: toolResults.length,
        rate: Math.round(errorRate * 100)
      });
    }
  }

  // 4. long_prompt_short_session: Initial prompt <15 words but >30 tool calls
  if (session.initial_prompt && toolCalls.length > 30) {
    const wordCount: number = session.initial_prompt.trim().split(/\s+/).length;
    if (wordCount < 15) {
      signals.push({ type: 'long_prompt_short_session', prompt_words: wordCount, tool_calls: toolCalls.length });
    }
  }

  // 5. no_completion: Last event is a tool call, not an assistant message
  if (events.length > 0) {
    const lastEvent: EventRow = events[events.length - 1];
    if (lastEvent.type === 'tool_call' || lastEvent.type === 'tool_result') {
      signals.push({ type: 'no_completion', last_event_type: lastEvent.type, last_tool: lastEvent.tool_name || null });
    }
  }

  // 6. destructive_command: shell commands that delete data or rewrite history
  {
    const found: string[] = [];
    let count = 0;
    for (const e of toolCalls) {
      const cmd = shellCommandFromArgs(e.tool_name, e.tool_args);
      if (!cmd) continue;
      for (const p of DESTRUCTIVE_PATTERNS) {
        if (p.re.test(cmd)) {
          count++;
          if (!found.includes(p.label) && found.length < 5) found.push(p.label);
          break;
        }
      }
    }
    if (count > 0) signals.push({ type: 'destructive_command', count, commands: found });
  }

  // 7. secret_exposure: credential-shaped strings in tool args or results
  {
    const kinds: string[] = [];
    let count = 0;
    for (const e of events) {
      if (e.type !== 'tool_call' && e.type !== 'tool_result') continue;
      const text = (e.type === 'tool_call' ? e.tool_args : (e.content || e.tool_result)) || '';
      if (!text) continue;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(text)) {
          count++;
          if (!kinds.includes(p.label) && kinds.length < 5) kinds.push(p.label);
          break;
        }
      }
    }
    if (count > 0) signals.push({ type: 'secret_exposure', count, kinds });
  }

  // 8. file_churn: the same file written/edited many times in one session
  {
    const edits = new Map<string, number>();
    for (const e of toolCalls) {
      const fp = editedFilePath(e.tool_name, e.tool_args);
      if (fp) edits.set(fp, (edits.get(fp) || 0) + 1);
    }
    let worst: [string, number] | null = null;
    for (const entry of edits) if (!worst || entry[1] > worst[1]) worst = entry;
    if (worst && worst[1] >= 6) signals.push({ type: 'file_churn', file: worst[0], edits: worst[1] });
  }

  // 9. token_outlier: this session used far more tokens than its agent's median
  {
    const volume = sessionTokenVolume(session);
    if (volume > 0) {
      const base = tokenBaseline(db, session.agent);
      if (base.count >= 5 && base.median > 0 && volume >= base.median * 4 && volume >= 50_000) {
        signals.push({ type: 'token_outlier', tokens: volume, median: base.median, multiple: Math.round((volume / base.median) * 10) / 10 });
      }
    }
  }

  // 10. unfinished_tasks / 11. subagent_storm: from the task trace
  {
    const children = db.prepare('SELECT * FROM sessions WHERE parent_session_id = ?').all(sessionId) as SessionRow[];
    const trace = buildTrace(session, events, children);
    const lastTs = events.length ? Date.parse(events[events.length - 1].timestamp) : NaN;
    const quietForMs = Number.isFinite(lastTs) ? Date.now() - lastTs : Infinity;
    if (trace.summary.has_plan && trace.summary.unfinished > 0 && quietForMs > 10 * 60_000) {
      signals.push({
        type: 'unfinished_tasks',
        total: trace.summary.total,
        unfinished: trace.summary.unfinished,
        titles: trace.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').slice(0, 3).map(t => t.title.slice(0, 80)),
      });
    }
    if (trace.summary.subagents >= 6) signals.push({ type: 'subagent_storm', count: trace.summary.subagents });
  }

  // Compute confusion_score — severity-scaled per signal
  function clamp(val: number, min: number, max: number): number { return Math.max(min, Math.min(max, val)); }
  function lerp(t: number, min: number, max: number): number { return min + clamp(t, 0, 1) * (max - min); }

  const seenTypes: Set<string> = new Set();
  let confusionScore: number = 0;
  for (const sig of signals) {
    if (seenTypes.has(sig.type)) continue;
    seenTypes.add(sig.type);

    switch (sig.type) {
      case 'tool_retry_loop': confusionScore += Math.round(lerp(clamp((sig.count - 3) / 7, 0, 1), 20, 40)); break;
      case 'session_bail': confusionScore += Math.round(lerp(clamp((sig.tool_calls - 20) / 40, 0, 1), 15, 30)); break;
      case 'high_error_rate': confusionScore += Math.round(lerp(clamp((sig.rate - 30) / 70, 0, 1), 10, 35)); break;
      case 'long_prompt_short_session': confusionScore += Math.round(lerp(clamp((sig.tool_calls - 30) / 50, 0, 1), 10, 20)); break;
      case 'no_completion': confusionScore += 10; break;
      case 'destructive_command': confusionScore += Math.round(lerp(clamp((sig.count - 1) / 4, 0, 1), 25, 40)); break;
      case 'secret_exposure': confusionScore += Math.round(lerp(clamp((sig.count - 1) / 4, 0, 1), 30, 45)); break;
      case 'file_churn': confusionScore += Math.round(lerp(clamp((sig.edits - 6) / 10, 0, 1), 10, 20)); break;
      case 'token_outlier': confusionScore += Math.round(lerp(clamp((sig.multiple - 4) / 8, 0, 1), 10, 20)); break;
      case 'unfinished_tasks': confusionScore += Math.round(lerp(clamp(sig.unfinished / Math.max(1, sig.total), 0, 1), 10, 20)); break;
      case 'subagent_storm': confusionScore += 10; break;
    }
  }
  confusionScore = Math.min(confusionScore, 100);

  const flagged: boolean = confusionScore >= 30;

  return {
    session_id: sessionId,
    signals,
    confusion_score: confusionScore,
    flagged,
    computed_at: new Date().toISOString()
  };
}

// ─── Alerts ──────────────────────────────────────────────────────────
// Alerts are the proactive layer on top of insights: a durable record that a
// session crossed a line worth telling a human about. One alert per
// (session, type); re-analysis never duplicates or re-fires it.

export function alertForSignal(sig: InsightSignal): { severity: AlertSeverity; title: string; detail: string } | null {
  switch (sig.type) {
    case 'destructive_command':
      return { severity: 'critical', title: `Destructive command run (${sig.commands.join(', ')})`, detail: `${sig.count} destructive shell command${sig.count === 1 ? '' : 's'} executed in this session.` };
    case 'secret_exposure':
      return { severity: 'critical', title: `Possible secret in transcript (${sig.kinds.join(', ')})`, detail: `${sig.count} credential-shaped string${sig.count === 1 ? '' : 's'} appeared in tool arguments or results.` };
    case 'high_error_rate':
      return { severity: 'warning', title: `${sig.rate}% of tool calls failed`, detail: `${sig.error_count} of ${sig.total} tool results looked like errors.` };
    case 'tool_retry_loop':
      return sig.count >= 6 ? { severity: 'warning', title: `${sig.tool} retried ${sig.count}× in a row`, detail: 'The agent appears to have been stuck in a retry loop.' } : null;
    case 'unfinished_tasks':
      return { severity: 'warning', title: `${sig.unfinished} of ${sig.total} planned tasks left unfinished`, detail: sig.titles.join(' · ') };
    case 'token_outlier':
      return { severity: 'warning', title: `Token use ${sig.multiple}× the usual for this agent`, detail: `${sig.tokens.toLocaleString()} tokens vs a median of ${sig.median.toLocaleString()}.` };
    case 'file_churn':
      return { severity: 'info', title: `${sig.file.split('/').pop()} rewritten ${sig.edits} times`, detail: sig.file };
    case 'subagent_storm':
      return { severity: 'info', title: `${sig.count} subagents spawned`, detail: 'Fan-out this wide is worth a look for duplicated work.' };
    default:
      return null;
  }
}

/** Persist alerts for a result. Returns only the alerts created by this call. */
export function syncAlerts(db: Database.Database, result: InsightResult): AlertRow[] {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO alerts (session_id, type, severity, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const created: AlertRow[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();
  for (const sig of result.signals) {
    if (seen.has(sig.type)) continue;
    seen.add(sig.type);
    const spec = alertForSignal(sig);
    if (!spec) continue;
    const info = insert.run(result.session_id, sig.type, spec.severity, spec.title, spec.detail, now);
    if (info.changes > 0) {
      const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(info.lastInsertRowid) as AlertRow;
      created.push(row);
    }
  }
  // A signal that cleared on re-analysis (e.g. a live session that recovered)
  // retracts its alert unless someone already acknowledged it.
  const present = [...seen];
  const placeholders = present.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM alerts WHERE session_id = ? AND acknowledged = 0${present.length ? ` AND type NOT IN (${placeholders})` : ''}`
  ).run(result.session_id, ...present);
  return created;
}

export function analyzeAll(db: Database.Database): InsightResult[] {
  invalidateBaselines();
  const sessions = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
  const results: InsightResult[] = [];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO session_insights
    (session_id, signals, confusion_score, flagged, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const runAll = db.transaction(() => {
    for (const s of sessions) {
      const result: InsightResult | null = analyzeSession(db, s.id);
      if (!result) continue;
      upsert.run(
        result.session_id,
        JSON.stringify(result.signals),
        result.confusion_score,
        result.flagged ? 1 : 0,
        result.computed_at
      );
      syncAlerts(db, result);
      results.push(result);
    }
  });

  runAll();
  return results;
}

export function getInsightsSummary(db: Database.Database): InsightsSummary {
  const rows = db.prepare(
    'SELECT si.*, s.summary, s.model, s.agent, s.start_time, s.tool_count, s.message_count FROM session_insights si JOIN sessions s ON s.id = si.session_id'
  ).all() as SessionInsightJoinedRow[];

  if (!rows.length) {
    return {
      total_sessions: 0,
      flagged_count: 0,
      flagged_percentage: 0,
      avg_confusion_score: 0,
      signal_counts: {},
      by_agent: {},
      top_flagged: []
    };
  }

  let totalScore: number = 0;
  let flaggedCount: number = 0;
  const signalCounts: Record<string, number> = {};
  const byAgent: Record<string, AgentInsights> = {};

  for (const row of rows) {
    totalScore += row.confusion_score;
    if (row.flagged) flaggedCount++;

    const signals: InsightSignal[] = JSON.parse(row.signals || '[]');
    const seenTypes: Set<string> = new Set();
    for (const sig of signals) {
      if (!seenTypes.has(sig.type)) {
        signalCounts[sig.type] = (signalCounts[sig.type] || 0) + 1;
        seenTypes.add(sig.type);
      }
    }

    const agent: string = row.agent || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { count: 0, flagged: 0, total_score: 0 };
    byAgent[agent].count++;
    if (row.flagged) byAgent[agent].flagged++;
    byAgent[agent].total_score += row.confusion_score;
  }

  for (const agent of Object.keys(byAgent)) {
    byAgent[agent].avg_score = Math.round(byAgent[agent].total_score / byAgent[agent].count);
  }

  const topFlagged: TopFlaggedSession[] = rows
    .filter((r: SessionInsightJoinedRow) => r.flagged)
    .sort((a: SessionInsightJoinedRow, b: SessionInsightJoinedRow) => b.confusion_score - a.confusion_score)
    .slice(0, 20)
    .map((r: SessionInsightJoinedRow): TopFlaggedSession => ({
      session_id: r.session_id,
      summary: r.summary,
      model: r.model,
      agent: r.agent,
      start_time: r.start_time,
      tool_count: r.tool_count,
      message_count: r.message_count,
      confusion_score: r.confusion_score,
      signals: JSON.parse(r.signals || '[]')
    }));

  return {
    total_sessions: rows.length,
    flagged_count: flaggedCount,
    flagged_percentage: rows.length ? Math.round((flaggedCount / rows.length) * 100) : 0,
    avg_confusion_score: Math.round(totalScore / rows.length),
    signal_counts: signalCounts,
    by_agent: byAgent,
    top_flagged: topFlagged
  };
}

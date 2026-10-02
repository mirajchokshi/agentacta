import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SessionRow, EventRow, InsightSignal, SessionInsightRow } from './types.js';
import { ChatGPTAuth, RESOURCE } from './chatgpt-auth.js';
import { buildTrace } from './tasks.js';
import { getDigest } from './digest.js';

// ─── AI briefs ───────────────────────────────────────────────────────
// Optional narrative layer on top of the deterministic insights. Uses the
// Responses API with the user's own ChatGPT plan (via Sign in with ChatGPT).
// Briefs are only generated on explicit request and cached by input hash so a
// repeat view costs nothing.

export interface BriefResult {
  scope: 'session' | 'digest';
  scope_key: string;
  brief: string;
  model: string;
  cached: boolean;
  created_at: string;
}

export interface AiOptions {
  auth: ChatGPTAuth;
  model?: string | null;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

interface ResponsesOutput {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

const PREFERRED_MODELS = ['gpt-5-mini', 'gpt-5.1-mini', 'gpt-5', 'gpt-5.1', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'];

export class AiBriefs {
  private readonly auth: ChatGPTAuth;
  private readonly configuredModel: string | null;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private modelCache: { at: number; ids: string[] } | null = null;

  constructor(opts: AiOptions) {
    this.auth = opts.auth;
    this.configuredModel = opts.model || null;
    this.apiBase = (opts.apiBase || RESOURCE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  async listModels(): Promise<string[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.ids;
    const { token } = await this.auth.getAccessToken();
    const res = await this.fetchImpl(`${this.apiBase}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Model discovery failed (${res.status})`);
    const doc = await res.json() as { data?: Array<{ id: string }> };
    const ids = (doc.data || []).map(m => m.id).filter(Boolean).sort();
    this.modelCache = { at: Date.now(), ids };
    return ids;
  }

  async resolveModel(): Promise<string> {
    if (this.configuredModel) return this.configuredModel;
    let ids: string[] = [];
    try { ids = await this.listModels(); } catch { /* fall back to a sensible default below */ }
    for (const candidate of PREFERRED_MODELS) if (ids.includes(candidate)) return candidate;
    const anyGpt = ids.find(id => /^gpt-/.test(id) && !/realtime|audio|image|tts|transcribe|search/.test(id));
    return anyGpt || PREFERRED_MODELS[0];
  }

  async complete(instructions: string, input: string, maxOutputTokens: number = 700): Promise<{ text: string; model: string }> {
    const { token } = await this.auth.getAccessToken();
    const model = await this.resolveModel();
    const res = await this.fetchImpl(`${this.apiBase}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions, input, max_output_tokens: maxOutputTokens, store: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const doc = await res.json().catch(() => ({})) as ResponsesOutput;
    if (!res.ok) {
      const msg = doc.error?.message || `HTTP ${res.status}`;
      throw new Error(`ChatGPT request failed: ${msg}`);
    }
    let text = doc.output_text || '';
    if (!text && Array.isArray(doc.output)) {
      text = doc.output
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .map(part => (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (!text) throw new Error('ChatGPT returned an empty response');
    return { text, model };
  }
}

// ─── Prompt construction ─────────────────────────────────────────────

function clip(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function buildSessionBriefInput(db: Database.Database, sessionId: string): { input: string; hash: string } | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session) return null;
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC').all(sessionId) as EventRow[];
  const children = db.prepare('SELECT * FROM sessions WHERE parent_session_id = ?').all(sessionId) as SessionRow[];
  const insight = db.prepare('SELECT * FROM session_insights WHERE session_id = ?').get(sessionId) as SessionInsightRow | undefined;
  const signals = insight ? JSON.parse(insight.signals || '[]') as InsightSignal[] : [];
  const trace = buildTrace(session, events, children);

  const toolCounts = new Map<string, number>();
  for (const e of events) if (e.type === 'tool_call' && e.tool_name) toolCounts.set(e.tool_name, (toolCounts.get(e.tool_name) || 0) + 1);
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n}×${c}`).join(', ');

  const errors = events.filter(e => e.type === 'tool_result' && e.is_error).slice(0, 5)
    .map(e => `- ${e.tool_name || 'tool'}: ${clip((e.content || '').replace(/\s+/g, ' '), 240)}`);
  const files = db.prepare('SELECT file_path, operation, COUNT(*) AS c FROM file_activity WHERE session_id = ? GROUP BY file_path, operation ORDER BY c DESC LIMIT 12').all(sessionId) as Array<{ file_path: string; operation: string; c: number }>;
  const userMessages = events.filter(e => e.type === 'message' && e.role === 'user').map(e => clip(e.content || '', 400));
  const lastAssistant = [...events].reverse().find(e => e.type === 'message' && e.role === 'assistant');

  const lines: string[] = [];
  lines.push(`SESSION ${session.id}`);
  lines.push(`agent=${session.agent || 'unknown'} model=${session.model || 'unknown'} start=${session.start_time} end=${session.end_time || 'ongoing'}`);
  lines.push(`messages=${session.message_count} tool_calls=${session.tool_count} tokens=${session.total_tokens || (session.input_tokens + session.output_tokens)} cost=$${(session.total_cost || 0).toFixed(4)}`);
  lines.push(`reliability_score=${insight ? 100 - insight.confusion_score : 'n/a'} signals=${signals.map(s => s.type).join(',') || 'none'}`);
  lines.push('');
  lines.push('USER REQUESTS (in order):');
  for (const [i, m] of userMessages.slice(0, 6).entries()) lines.push(`${i + 1}. ${m}`);
  if (userMessages.length > 6) lines.push(`… and ${userMessages.length - 6} more`);
  lines.push('');
  if (trace.tasks.length) {
    lines.push('PLANNED TASKS:');
    for (const t of trace.tasks.slice(0, 15)) lines.push(`- [${t.status}] ${clip(t.title, 120)} (tool_calls=${t.tool_calls}, errors=${t.errors})`);
    lines.push('');
  }
  if (trace.subagents.length) {
    lines.push(`SUBAGENTS: ${trace.subagents.slice(0, 8).map(s => `${clip(s.title, 60)} [${s.status}]`).join('; ')}`);
    lines.push('');
  }
  lines.push(`TOP TOOLS: ${topTools || 'none'}`);
  if (files.length) lines.push(`FILES: ${files.map(f => `${f.file_path.split('/').slice(-2).join('/')} (${f.operation}×${f.c})`).join(', ')}`);
  if (errors.length) { lines.push(''); lines.push('ERROR SAMPLES:'); lines.push(...errors); }
  if (signals.length) { lines.push(''); lines.push('DETECTED SIGNALS:'); for (const s of signals) lines.push(`- ${JSON.stringify(s)}`); }
  if (lastAssistant) { lines.push(''); lines.push('LAST ASSISTANT MESSAGE:'); lines.push(clip(lastAssistant.content || '', 1200)); }

  const input = lines.join('\n').slice(0, 14_000);
  const hash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
  return { input, hash };
}

const SESSION_INSTRUCTIONS = `You are reviewing one AI coding-agent session log on behalf of its human owner. Write a concise "session brief" in Markdown with exactly these sections:
**What was asked** (1-2 sentences)
**What actually happened** (2-4 sentences: outcome, key files or tools, whether planned tasks finished)
**Risks & problems** (bullets; be concrete and cite tool names, files or error text; say "None observed" if clean)
**Suggested follow-ups** (up to 3 short bullets)
Stay under 200 words. Only state things supported by the log; never invent commands, files or results.`;

const DIGEST_INSTRUCTIONS = `You are the daily briefing writer for someone who runs several AI coding agents. From the structured digest, write a short briefing in Markdown: a one-line headline in bold, then 3-6 bullets covering what changed versus the previous period, anything critical or risky (name the session summaries), tools or files that are causing trouble, and one concrete recommendation. Under 160 words. Only use facts present in the digest.`;

export function buildDigestBriefInput(db: Database.Database, hours: number): { input: string; hash: string } {
  const digest = getDigest(db, hours);
  const compact = {
    window_hours: digest.window_hours,
    headline: digest.headline,
    metrics: digest.metrics,
    alerts: digest.alerts.slice(0, 10).map(a => ({ severity: a.severity, title: a.title, session: clip(a.summary, 100), agent: a.agent })),
    attention: digest.attention.slice(0, 10).map(a => ({ kind: a.kind, severity: a.severity, title: a.title, detail: clip(a.detail, 120) })),
    failing_tools: digest.failing_tools,
    churned_files: digest.churned_files,
    agents: digest.agents,
    active_sessions: digest.active_sessions.map(s => ({ agent: s.agent, summary: clip(s.summary, 100) })),
  };
  const input = JSON.stringify(compact, null, 1).slice(0, 12_000);
  // Hash on the stable parts only so the cache survives the clock moving.
  const hash = crypto.createHash('sha256').update(JSON.stringify({ m: compact.metrics, a: compact.alerts, t: compact.attention })).digest('hex').slice(0, 16);
  return { input, hash };
}

export async function generateBrief(db: Database.Database, ai: AiBriefs, scope: 'session' | 'digest', key: string, force: boolean = false): Promise<BriefResult | null> {
  const built = scope === 'session' ? buildSessionBriefInput(db, key) : buildDigestBriefInput(db, parseFloat(key) || 24);
  if (!built) return null;
  const scopeKey = scope === 'session' ? key : String(parseFloat(key) || 24);

  const cached = db.prepare('SELECT * FROM ai_briefs WHERE scope = ? AND scope_key = ?').get(scope, scopeKey) as
    { input_hash: string; model: string | null; brief: string; created_at: string } | undefined;
  if (cached && !force && cached.input_hash === built.hash) {
    return { scope, scope_key: scopeKey, brief: cached.brief, model: cached.model || '', cached: true, created_at: cached.created_at };
  }

  const { text, model } = await ai.complete(scope === 'session' ? SESSION_INSTRUCTIONS : DIGEST_INSTRUCTIONS, built.input, scope === 'session' ? 700 : 600);
  const createdAt = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO ai_briefs (scope, scope_key, input_hash, model, brief, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, scopeKey, built.hash, model, text, createdAt);
  return { scope, scope_key: scopeKey, brief: text, model, cached: false, created_at: createdAt };
}

export function getCachedBrief(db: Database.Database, scope: 'session' | 'digest', key: string): BriefResult | null {
  const scopeKey = scope === 'session' ? key : String(parseFloat(key) || 24);
  const cached = db.prepare('SELECT * FROM ai_briefs WHERE scope = ? AND scope_key = ?').get(scope, scopeKey) as
    { model: string | null; brief: string; created_at: string } | undefined;
  return cached ? { scope, scope_key: scopeKey, brief: cached.brief, model: cached.model || '', cached: true, created_at: cached.created_at } : null;
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import type {
  AgentActaConfig,
  SessionRow,
  EventRow,
  AttributedEvent,
  DbSize,
  ParsedQuery,
  SearchEventRow,
  TimelineEventRow,
  CountRow,
  SessionDir,
  InsightResult,
  InsightsSummary,
  SessionInsightRow,
  ArchiveRow,
  FileActivityRow,
  FileActivityAggRow,
  FileSessionRow,
} from './types.js';
import { loadConfig } from './config.js';
import { open, init } from './db.js';
import { discoverSessionDirs } from './indexer.js';
import type { WorkerMessage } from './index-worker.js';
import { attributeEventDelta } from './project-attribution.js';
import { loadDeltaAttributionContext } from './delta-attribution-context.js';
import { analyzeSession, getInsightsSummary } from './insights.js';
import { isValidDateKey, resolveStaticPath } from './http-utils.js';
import { withStatus, attachChildren } from './session-status.js';
import { loadSessionEvents, loadOlderSessionEvents } from './session-detail.js';
import { quickSearch, toFtsQuery } from './search.js';

// --version / -v flag: print version and exit
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string };
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

// --demo flag: use demo session data (must run before config load)
if (process.argv.includes('--demo')) {
  const demoDir: string = path.join(__dirname, '..', 'demo');
  if (!fs.existsSync(demoDir) || fs.readdirSync(demoDir).filter((f: string) => f.endsWith('.jsonl')).length === 0) {
    console.error('Demo data not found. Run: node scripts/seed-demo.js');
    process.exit(1);
  }
  process.env.AGENTACTA_SESSIONS_PATH = demoDir;
  process.env.AGENTACTA_DB_PATH = path.join(demoDir, 'demo.db');
  process.env.AGENTACTA_DEMO_MODE = '1'; // signal to config.js to skip file-based sessionsPath
  console.log(`Demo mode: using sessions from ${demoDir}`);
}

const config: AgentActaConfig = loadConfig();
const PORT: number = config.port;
const HOST: string = process.env.AGENTACTA_HOST || '127.0.0.1';
const AUTH_TOKEN: string = (config.authToken || '').trim();
const ARCHIVE_MODE: boolean = config.storage === 'archive';

console.log(`AgentActa running in ${config.storage} mode`);

const PUBLIC: string = path.join(__dirname, '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function acceptsGzip(req: http.IncomingMessage | undefined): boolean {
  const ae = req?.headers['accept-encoding'];
  return typeof ae === 'string' && /\bgzip\b/.test(ae);
}

// Session payloads are large, repetitive JSON (a long session is several MB);
// gzip cuts them ~10x, which is most of the wait on a phone over Wi-Fi.
function json(res: http.ServerResponse, data: unknown, status: number = 200): void {
  const body: string = JSON.stringify(data);
  if (body.length > 1024 && acceptsGzip(res.req)) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
    res.end(zlib.gzipSync(body, { level: 4 }));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function isLoopbackHost(host: string): boolean {
  const normalized: string = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function parseCookie(header: string | undefined, key: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...valueParts] = part.trim().split('=');
    if (rawName === key) {
      try {
        return decodeURIComponent(valueParts.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function getPresentedToken(req: http.IncomingMessage, query: Record<string, string>): string {
  const authorization: string = req.headers.authorization || '';
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  const headerToken: string | string[] | undefined = req.headers['x-agentacta-token'];
  if (typeof headerToken === 'string') return headerToken.trim();
  if (query.token) return query.token;
  return parseCookie(req.headers.cookie, 'agentacta_token') || '';
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, query: Record<string, string>): boolean {
  if (!AUTH_TOKEN) return true;
  const presentedToken: string = getPresentedToken(req, query);
  if (presentedToken && presentedToken === AUTH_TOKEN) {
    if (query.token) {
      res.setHeader('Set-Cookie', `agentacta_token=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Lax; Path=/`);
    }
    return true;
  }
  json(res, { error: 'Unauthorized' }, 401);
  return false;
}

function download(res: http.ServerResponse, data: unknown, filename: string, contentType: string): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function requireMethod(req: http.IncomingMessage, res: http.ServerResponse, method: string): boolean {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  json(res, { error: 'Method not allowed' }, 405);
  return false;
}

// Static files are small and change only on deploy: keep each one (and its
// gzip) in memory keyed by mtime, and answer revalidations with 304 via ETag.
// no-cache keeps every load checking in, so a deploy is picked up at once.
const staticCache: Map<string, { mtimeMs: number; size: number; etag: string; body: Buffer; gz: Buffer | null }> = new Map();

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, fp: string, stat: fs.Stats): void {
  const type: string = MIME[path.extname(fp)] || 'application/octet-stream';
  let entry = staticCache.get(fp);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    const body: Buffer = fs.readFileSync(fp);
    const compressible: boolean = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/.test(type);
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`, body, gz: compressible ? zlib.gzipSync(body, { level: 9 }) : null };
    staticCache.set(fp, entry);
  }
  const headers: Record<string, string> = { 'Content-Type': type, 'ETag': entry.etag, 'Cache-Control': 'no-cache' };
  if (entry.gz) headers['Vary'] = 'Accept-Encoding';
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return; }
  if (entry.gz && acceptsGzip(req)) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    res.end(entry.gz);
    return;
  }
  res.writeHead(200, headers);
  res.end(entry.body);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const reqUrl: string = req.url || '/';
  const fp: string | null = resolveStaticPath(PUBLIC, reqUrl.split('?')[0]);
  if (!fp) { res.writeHead(403); res.end(); return true; }
  let stat: fs.Stats;
  try { stat = fs.statSync(fp); } catch { return false; }
  if (!stat.isFile()) return false;
  sendFile(req, res, fp, stat);
  return true;
}

function parseQuery(url: string): ParsedQuery {
  const u: URL = new URL(url, 'http://localhost');
  const o: Record<string, string> = {};
  u.searchParams.forEach((v: string, k: string) => { o[k] = v; });
  return { pathname: u.pathname, query: o };
}

function sessionToMarkdown(session: SessionRow, events: EventRow[]): string {
  let md: string = `# Session: ${session.id}\n`;
  md += `- **Start:** ${session.start_time}\n`;
  md += `- **End:** ${session.end_time || 'N/A'}\n`;
  md += `- **Model:** ${session.model || 'N/A'}\n`;
  md += `- **Agent:** ${session.agent || 'main'}\n`;
  md += `- **Messages:** ${session.message_count} | **Tools:** ${session.tool_count}\n`;
  md += `- **Cost:** $${(session.total_cost || 0).toFixed(4)} | **Tokens:** ${(session.total_tokens || 0).toLocaleString()}\n\n`;
  md += `## Summary\n${session.summary || 'No summary'}\n\n## Events\n\n`;
  for (const e of events) {
    const time: string = e.timestamp ? new Date(e.timestamp).toISOString() : '';
    if (e.type === 'tool_call') {
      md += `### [${time}] Tool: ${e.tool_name}\n\`\`\`json\n${e.tool_args || ''}\n\`\`\`\n\n`;
    } else if (e.type === 'tool_result') {
      md += `### [${time}] Result: ${e.tool_name}\n\`\`\`\n${(e.content || '').slice(0, 2000)}\n\`\`\`\n\n`;
    } else {
      md += `### [${time}] ${e.role || e.type}\n${e.content || ''}\n\n`;
    }
  }
  return md;
}

function getDbSize(): DbSize {
  try {
    const stat: fs.Stats = fs.statSync(config.dbPath);
    const mb: number = stat.size / (1024 * 1024);
    return { bytes: stat.size, display: mb >= 1 ? `${mb.toFixed(1)} MB` : `${(stat.size / 1024).toFixed(1)} KB` };
  } catch {
    return { bytes: 0, display: 'N/A' };
  }
}

function relativeTime(ts: string | null): string | null {
  if (!ts) return null;
  const diff: number = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function normalizeAgentLabel(agent: string | null): string | null {
  if (!agent) return agent;
  if (agent === 'main') return 'openclaw-main';
  if (agent.startsWith('claude-') || agent.startsWith('claude--')) return 'claude-code';
  return agent;
}

function looksLikeSessionId(q: string): boolean {
  const s: string = (q || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseEventCursor(cursor: string | undefined, fallbackAfter: string, fallbackAfterId?: string): { after: string; afterId: string | null } {
  const raw: string = (cursor || '').trim();
  if (!raw) return { after: fallbackAfter, afterId: fallbackAfterId || null };
  const sep: number = raw.indexOf('|');
  if (sep === -1) return { after: raw, afterId: null };
  return { after: raw.slice(0, sep), afterId: raw.slice(sep + 1) };
}

function formatEventCursor(row: EventRow): string {
  return `${row.timestamp}|${row.id}`;
}

// Init DB and start watcher
init();
const db: Database.Database = open();
db.pragma('busy_timeout = 5000'); // the indexer worker writes on its own connection

// SSE emitter: notifies connected clients when a session is re-indexed
const sseEmitter: EventEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100);

const sessionDirs: SessionDir[] = discoverSessionDirs(config);

// Indexing, watching and insight scoring run in a worker so a long re-parse
// never holds up a request. The server answers from what is already indexed;
// only a first run (nothing indexed yet) waits for the worker's first pass.
let indexReady: boolean = false;
const firstRun: boolean = !db.prepare('SELECT 1 FROM sessions LIMIT 1').get();
const indexReadyWaiters: Array<() => void> = [];
const reindexRequests: Map<number, (m: Extract<WorkerMessage, { type: 'reindexed' }>) => void> = new Map();
let nextReindexId: number = 1;
const workerFile: string = path.join(__dirname, 'index-worker' + path.extname(__filename));
let indexWorker: Worker;
let shuttingDown: boolean = false;
function startIndexWorker(): void {
  // Under tsx (npm run dev, tests) the worker needs tsx's loader registered itself.
  const worker: Worker = workerFile.endsWith('.ts')
    ? new Worker(`require('tsx/cjs/api').register(); require(${JSON.stringify(workerFile)});`, { eval: true })
    : new Worker(workerFile);
  indexWorker = worker;
  worker.unref();
  worker.on('message', (m: WorkerMessage) => {
    if (m.type === 'ready') {
      indexReady = true;
      console.log(`Index up to date (${m.changed} changed, ${m.ms} ms)`);
      for (const fn of indexReadyWaiters.splice(0)) fn();
    } else if (m.type === 'updated') {
      for (const id of m.ids) sseEmitter.emit('session-update', id);
    } else if (m.type === 'reindexed') {
      reindexRequests.get(m.requestId)?.(m);
      reindexRequests.delete(m.requestId);
    }
  });
  worker.on('error', (err: Error) => console.error('Indexer error:', err.message));
  // A dead worker would leave reindex calls hanging and live updates silent:
  // fail what was waiting on it and start a new one (which re-runs the pass).
  worker.on('exit', (code: number) => {
    if (shuttingDown) return;
    console.error(`Indexer stopped (exit ${code}); restarting in 2s`);
    indexReady = true;
    for (const fn of indexReadyWaiters.splice(0)) fn();
    for (const [requestId, done] of reindexRequests) done({ type: 'reindexed', requestId, error: 'Indexer restarted' });
    reindexRequests.clear();
    setTimeout(startIndexWorker, 2000).unref();
  });
}
startIndexWorker();

const SESSION_SELECT: string = 'SELECT s.* FROM sessions s';
const sessionSortKey = (r: { end_time: string | null; start_time: string }): string => r.end_time || r.start_time || '';

// All descendants of the given sessions (UNION de-duplicates, so a parent cycle terminates).
function loadDescendants(rootIds: string[], nowMs: number) {
  if (!rootIds.length) return [];
  const rows = db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM sessions WHERE parent_id IN (SELECT value FROM json_each(?))
       UNION
       SELECT c.id FROM sessions c JOIN tree t ON c.parent_id = t.id
     )
     ${SESSION_SELECT} WHERE s.id IN (SELECT id FROM tree)`
  ).all(JSON.stringify(rootIds)) as SessionRow[];
  return rows.map(r => withStatus(r, nowMs));
}

const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
  // First run: hold data requests until the first pass has filled the index.
  if (firstRun && !indexReady && (req.url || '').startsWith('/api/') && !(req.url || '').startsWith('/api/health')) {
    indexReadyWaiters.push(() => handleRequest(req, res));
    return;
  }
  handleRequest(req, res);
});

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const { pathname, query }: ParsedQuery = parseQuery(req.url || '/');

  try {
    if (!requireAuth(req, res, query)) return;

    if (pathname === '/api/reindex') {
      if (!requireMethod(req, res, 'POST')) return;
      const requestId: number = nextReindexId++;
      reindexRequests.set(requestId, (m) => {
        if (m.error || !m.result) return json(res, { error: m.error || 'Reindex failed' }, 500);
        json(res, { ok: true, sessions: m.result.sessions, events: m.result.events });
      });
      indexWorker.postMessage({ type: 'reindex', requestId });
      return;
    }

    else if (pathname === '/api/health') {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string };
      const sessions: number = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
      const dbSize: DbSize = getDbSize();
      return json(res, {
        status: 'ok',
        version: pkg.version,
        uptime: Math.round(process.uptime()),
        indexing: !indexReady,
        sessions,
        dbSizeBytes: dbSize.bytes,
        node: process.version
      });
    }

    else if (pathname === '/api/config') {
      const dbSize: DbSize = getDbSize();
      const archiveCount: number = (db.prepare('SELECT COUNT(*) as c FROM archive').get() as CountRow).c;
      json(res, {
        storage: config.storage,
        port: config.port,
        dbPath: config.dbPath,
        dbSize: dbSize,
        sessionsPath: config.sessionsPath,
        sessionDirs: sessionDirs.map((d: SessionDir) => ({ path: d.path, agent: d.agent })),
        archiveEnabled: ARCHIVE_MODE,
        archiveRows: archiveCount
      });
    }
    else if (pathname === '/api/suggestions') {
      // Top tool names (most used)
      const tools: string[] = (db.prepare("SELECT tool_name, COUNT(*) as c FROM events WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC LIMIT 5").all() as Array<{ tool_name: string; c: number }>).map((r) => r.tool_name);
      // Most touched files (short basenames)
      const files: string[] = (db.prepare("SELECT file_path, COUNT(*) as c FROM file_activity GROUP BY file_path ORDER BY c DESC LIMIT 5").all() as Array<{ file_path: string; c: number }>).map((r) => {
        const parts: string[] = r.file_path.split('/');
        return parts[parts.length - 1];
      }).filter((f: string) => f.length <= 25);
      // Recent session summary words (crude topic extraction)
      const summaries: string = (db.prepare("SELECT summary FROM sessions WHERE summary IS NOT NULL ORDER BY start_time DESC LIMIT 20").all() as Array<{ summary: string }>).map((r) => r.summary).join(' ');
      const wordFreq: Record<string, number> = {};
      const stopWords: Set<string> = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','is','it','that','this','with','was','are','be','has','had','not','no','from','by','as','do','if','so','up','out','then','than','into','its','my','we','he','she','they','you','i','me','all','just','can','will','about','been','have','some','when','would','there','what','which','who','how','each','other','new','old','also','back','after','use','two','way','could','make','like','time','very','your','did','get','made','find','here','thing','many','well','only','any','those','over','such','our','them','his','her','one','file','files','session','sessions','agent','tool','message','messages','run','work','set','used','added','updated','using','based','check','cst','est','pst','tue','wed','thu','fri','sat','sun','mon','jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec','via','per','yet','ago','etc','got']);
      summaries.toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter((w: string) => w.length > 3 && w.length < 20 && !stopWords.has(w) && !/id$/.test(w)).forEach((w: string) => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
      const topics: string[] = Object.entries(wordFreq).sort((a: [string, number], b: [string, number]) => b[1] - a[1]).slice(0, 5).map((e: [string, number]) => e[0]);
      // Deduplicate and pick up to 8
      const seen: Set<string> = new Set();
      const suggestions: string[] = [];
      for (const s of [...tools, ...topics, ...files]) {
        const key: string = s.toLowerCase();
        if (!seen.has(key) && suggestions.length < 8) { seen.add(key); suggestions.push(s); }
      }
      json(res, { suggestions });
    }
    else if (pathname === '/api/activity') {
      // Per local day for the last N days: events, tool calls, sessions with
      // activity, and the same per agent. tz is the browser's getTimezoneOffset()
      // (minutes behind UTC) so "today" means the viewer's day.
      const days: number = Math.min(Math.max(parseInt(query.days) || 14, 1), 400);
      const tz: number = Math.max(-840, Math.min(840, parseInt(query.tz) || 0));
      const shift: string = `${-tz} minutes`;
      const since: string = new Date(Date.now() - (days + 1) * 86400000).toISOString();
      // One pass over the covering index, per (local day, session); days, agents
      // and distinct-session counts are all folded from it here.
      const rows = db.prepare(
        `SELECT date(timestamp, ?) AS day, session_id, COUNT(*) AS events, SUM(type = 'tool_call') AS tool_calls,
                SUM(type = 'message') AS messages
         FROM events WHERE timestamp >= ? GROUP BY day, session_id`
      ).all(shift, since) as Array<{ day: string; session_id: string; events: number; tool_calls: number; messages: number }>;
      const agentOf = new Map<string, string>();
      for (const r of db.prepare('SELECT id, agent FROM sessions').all() as Array<{ id: string; agent: string | null }>) {
        agentOf.set(r.id, normalizeAgentLabel(r.agent) || 'unknown');
      }
      const local = (d: Date): string => new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
      const today: string = local(new Date());
      const dayKeys: string[] = [];
      for (let i = days - 1; i >= 0; i--) dayKeys.push(local(new Date(Date.now() - i * 86400000)));
      const inWindow: Set<string> = new Set(dayKeys);
      const byDay = new Map<string, { events: number; toolCalls: number; messages: number; sessions: number }>();
      const agents = new Map<string, { agent: string; events: number; toolCalls: number; sessions: number; todayEvents: number; todaySessions: number }>();
      const agentSessions = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!inWindow.has(r.day)) continue;
        const d = byDay.get(r.day) || { events: 0, toolCalls: 0, messages: 0, sessions: 0 };
        d.events += r.events; d.toolCalls += r.tool_calls; d.messages += r.messages; d.sessions++;
        byDay.set(r.day, d);
        const name: string = agentOf.get(r.session_id) || 'unknown';
        const a = agents.get(name) || { agent: name, events: 0, toolCalls: 0, sessions: 0, todayEvents: 0, todaySessions: 0 };
        a.events += r.events; a.toolCalls += r.tool_calls;
        if (r.day === today) { a.todayEvents += r.events; a.todaySessions++; }
        agents.set(name, a);
        // Distinct sessions per agent over the window (a session spanning two days counts once).
        const seen = agentSessions.get(name) || new Set<string>();
        seen.add(r.session_id);
        agentSessions.set(name, seen);
      }
      for (const [name, seen] of agentSessions) agents.get(name)!.sessions = seen.size;
      const series = dayKeys.map(day => ({ day, events: 0, toolCalls: 0, messages: 0, sessions: 0, ...byDay.get(day) }));
      json(res, { today, days: series, agents: [...agents.values()].sort((x, y) => y.events - x.events) });
    }
    else if (pathname === '/api/stats') {
      const sessions: number = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
      const events: number = (db.prepare('SELECT COUNT(*) as c FROM events').get() as CountRow).c;
      const messages: number = (db.prepare("SELECT COUNT(*) as c FROM events WHERE type='message'").get() as CountRow).c;
      const toolCalls: number = (db.prepare("SELECT COUNT(*) as c FROM events WHERE type='tool_call'").get() as CountRow).c;
      const tools: string[] = (db.prepare("SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL").all() as Array<{ tool_name: string }>).map((r) => r.tool_name);
      const dateRange = db.prepare('SELECT MIN(start_time) as earliest, MAX(start_time) as latest FROM sessions').get() as { earliest: string | null; latest: string | null };
      const costData = db.prepare('SELECT SUM(total_cost) as cost, SUM(total_tokens) as tokens FROM sessions').get() as { cost: number | null; tokens: number | null };
      const agents: string[] = [...new Set(
        (db.prepare('SELECT DISTINCT agent FROM sessions WHERE agent IS NOT NULL').all() as Array<{ agent: string }>)
          .map((r) => normalizeAgentLabel(r.agent))
          .filter((a): a is string => a !== null)
      )];
      const dbSize: DbSize = getDbSize();
      json(res, { sessions, events, messages, toolCalls, uniqueTools: tools.length, tools, dateRange, totalCost: costData.cost || 0, totalTokens: costData.tokens || 0, agents, storageMode: config.storage, dbSize, sessionDirs: sessionDirs.map((d: SessionDir) => ({ path: d.path, agent: d.agent })) });
    }
    else if (pathname === '/api/sessions') {
      const limit: number = parseInt(query.limit) || 50;
      const offset: number = parseInt(query.offset) || 0;
      const agent: string = query.agent || '';
      // roots=1: only top-level sessions, each with its subagent tree attached.
      // A child whose parent was never indexed is shown as a root.
      const rootsOnly: boolean = query.roots === '1';
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (agent) { where.push('s.agent = ?'); params.push(agent); }
      if (rootsOnly) where.push('(s.parent_id IS NULL OR s.parent_id NOT IN (SELECT id FROM sessions))');
      const whereSql: string = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const nowMs: number = Date.now();
      // In roots mode a group sorts by its most recent activity, parent or child,
      // so a quiet parent with a busy subagent stays near the top.
      const orderBy: string = rootsOnly
        ? `MAX(COALESCE(s.end_time, s.start_time), COALESCE((SELECT MAX(COALESCE(c.end_time, c.start_time)) FROM sessions c WHERE c.parent_id = s.id), ''))`
        : 'COALESCE(s.end_time, s.start_time)';
      // id breaks ties so offset pages never overlap or skip rows.
      const rows = (db.prepare(`${SESSION_SELECT}${whereSql} ORDER BY ${orderBy} DESC, s.id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as SessionRow[]).map(r => withStatus(r, nowMs));
      const total: number = (db.prepare(`SELECT COUNT(*) as c FROM sessions s${whereSql}`).get(...params) as CountRow).c;
      const sessions = rootsOnly
        ? attachChildren(rows, loadDescendants(rows.map(r => r.id), nowMs), sessionSortKey)
        : rows;
      json(res, { sessions, total, limit, offset });
    }

    else if (pathname.match(/^\/api\/sessions\/[^/]+\/events$/)) {
      const id: string = pathname.split('/')[3];
      const session: SessionRow | undefined = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (!session) return json(res, { error: 'Not found' }, 404);

      const after: string = query.after || '1970-01-01T00:00:00.000Z';
      const afterId: string = query.afterId || '';
      const limit: number = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
      const rows: EventRow[] = db.prepare(
        `SELECT * FROM events
         WHERE session_id = ?
           AND (timestamp > ? OR (timestamp = ? AND id > ?))
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`
      ).all(id, after, after, afterId, limit) as EventRow[];
      const contextRows: EventRow[] = loadDeltaAttributionContext(db, id, rows);
      const events: AttributedEvent[] = attributeEventDelta(session, rows, contextRows);
      json(res, { events, after, afterId, count: events.length });
    }

    else if (pathname.match(/^\/api\/sessions\/[^/]+\/stream$/)) {
      const id: string = pathname.split('/')[3];
      const session: SessionRow | undefined = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (!session) return json(res, { error: 'Not found' }, 404);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      let cursor = parseEventCursor(req.headers['last-event-id'] as string | undefined, query.after || new Date().toISOString(), query.afterId || '');

      const onUpdate = (sessionId: string): void => {
        if (sessionId !== id) return;
        try {
          const rows: EventRow[] = cursor.afterId === null
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
            const contextRows: EventRow[] = loadDeltaAttributionContext(db, id, rows);
            const attributedRows: AttributedEvent[] = attributeEventDelta(session, rows, contextRows);
            const tail: EventRow = rows[rows.length - 1];
            cursor = { after: tail.timestamp, afterId: tail.id };
            res.write(`id: ${formatEventCursor(tail)}\ndata: ${JSON.stringify(attributedRows)}\n\n`);
          }
        } catch (err: unknown) {
          console.error('SSE query error:', (err as Error).message);
        }
      };

      sseEmitter.on('session-update', onUpdate);

      const ping: NodeJS.Timeout = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 30000);

      req.on('close', () => {
        sseEmitter.off('session-update', onUpdate);
        clearInterval(ping);
      });
    }
    else if (pathname.match(/^\/api\/sessions\/[^/]+$/) && !pathname.includes('export')) {
      const id: string = pathname.split('/')[3];
      const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
      if (!row) { json(res, { error: 'Not found' }, 404); }
      else if (query.before) {
        // ?before=<timestamp>|<id>&limit=N: the next N older events while scrolling.
        const cursor = parseEventCursor(query.before, '');
        const limit: number = Math.min(Math.max(parseInt(query.limit) || 500, 1), 2000);
        const older = loadOlderSessionEvents(db, withStatus(row, Date.now()), { timestamp: cursor.after, id: cursor.afterId || '' }, limit)
          .map(({ session_id: _sid, tool_result: _tr, project_confidence: _pc, ...e }) => e);
        json(res, { events: older, hasMore: older.length === limit });
      }
      else {
        const nowMs: number = Date.now();
        const session = withStatus(row, nowMs);
        const hasArchive: boolean = ARCHIVE_MODE && (db.prepare('SELECT COUNT(*) as c FROM archive WHERE session_id = ?').get(id) as CountRow).c > 0;
        const parentRow = session.parent_id
          ? db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(session.parent_id) as SessionRow | undefined
          : undefined;
        const parent = parentRow ? withStatus(parentRow, nowMs) : null;
        const [tree] = attachChildren([{ ...session }], loadDescendants([id], nowMs), sessionSortKey);
        // ?limit=N sends only the newest N events, without fields the page never
        // reads (the page fetches the rest when needed); the shape and project
        // filters still cover every event. Without limit, events are unchanged.
        const limit: number = parseInt(query.limit) || 0;
        const detail = loadSessionEvents(db, session, limit);
        const page = limit > 0
          ? detail.events.map(({ session_id: _sid, tool_result: _tr, project_confidence: _pc, ...e }) => e)
          : detail.events;
        json(res, { session, parent, children: tree.children || [], events: page, eventTotal: detail.eventTotal, shape: detail.shape, projectFilters: detail.projectFilters, hasArchive });
      }
    }
    else if (pathname.match(/^\/api\/archive\/session\/[^/]+$/)) {
      const id: string = pathname.split('/')[4];
      const rows: ArchiveRow[] = db.prepare('SELECT * FROM archive WHERE session_id = ? ORDER BY line_number ASC').all(id) as ArchiveRow[];
      if (!rows.length) { json(res, { error: 'No archive data for this session' }, 404); return; }
      json(res, { session_id: id, lines: rows.map((r: ArchiveRow) => ({ line_number: r.line_number, data: JSON.parse(r.raw_json) as unknown })) });
    }
    else if (pathname.match(/^\/api\/archive\/export\/[^/]+$/)) {
      const id: string = pathname.split('/')[4];
      const rows: Array<{ raw_json: string }> = db.prepare('SELECT raw_json FROM archive WHERE session_id = ? ORDER BY line_number ASC').all(id) as Array<{ raw_json: string }>;
      if (!rows.length) { json(res, { error: 'No archive data for this session' }, 404); return; }
      const jsonl: string = rows.map((r) => r.raw_json).join('\n') + '\n';
      download(res, jsonl, `session-${id.slice(0,8)}.jsonl`, 'application/x-ndjson');
    }
    else if (pathname.match(/^\/api\/export\/session\/[^/]+$/)) {
      const id: string = pathname.split('/')[4];
      const format: string = query.format || 'json';
      const session: SessionRow | undefined = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (!session) { json(res, { error: 'Not found' }, 404); return; }
      const events: EventRow[] = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(id) as EventRow[];
      if (format === 'md') {
        download(res, sessionToMarkdown(session, events), `session-${id.slice(0,8)}.md`, 'text/markdown');
      } else {
        download(res, { session, events }, `session-${id.slice(0,8)}.json`, 'application/json');
      }
    }
    else if (pathname === '/api/export/search') {
      const q: string = query.q || '';
      const format: string = query.format || 'json';
      if (!q) { json(res, { error: 'No query' }, 400); return; }
      let results: SearchEventRow[];
      try {
        if (looksLikeSessionId(q)) {
          results = db.prepare(`SELECT e.*, s.start_time as session_start, s.summary as session_summary FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.session_id = ? ORDER BY e.timestamp DESC LIMIT 200`).all(q.trim()) as SearchEventRow[];
        } else {
          const ftsQuery: string = toFtsQuery(q);
          results = db.prepare(`SELECT e.*, s.start_time as session_start, s.summary as session_summary FROM events_fts fts JOIN events e ON e.rowid = fts.rowid JOIN sessions s ON s.id = e.session_id WHERE events_fts MATCH ? ORDER BY e.timestamp DESC LIMIT 200`).all(ftsQuery) as SearchEventRow[];
        }
      } catch { json(res, { error: 'Invalid search query' }, 400); return; }
      if (format === 'md') {
        let md: string = `# Search Results: "${q}"\n\n${results.length} results\n\n`;
        for (const r of results) {
          md += `## [${r.timestamp}] ${r.type} (${r.role || ''})\n`;
          md += `Session: ${r.session_id}\n\n`;
          md += `${r.content || r.tool_args || r.tool_result || ''}\n\n---\n\n`;
        }
        download(res, md, `search-${q.slice(0,20)}.md`, 'text/markdown');
      } else {
        download(res, { query: q, results }, `search-${q.slice(0,20)}.json`, 'application/json');
      }
    }
    else if (pathname === '/api/find') {
      // Command palette: sessions, files and text matches in one request.
      json(res, quickSearch(db, query.q || ''));
    }
    else if (pathname === '/api/search') {
      const q: string = query.q || '';
      const type: string = query.type || '';
      const role: string = query.role || '';
      const from: string = query.from || '';
      const to: string = query.to || '';
      const limit: number = Math.min(parseInt(query.limit) || 50, 200);

      if (!q) { json(res, { results: [], total: 0 }); }
      else {
        const isSessionLookup: boolean = looksLikeSessionId(q);
        let sql: string;
        const params: Array<string | number> = [];

        if (isSessionLookup) {
          sql = `SELECT e.*, s.start_time as session_start, s.summary as session_summary
                 FROM events e
                 JOIN sessions s ON s.id = e.session_id
                 WHERE e.session_id = ?`;
          params.push(q.trim());
        } else {
          sql = `SELECT e.*, s.start_time as session_start, s.summary as session_summary
                 FROM events_fts fts
                 JOIN events e ON e.rowid = fts.rowid
                 JOIN sessions s ON s.id = e.session_id
                 WHERE events_fts MATCH ?`;
          params.push(toFtsQuery(q));
        }

        if (type) { sql += ` AND e.type = ?`; params.push(type); }
        if (role) { sql += ` AND e.role = ?`; params.push(role); }
        if (from) { sql += ` AND e.timestamp >= ?`; params.push(from); }
        if (to) { sql += ` AND e.timestamp <= ?`; params.push(to); }
        sql += ` ORDER BY e.timestamp DESC LIMIT ?`;
        params.push(limit);

        try {
          const results: SearchEventRow[] = db.prepare(sql).all(...params) as SearchEventRow[];
          json(res, { results, total: results.length });
        } catch (err: unknown) {
          json(res, { error: (err as Error).message, results: [], total: 0 }, 400);
        }
      }
    }
    else if (pathname === '/api/timeline') {
      const date: string = query.date || (() => { const n: Date = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
      if (!isValidDateKey(date)) { json(res, { error: 'Invalid date, expected YYYY-MM-DD' }, 400); return; }
      const from: string = new Date(date + 'T00:00:00').toISOString();
      const to: string = new Date(date + 'T23:59:59.999').toISOString();
      const limit: number = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
      const offset: number = Math.max(parseInt(query.offset || '0', 10) || 0, 0);
      const events: TimelineEventRow[] = db.prepare(
        `SELECT e.*, s.summary as session_summary, s.label as session_label FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.timestamp >= ? AND e.timestamp <= ?
         ORDER BY e.timestamp DESC
         LIMIT ? OFFSET ?`
      ).all(from, to, limit, offset) as TimelineEventRow[];
      const total: number = (db.prepare(
        `SELECT COUNT(*) as c FROM events e
         WHERE e.timestamp >= ? AND e.timestamp <= ?`
      ).get(from, to) as CountRow).c;
      json(res, { date, events, total, limit, offset, hasMore: offset + events.length < total });
    }
    else if (pathname === '/api/timeline/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      let lastTs: string = query.after || new Date().toISOString();
      let lastId: string = query.afterId || '';

      const onUpdate = (): void => {
        try {
          const rows: TimelineEventRow[] = db.prepare(
            `SELECT e.*, s.summary as session_summary, s.label as session_label FROM events e
             JOIN sessions s ON s.id = e.session_id
             WHERE (e.timestamp > ?) OR (e.timestamp = ? AND e.id > ?)
             ORDER BY e.timestamp ASC, e.id ASC`
          ).all(lastTs, lastTs, lastId) as TimelineEventRow[];
          if (rows.length) {
            const tail: TimelineEventRow = rows[rows.length - 1];
            lastTs = tail.timestamp || lastTs;
            lastId = tail.id || lastId;
            res.write(`id: ${lastTs}:${lastId}\ndata: ${JSON.stringify(rows)}\n\n`);
          }
        } catch (err: unknown) {
          console.error('Timeline SSE error:', (err as Error).message);
        }
      };

      sseEmitter.on('session-update', onUpdate);

      const ping: NodeJS.Timeout = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 30000);

      req.on('close', () => {
        sseEmitter.off('session-update', onUpdate);
        clearInterval(ping);
      });
    }
    else if (pathname === '/api/maintenance') {
      if (!requireMethod(req, res, 'POST')) return;
      const sizeBefore: DbSize = getDbSize();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      const sizeAfter: DbSize = getDbSize();
      json(res, { ok: true, sizeBefore, sizeAfter });
    }
    // --- Context API ---
    else if (pathname === '/api/context/file') {
      const fp: string = query.path || '';
      if (!fp) return json(res, { error: 'path parameter is required' }, 400);

      const sessionCount: number = (db.prepare(
        'SELECT COUNT(DISTINCT session_id) as c FROM file_activity WHERE file_path = ?'
      ).get(fp) as CountRow).c;

      if (sessionCount === 0) {
        return json(res, { file: fp, sessionCount: 0, lastModified: null, recentChanges: [], operations: {}, relatedFiles: [], recentErrors: [] });
      }

      const lastTouched: string | null = (db.prepare(
        'SELECT MAX(timestamp) as t FROM file_activity WHERE file_path = ?'
      ).get(fp) as { t: string | null }).t;

      const recentChanges: string[] = (db.prepare(
        `SELECT DISTINCT s.summary FROM file_activity fa
         JOIN sessions s ON s.id = fa.session_id
         WHERE fa.file_path = ? AND s.summary IS NOT NULL
         ORDER BY s.start_time DESC LIMIT 5`
      ).all(fp) as Array<{ summary: string }>).map((r) => r.summary);

      const opsRows: Array<{ operation: string; c: number }> = db.prepare(
        'SELECT operation, COUNT(*) as c FROM file_activity WHERE file_path = ? GROUP BY operation'
      ).all(fp) as Array<{ operation: string; c: number }>;
      const operations: Record<string, number> = {};
      for (const r of opsRows) operations[r.operation] = r.c;

      const relatedFiles: Array<{ path: string; count: number }> = (db.prepare(
        `SELECT fa2.file_path, COUNT(DISTINCT fa1.session_id) as c
         FROM file_activity fa1
         JOIN file_activity fa2 ON fa1.session_id = fa2.session_id
         WHERE fa1.file_path = ? AND fa2.file_path != ?
         GROUP BY fa2.file_path
         ORDER BY c DESC LIMIT 5`
      ).all(fp, fp) as Array<{ file_path: string; c: number }>).map((r) => ({ path: r.file_path, count: r.c }));

      const sessionIds: string[] = (db.prepare(
        'SELECT DISTINCT session_id FROM file_activity WHERE file_path = ?'
      ).all(fp) as Array<{ session_id: string }>).map((r) => r.session_id);

      let recentErrors: string[] = [];
      if (sessionIds.length) {
        const placeholders: string = sessionIds.map(() => '?').join(',');
        recentErrors = (db.prepare(
          `SELECT tool_result FROM events
           WHERE session_id IN (${placeholders})
             AND tool_result IS NOT NULL
             AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
           ORDER BY timestamp DESC LIMIT 3`
        ).all(...sessionIds) as Array<{ tool_result: string }>).map((r) => r.tool_result.slice(0, 200));
      }

      return json(res, {
        file: fp, sessionCount,
        lastModified: relativeTime(lastTouched),
        recentChanges, operations, relatedFiles, recentErrors
      });
    }
    else if (pathname === '/api/context/repo') {
      const repoPath: string = query.path || '';
      if (!repoPath) return json(res, { error: 'path parameter is required' }, 400);

      // Find sessions matching the repo path via file_activity or initial_prompt
      const sessionIds: string[] = (db.prepare(
        `SELECT DISTINCT session_id FROM file_activity WHERE file_path = ? OR file_path LIKE ?`
      ).all(repoPath, repoPath + '/%') as Array<{ session_id: string }>).map((r) => r.session_id);

      const promptSessions: string[] = (db.prepare(
        `SELECT id FROM sessions WHERE initial_prompt LIKE ?`
      ).all('%' + repoPath + '%') as Array<{ id: string }>).map((r) => r.id);

      const allIds: string[] = [...new Set([...sessionIds, ...promptSessions])];

      if (allIds.length === 0) {
        return json(res, { repo: repoPath, sessionCount: 0, totalCost: 0, totalTokens: 0, agents: [], topFiles: [], recentSessions: [], commonTools: [], commonErrors: [] });
      }

      const ph: string = allIds.map(() => '?').join(',');

      const agg = db.prepare(
        `SELECT COUNT(*) as c, SUM(total_cost) as cost, SUM(total_tokens) as tokens
         FROM sessions WHERE id IN (${ph})`
      ).get(...allIds) as { c: number; cost: number | null; tokens: number | null };

      const agents: string[] = [...new Set(
        (db.prepare(`SELECT DISTINCT agent FROM sessions WHERE id IN (${ph}) AND agent IS NOT NULL`).all(...allIds) as Array<{ agent: string }>)
          .map((r) => normalizeAgentLabel(r.agent)).filter((a): a is string => a !== null)
      )];

      const topFiles: Array<{ path: string; count: number }> = (db.prepare(
        `SELECT file_path, COUNT(*) as c FROM file_activity
         WHERE session_id IN (${ph})
         GROUP BY file_path ORDER BY c DESC LIMIT 10`
      ).all(...allIds) as Array<{ file_path: string; c: number }>).map((r) => ({ path: r.file_path, count: r.c }));

      const recentSessions: Array<{ id: string; summary: string | null; agent: string | null; timestamp: string; status: string }> = (db.prepare(
        `SELECT id, summary, agent, start_time, end_time FROM sessions
         WHERE id IN (${ph})
         ORDER BY start_time DESC LIMIT 5`
      ).all(...allIds) as Array<{ id: string; summary: string | null; agent: string | null; start_time: string; end_time: string | null }>).map((r) => ({
        id: r.id, summary: r.summary, agent: normalizeAgentLabel(r.agent),
        timestamp: r.start_time, status: r.end_time ? 'completed' : 'in-progress'
      }));

      const commonTools: Array<{ tool: string; count: number }> = (db.prepare(
        `SELECT tool_name, COUNT(*) as c FROM events
         WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY c DESC LIMIT 10`
      ).all(...allIds) as Array<{ tool_name: string; c: number }>).map((r) => ({ tool: r.tool_name, count: r.c }));

      const commonErrors: string[] = (db.prepare(
        `SELECT DISTINCT SUBSTR(tool_result, 1, 200) as err FROM events
         WHERE session_id IN (${ph})
           AND tool_result IS NOT NULL
           AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
         ORDER BY timestamp DESC LIMIT 5`
      ).all(...allIds) as Array<{ err: string }>).map((r) => r.err);

      return json(res, {
        repo: repoPath, sessionCount: allIds.length,
        totalCost: agg.cost || 0, totalTokens: agg.tokens || 0,
        agents, topFiles, recentSessions, commonTools, commonErrors
      });
    }
    else if (pathname === '/api/context/agent') {
      const name: string = query.name || '';
      if (!name) return json(res, { error: 'name parameter is required' }, 400);

      // Try exact match first, then check all sessions with normalized label match
      let sessions: SessionRow[] = db.prepare(
        'SELECT * FROM sessions WHERE agent = ?'
      ).all(name) as SessionRow[];
      if (sessions.length === 0) {
        sessions = (db.prepare('SELECT * FROM sessions WHERE agent IS NOT NULL').all() as SessionRow[])
          .filter((s: SessionRow) => normalizeAgentLabel(s.agent) === name);
      }

      if (sessions.length === 0) {
        return json(res, { agent: name, sessionCount: 0, totalCost: 0, avgDuration: 0, topTools: [], recentSessions: [], successRate: 0 });
      }

      const totalCost: number = sessions.reduce((sum: number, r: SessionRow) => sum + (r.total_cost || 0), 0);
      let totalDuration: number = 0;
      let durationCount: number = 0;
      for (const s of sessions) {
        if (s.start_time && s.end_time) {
          totalDuration += (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 1000;
          durationCount++;
        }
      }
      const avgDuration: number = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

      const withSummary: number = sessions.filter((s: SessionRow) => s.summary).length;
      const successRate: number = Math.round((withSummary / sessions.length) * 100);

      const ids: string[] = sessions.map((s: SessionRow) => s.id);
      const ph: string = ids.map(() => '?').join(',');
      const topTools: Array<{ tool: string; count: number }> = (db.prepare(
        `SELECT tool_name, COUNT(*) as c FROM events
         WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY c DESC LIMIT 10`
      ).all(...ids) as Array<{ tool_name: string; c: number }>).map((r) => ({ tool: r.tool_name, count: r.c }));

      const recentSessions: Array<{ id: string; summary: string | null; timestamp: string }> = sessions
        .sort((a: SessionRow, b: SessionRow) => (b.start_time || '').localeCompare(a.start_time || ''))
        .slice(0, 5)
        .map((s: SessionRow) => ({ id: s.id, summary: s.summary, timestamp: s.start_time }));

      return json(res, {
        agent: name, sessionCount: sessions.length,
        totalCost, avgDuration, topTools, recentSessions, successRate
      });
    }
    else if (pathname === '/api/files') {
      const limit: number = parseInt(query.limit) || 100;
      const offset: number = parseInt(query.offset) || 0;
      const rows: FileActivityAggRow[] = db.prepare(`
        SELECT file_path, COUNT(*) as touch_count, COUNT(DISTINCT session_id) as session_count,
               MAX(timestamp) as last_touched,
               GROUP_CONCAT(DISTINCT operation) as operations
        FROM file_activity
        GROUP BY file_path
        ORDER BY touch_count DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as FileActivityAggRow[];
      const total: number = (db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM file_activity').get() as CountRow).c;
      json(res, { files: rows, total, limit, offset });
    }
    else if (pathname === '/api/files/sessions') {
      const fp: string = query.path || '';
      if (!fp) { json(res, { sessions: [] }); return; }
      // One row per session (a session that touched the file 50 times is still
      // one session), with its operations combined and its latest touch.
      const nowMs: number = Date.now();
      const rows = (db.prepare(`
        SELECT s.*, GROUP_CONCAT(DISTINCT fa.operation) AS operation, MAX(fa.timestamp) AS touch_time
        FROM file_activity fa
        JOIN sessions s ON s.id = fa.session_id
        WHERE fa.file_path = ?
        GROUP BY s.id
        ORDER BY touch_time DESC
      `).all(fp) as FileSessionRow[]).map(r => withStatus(r, nowMs));
      json(res, { file: fp, sessions: rows });
    }
    else if (pathname === '/api/insights') {
      const summary: InsightsSummary = getInsightsSummary(db);
      return json(res, summary);
    }
    else if (pathname.match(/^\/api\/insights\/session\/[^/]+$/)) {
      const id: string = pathname.split('/')[4];
      const row: SessionInsightRow | undefined = db.prepare('SELECT * FROM session_insights WHERE session_id = ?').get(id) as SessionInsightRow | undefined;
      if (!row) {
        // Compute on-the-fly if not yet analyzed
        const result: InsightResult | null = analyzeSession(db, id);
        if (!result) return json(res, { error: 'Session not found' }, 404);
        return json(res, result);
      }
      return json(res, {
        session_id: row.session_id,
        signals: JSON.parse(row.signals || '[]') as unknown,
        confusion_score: row.confusion_score,
        flagged: !!row.flagged,
        computed_at: row.computed_at
      });
    }
    else if (!serveStatic(req, res)) {
      const index: string = path.join(PUBLIC, 'index.html');
      if (fs.existsSync(index)) {
        sendFile(req, res, index, fs.statSync(index));
      } else {
        json(res, { error: 'Not found' }, 404);
      }
    }
  } catch (err: unknown) {
    console.error(err);
    json(res, { error: (err as Error).message }, 500);
  }
}

if (!isLoopbackHost(HOST) && !AUTH_TOKEN && process.env.AGENTACTA_ALLOW_UNAUTHENTICATED_NETWORK !== '1') {
  console.error('Refusing to bind AgentActa on a non-loopback host without auth. Set AGENTACTA_AUTH_TOKEN, or set AGENTACTA_ALLOW_UNAUTHENTICATED_NETWORK=1 if this is an intentional trusted-network exposure.');
  process.exit(1);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use, retrying in 2s...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, HOST);
    }, 2000);
  } else {
    throw err;
  }
});
server.listen(PORT, HOST, () => console.log(`AgentActa running on http://${HOST}:${PORT}`));

// Graceful shutdown
function shutdown(signal: string): void {
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    console.log('AgentActa stopped.');
    process.exit(0);
  });
  // Force exit after 5s if server doesn't close
  setTimeout(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
  IndexResult,
  PreparedStatements,
  SessionDir,
  IndexAllResult,
  InsightResult,
  InsightsSummary,
  SessionInsightRow,
  ArchiveRow,
  FileActivityRow,
  FileActivityAggRow,
  FileSessionRow,
  AttributionResult,
} from './types.js';
import { loadConfig } from './config.js';
import { open, init, createStmts } from './db.js';
import { discoverSessionDirs, listJsonlFiles, indexFile, indexAll } from './indexer.js';
import { attributeSessionEvents, attributeEventDelta } from './project-attribution.js';
import { loadDeltaAttributionContext } from './delta-attribution-context.js';
import { analyzeSession, analyzeAll, getInsightsSummary } from './insights.js';

// --version / -v flag: print version and exit
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { name: string; version: string };
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

// --demo flag: use demo session data (must run before config load)
if (process.argv.includes('--demo')) {
  const demoDir: string = path.join(__dirname, 'demo');
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
const ARCHIVE_MODE: boolean = config.storage === 'archive';

console.log(`AgentActa running in ${config.storage} mode`);

const PUBLIC: string = path.join(__dirname, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function json(res: http.ServerResponse, data: unknown, status: number = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function download(res: http.ServerResponse, data: unknown, filename: string, contentType: string): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const reqUrl: string = req.url || '/';
  let fp: string = path.join(PUBLIC, reqUrl.split('?')[0] === '/' ? 'index.html' : reqUrl.split('?')[0]);
  fp = path.normalize(fp);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return true; }
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext: string = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return true;
  }
  return false;
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

function toFtsQuery(q: string): string {
  const s: string = (q || '').trim();
  if (!s) return '';
  // Quote each token so dashes and punctuation don't break FTS parsing.
  // Example: abc-def -> "abc-def"
  const tokens: string[] = s.match(/"[^"]+"|\S+/g) || [];
  return tokens
    .map((t: string) => t.replace(/^"|"$/g, '').replace(/"/g, '""'))
    .filter(Boolean)
    .map((t: string) => `"${t}"`)
    .join(' AND ');
}

// Init DB and start watcher
init();
const db: Database.Database = open();

// Live re-indexing setup
const stmts: PreparedStatements = createStmts(db);

// SSE emitter: notifies connected clients when a session is re-indexed
const sseEmitter: EventEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100);

const sessionDirs: SessionDir[] = discoverSessionDirs(config);

// Initial indexing pass
for (const dir of sessionDirs) {
  const files: string[] = listJsonlFiles(dir.path, !!dir.recursive);
  for (const filePath of files) {
    try {
      const result: IndexResult = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) console.log(`Indexed: ${path.basename(filePath)} (${dir.agent})`);
    } catch (err: unknown) {
      console.error(`Error indexing ${path.basename(filePath)}:`, (err as Error).message);
    }
  }
}

// Compute insights for all indexed sessions
try {
  analyzeAll(db);
  console.log('Insights computed for all sessions');
} catch (err: unknown) {
  console.error('Error computing insights:', (err as Error).message);
}

console.log(`Watching ${sessionDirs.length} session directories`);

// Debounce map: filePath -> timeout handle
const _reindexTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const REINDEX_DEBOUNCE_MS: number = 2000;
const RECURSIVE_RESCAN_MS: number = 15000;

function reindexRecursiveDir(dir: SessionDir): void {
  try {
    const files: string[] = listJsonlFiles(dir.path, true);
    let changed: number = 0;
    const upsert: Database.Statement = db.prepare('INSERT OR REPLACE INTO session_insights (session_id, signals, confusion_score, flagged, computed_at) VALUES (?, ?, ?, ?, ?)');
    for (const filePath of files) {
      const result: IndexResult = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) {
        changed++;
        if (result.sessionId) {
          try {
            const insight: InsightResult | null = analyzeSession(db, result.sessionId);
            if (insight) upsert.run(insight.session_id, JSON.stringify(insight.signals), insight.confusion_score, insight.flagged ? 1 : 0, insight.computed_at);
          } catch { /* ignore */ }
          sseEmitter.emit('session-update', result.sessionId);
        }
      }
    }
    if (changed > 0) console.log(`Live re-indexed ${changed} files (${dir.agent})`);
  } catch (err: unknown) {
    console.error(`Error rescanning ${dir.path}:`, (err as Error).message);
  }
}

for (const dir of sessionDirs) {
  try {
    fs.watch(dir.path, { persistent: false }, (_eventType: string, filename: string | null) => {
      if (dir.recursive) {
        if (_reindexTimers.has(dir.path)) clearTimeout(_reindexTimers.get(dir.path));
        _reindexTimers.set(dir.path, setTimeout(() => {
          _reindexTimers.delete(dir.path);
          reindexRecursiveDir(dir);
        }, REINDEX_DEBOUNCE_MS));
        return;
      }

      if (!filename || !filename.endsWith('.jsonl')) return;
      const filePath: string = path.join(dir.path, filename);
      if (!fs.existsSync(filePath)) return;

      // Debounce: cancel pending re-index for this file, schedule a new one
      if (_reindexTimers.has(filePath)) clearTimeout(_reindexTimers.get(filePath));
      _reindexTimers.set(filePath, setTimeout(() => {
        _reindexTimers.delete(filePath);
        try {
          const result: IndexResult = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
          if (!result.skipped) {
            console.log(`Live re-indexed: ${filename} (${dir.agent})`);
            if (result.sessionId) {
              try {
                const upsert: Database.Statement = db.prepare('INSERT OR REPLACE INTO session_insights (session_id, signals, confusion_score, flagged, computed_at) VALUES (?, ?, ?, ?, ?)');
                const insight: InsightResult | null = analyzeSession(db, result.sessionId);
                if (insight) upsert.run(insight.session_id, JSON.stringify(insight.signals), insight.confusion_score, insight.flagged ? 1 : 0, insight.computed_at);
              } catch { /* ignore */ }
              sseEmitter.emit('session-update', result.sessionId);
            }
          }
        } catch (err: unknown) {
          console.error(`Error re-indexing ${filename}:`, (err as Error).message);
        }
      }, REINDEX_DEBOUNCE_MS));
    });
    console.log(`  Watching: ${dir.path}`);
    if (dir.recursive) {
      const timer: NodeJS.Timeout = setInterval(() => reindexRecursiveDir(dir), RECURSIVE_RESCAN_MS);
      timer.unref?.();
    }
  } catch (err: unknown) {
    console.error(`  Failed to watch ${dir.path}:`, (err as Error).message);
  }
}

const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
  const { pathname, query }: ParsedQuery = parseQuery(req.url || '/');

  try {
    if (pathname === '/api/reindex') {
      const result: IndexAllResult = indexAll(db, config);
      try { analyzeAll(db); } catch (e: unknown) { console.error('Insights recompute error:', (e as Error).message); }
      return json(res, { ok: true, sessions: result.sessions, events: result.events });
    }

    else if (pathname === '/api/health') {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { name: string; version: string };
      const sessions: number = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
      const dbSize: DbSize = getDbSize();
      return json(res, {
        status: 'ok',
        version: pkg.version,
        uptime: Math.round(process.uptime()),
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
      let sql: string = 'SELECT * FROM sessions';
      const params: Array<string | number> = [];
      if (agent) { sql += ' WHERE agent = ?'; params.push(agent); }
      sql += ' ORDER BY COALESCE(end_time, start_time) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      const rows: SessionRow[] = db.prepare(sql).all(...params) as SessionRow[];
      const countSql: string = agent ? 'SELECT COUNT(*) as c FROM sessions WHERE agent = ?' : 'SELECT COUNT(*) as c FROM sessions';
      const total: number = agent ? (db.prepare(countSql).get(agent) as CountRow).c : (db.prepare(countSql).get() as CountRow).c;
      json(res, { sessions: rows, total, limit, offset });
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

      let lastTs: string = (req.headers['last-event-id'] as string) || query.after || new Date().toISOString();

      const onUpdate = (sessionId: string): void => {
        if (sessionId !== id) return;
        try {
          const rows: EventRow[] = db.prepare(
            'SELECT * FROM events WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC'
          ).all(id, lastTs) as EventRow[];
          if (rows.length) {
            const contextRows: EventRow[] = loadDeltaAttributionContext(db, id, rows);
            const attributedRows: AttributedEvent[] = attributeEventDelta(session, rows, contextRows);
            lastTs = rows[rows.length - 1].timestamp;
            res.write(`id: ${lastTs}\ndata: ${JSON.stringify(attributedRows)}\n\n`);
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
      const session: SessionRow | undefined = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (!session) { json(res, { error: 'Not found' }, 404); }
      else {
        const events: EventRow[] = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC').all(id) as EventRow[];
        const attributed: AttributionResult = attributeSessionEvents(session, events);
        const hasArchive: boolean = ARCHIVE_MODE && (db.prepare('SELECT COUNT(*) as c FROM archive WHERE session_id = ?').get(id) as CountRow).c > 0;
        json(res, { session, events: attributed.events, projectFilters: attributed.projectFilters, hasArchive });
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
      const from: string = new Date(date + 'T00:00:00').toISOString();
      const to: string = new Date(date + 'T23:59:59.999').toISOString();
      const limit: number = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
      const offset: number = Math.max(parseInt(query.offset || '0', 10) || 0, 0);
      const events: TimelineEventRow[] = db.prepare(
        `SELECT e.*, s.summary as session_summary FROM events e
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
            `SELECT e.*, s.summary as session_summary FROM events e
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
      if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);
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
      const rows: FileSessionRow[] = db.prepare(`
        SELECT DISTINCT s.*, fa.operation, fa.timestamp as touch_time
        FROM file_activity fa
        JOIN sessions s ON s.id = fa.session_id
        WHERE fa.file_path = ?
        ORDER BY fa.timestamp DESC
      `).all(fp) as FileSessionRow[];
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
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(index).pipe(res);
      } else {
        json(res, { error: 'Not found' }, 404);
      }
    }
  } catch (err: unknown) {
    console.error(err);
    json(res, { error: (err as Error).message }, 500);
  }
});

const HOST: string = process.env.AGENTACTA_HOST || '127.0.0.1';
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

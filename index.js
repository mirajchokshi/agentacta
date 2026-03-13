#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// --version / -v flag: print version and exit
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = require('./package.json');
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

// --demo flag: use demo session data (must run before config load)
if (process.argv.includes('--demo')) {
  const demoDir = path.join(__dirname, 'demo');
  if (!fs.existsSync(demoDir) || fs.readdirSync(demoDir).filter(f => f.endsWith('.jsonl')).length === 0) {
    console.error('Demo data not found. Run: node scripts/seed-demo.js');
    process.exit(1);
  }
  process.env.AGENTACTA_SESSIONS_PATH = demoDir;
  process.env.AGENTACTA_DB_PATH = path.join(demoDir, 'demo.db');
  console.log(`Demo mode: using sessions from ${demoDir}`);
}

const { loadConfig } = require('./config');
const { open, init, createStmts } = require('./db');
const { discoverSessionDirs, listJsonlFiles, indexFile } = require('./indexer');
const { attributeSessionEvents, attributeEventDelta } = require('./project-attribution');
const { loadDeltaAttributionContext } = require('./delta-attribution-context');

const config = loadConfig();
const PORT = config.port;
const ARCHIVE_MODE = config.storage === 'archive';

console.log(`AgentActa running in ${config.storage} mode`);

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function download(res, data, filename, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function serveStatic(req, res) {
  let fp = path.join(PUBLIC, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  fp = path.normalize(fp);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return true; }
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return true;
  }
  return false;
}

function parseQuery(url) {
  const u = new URL(url, 'http://localhost');
  const o = {};
  u.searchParams.forEach((v, k) => o[k] = v);
  return { pathname: u.pathname, query: o };
}

function sessionToMarkdown(session, events) {
  let md = `# Session: ${session.id}\n`;
  md += `- **Start:** ${session.start_time}\n`;
  md += `- **End:** ${session.end_time || 'N/A'}\n`;
  md += `- **Model:** ${session.model || 'N/A'}\n`;
  md += `- **Agent:** ${session.agent || 'main'}\n`;
  md += `- **Messages:** ${session.message_count} | **Tools:** ${session.tool_count}\n`;
  md += `- **Cost:** $${(session.total_cost || 0).toFixed(4)} | **Tokens:** ${(session.total_tokens || 0).toLocaleString()}\n\n`;
  md += `## Summary\n${session.summary || 'No summary'}\n\n## Events\n\n`;
  for (const e of events) {
    const time = e.timestamp ? new Date(e.timestamp).toISOString() : '';
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

function getDbSize() {
  try {
    const stat = fs.statSync(config.dbPath);
    const mb = stat.size / (1024 * 1024);
    return { bytes: stat.size, display: mb >= 1 ? `${mb.toFixed(1)} MB` : `${(stat.size / 1024).toFixed(1)} KB` };
  } catch {
    return { bytes: 0, display: 'N/A' };
  }
}

function relativeTime(ts) {
  if (!ts) return null;
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function normalizeAgentLabel(agent) {
  if (!agent) return agent;
  if (agent === 'main') return 'openclaw-main';
  if (agent.startsWith('claude-') || agent.startsWith('claude--')) return 'claude-code';
  return agent;
}

function looksLikeSessionId(q) {
  const s = (q || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function toFtsQuery(q) {
  const s = (q || '').trim();
  if (!s) return '';
  // Quote each token so dashes and punctuation don't break FTS parsing.
  // Example: abc-def -> "abc-def"
  const tokens = s.match(/"[^"]+"|\S+/g) || [];
  return tokens
    .map(t => t.replace(/^"|"$/g, '').replace(/"/g, '""'))
    .filter(Boolean)
    .map(t => `"${t}"`)
    .join(' AND ');
}

// Init DB and start watcher
init();
const db = open();

// Live re-indexing setup
const stmts = createStmts(db);

// SSE emitter: notifies connected clients when a session is re-indexed
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100);

const sessionDirs = discoverSessionDirs(config);

// Initial indexing pass
for (const dir of sessionDirs) {
  const files = listJsonlFiles(dir.path, !!dir.recursive);
  for (const filePath of files) {
    try {
      const result = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) console.log(`Indexed: ${path.basename(filePath)} (${dir.agent})`);
    } catch (err) {
      console.error(`Error indexing ${path.basename(filePath)}:`, err.message);
    }
  }
}

console.log(`Watching ${sessionDirs.length} session directories`);

// Debounce map: filePath -> timeout handle
const _reindexTimers = new Map();
const REINDEX_DEBOUNCE_MS = 2000;
const RECURSIVE_RESCAN_MS = 15000;

function reindexRecursiveDir(dir) {
  try {
    const files = listJsonlFiles(dir.path, true);
    let changed = 0;
    for (const filePath of files) {
      const result = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) {
        changed++;
        if (result.sessionId) sseEmitter.emit('session-update', result.sessionId);
      }
    }
    if (changed > 0) console.log(`Live re-indexed ${changed} files (${dir.agent})`);
  } catch (err) {
    console.error(`Error rescanning ${dir.path}:`, err.message);
  }
}

for (const dir of sessionDirs) {
  try {
    fs.watch(dir.path, { persistent: false }, (eventType, filename) => {
      if (dir.recursive) {
        if (_reindexTimers.has(dir.path)) clearTimeout(_reindexTimers.get(dir.path));
        _reindexTimers.set(dir.path, setTimeout(() => {
          _reindexTimers.delete(dir.path);
          reindexRecursiveDir(dir);
        }, REINDEX_DEBOUNCE_MS));
        return;
      }

      if (!filename || !filename.endsWith('.jsonl')) return;
      const filePath = path.join(dir.path, filename);
      if (!fs.existsSync(filePath)) return;

      // Debounce: cancel pending re-index for this file, schedule a new one
      if (_reindexTimers.has(filePath)) clearTimeout(_reindexTimers.get(filePath));
      _reindexTimers.set(filePath, setTimeout(() => {
        _reindexTimers.delete(filePath);
        try {
          const result = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
          if (!result.skipped) {
            console.log(`Live re-indexed: ${filename} (${dir.agent})`);
            if (result.sessionId) sseEmitter.emit('session-update', result.sessionId);
          }
        } catch (err) {
          console.error(`Error re-indexing ${filename}:`, err.message);
        }
      }, REINDEX_DEBOUNCE_MS));
    });
    console.log(`  Watching: ${dir.path}`);
    if (dir.recursive) {
      const timer = setInterval(() => reindexRecursiveDir(dir), RECURSIVE_RESCAN_MS);
      timer.unref?.();
    }
  } catch (err) {
    console.error(`  Failed to watch ${dir.path}:`, err.message);
  }
}

const server = http.createServer((req, res) => {
  const { pathname, query } = parseQuery(req.url);

  try {
    if (pathname === '/api/reindex') {
      const { indexAll } = require('./indexer');
      const result = indexAll(db, config);
      return json(res, { ok: true, sessions: result.sessions, events: result.events });
    }

    else if (pathname === '/api/health') {
      const pkg = require('./package.json');
      const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
      const dbSize = getDbSize();
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
      const dbSize = getDbSize();
      const archiveCount = db.prepare('SELECT COUNT(*) as c FROM archive').get().c;
      json(res, {
        storage: config.storage,
        port: config.port,
        dbPath: config.dbPath,
        dbSize: dbSize,
        sessionsPath: config.sessionsPath,
        sessionDirs: sessionDirs.map(d => ({ path: d.path, agent: d.agent })),
        archiveEnabled: ARCHIVE_MODE,
        archiveRows: archiveCount
      });
    }
    else if (pathname === '/api/suggestions') {
      // Top tool names (most used)
      const tools = db.prepare("SELECT tool_name, COUNT(*) as c FROM events WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC LIMIT 5").all().map(r => r.tool_name);
      // Most touched files (short basenames)
      const files = db.prepare("SELECT file_path, COUNT(*) as c FROM file_activity GROUP BY file_path ORDER BY c DESC LIMIT 5").all().map(r => {
        const parts = r.file_path.split('/');
        return parts[parts.length - 1];
      }).filter(f => f.length <= 25);
      // Recent session summary words (crude topic extraction)
      const summaries = db.prepare("SELECT summary FROM sessions WHERE summary IS NOT NULL ORDER BY start_time DESC LIMIT 20").all().map(r => r.summary).join(' ');
      const wordFreq = {};
      const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','is','it','that','this','with','was','are','be','has','had','not','no','from','by','as','do','if','so','up','out','then','than','into','its','my','we','he','she','they','you','i','me','all','just','can','will','about','been','have','some','when','would','there','what','which','who','how','each','other','new','old','also','back','after','use','two','way','could','make','like','time','very','your','did','get','made','find','here','thing','many','well','only','any','those','over','such','our','them','his','her','one','file','files','session','sessions','agent','tool','message','messages','run','work','set','used','added','updated','using','based','check','cst','est','pst','tue','wed','thu','fri','sat','sun','mon','jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec','via','per','yet','ago','etc','got']);
      summaries.toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter(w => w.length > 3 && w.length < 20 && !stopWords.has(w) && !/id$/.test(w)).forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
      const topics = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
      // Deduplicate and pick up to 8
      const seen = new Set();
      const suggestions = [];
      for (const s of [...tools, ...topics, ...files]) {
        const key = s.toLowerCase();
        if (!seen.has(key) && suggestions.length < 8) { seen.add(key); suggestions.push(s); }
      }
      json(res, { suggestions });
    }
    else if (pathname === '/api/stats') {
      const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
      const events = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
      const messages = db.prepare("SELECT COUNT(*) as c FROM events WHERE type='message'").get().c;
      const toolCalls = db.prepare("SELECT COUNT(*) as c FROM events WHERE type='tool_call'").get().c;
      const tools = db.prepare("SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL").all().map(r => r.tool_name);
      const dateRange = db.prepare('SELECT MIN(start_time) as earliest, MAX(start_time) as latest FROM sessions').get();
      const costData = db.prepare('SELECT SUM(total_cost) as cost, SUM(total_tokens) as tokens FROM sessions').get();
      const agents = [...new Set(
        db.prepare('SELECT DISTINCT agent FROM sessions WHERE agent IS NOT NULL').all()
          .map(r => normalizeAgentLabel(r.agent))
          .filter(Boolean)
      )];
      const dbSize = getDbSize();
      json(res, { sessions, events, messages, toolCalls, uniqueTools: tools.length, tools, dateRange, totalCost: costData.cost || 0, totalTokens: costData.tokens || 0, agents, storageMode: config.storage, dbSize, sessionDirs: sessionDirs.map(d => ({ path: d.path, agent: d.agent })) });
    }
    else if (pathname === '/api/sessions') {
      const limit = parseInt(query.limit) || 50;
      const offset = parseInt(query.offset) || 0;
      const agent = query.agent || '';
      let sql = 'SELECT * FROM sessions';
      const params = [];
      if (agent) { sql += ' WHERE agent = ?'; params.push(agent); }
      sql += ' ORDER BY COALESCE(end_time, start_time) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      const rows = db.prepare(sql).all(...params);
      const countSql = agent ? 'SELECT COUNT(*) as c FROM sessions WHERE agent = ?' : 'SELECT COUNT(*) as c FROM sessions';
      const total = agent ? db.prepare(countSql).get(agent).c : db.prepare(countSql).get().c;
      json(res, { sessions: rows, total, limit, offset });
    }

    else if (pathname.match(/^\/api\/sessions\/[^/]+\/events$/)) {
      const id = pathname.split('/')[3];
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) return json(res, { error: 'Not found' }, 404);

      const after = query.after || '1970-01-01T00:00:00.000Z';
      const afterId = query.afterId || '';
      const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
      const rows = db.prepare(
        `SELECT * FROM events
         WHERE session_id = ?
           AND (timestamp > ? OR (timestamp = ? AND id > ?))
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`
      ).all(id, after, after, afterId, limit);
      const contextRows = loadDeltaAttributionContext(db, id, rows);
      const events = attributeEventDelta(session, rows, contextRows);
      json(res, { events, after, afterId, count: events.length });
    }

    else if (pathname.match(/^\/api\/sessions\/[^/]+\/stream$/)) {
      const id = pathname.split('/')[3];
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) return json(res, { error: 'Not found' }, 404);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      let lastTs = req.headers['last-event-id'] || query.after || new Date().toISOString();

      const onUpdate = (sessionId) => {
        if (sessionId !== id) return;
        try {
          const rows = db.prepare(
            'SELECT * FROM events WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC'
          ).all(id, lastTs);
          if (rows.length) {
            const contextRows = loadDeltaAttributionContext(db, id, rows);
            const attributedRows = attributeEventDelta(session, rows, contextRows);
            lastTs = rows[rows.length - 1].timestamp;
            res.write(`id: ${lastTs}\ndata: ${JSON.stringify(attributedRows)}\n\n`);
          }
        } catch (err) {
          console.error('SSE query error:', err.message);
        }
      };

      sseEmitter.on('session-update', onUpdate);

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 30000);

      req.on('close', () => {
        sseEmitter.off('session-update', onUpdate);
        clearInterval(ping);
      });
    }
    else if (pathname.match(/^\/api\/sessions\/[^/]+$/) && !pathname.includes('export')) {
      const id = pathname.split('/')[3];
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) { json(res, { error: 'Not found' }, 404); }
      else {
        const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC').all(id);
        const attributed = attributeSessionEvents(session, events);
        const hasArchive = ARCHIVE_MODE && db.prepare('SELECT COUNT(*) as c FROM archive WHERE session_id = ?').get(id).c > 0;
        json(res, { session, events: attributed.events, projectFilters: attributed.projectFilters, hasArchive });
      }
    }
    else if (pathname.match(/^\/api\/archive\/session\/[^/]+$/)) {
      const id = pathname.split('/')[4];
      const rows = db.prepare('SELECT * FROM archive WHERE session_id = ? ORDER BY line_number ASC').all(id);
      if (!rows.length) { json(res, { error: 'No archive data for this session' }, 404); return; }
      json(res, { session_id: id, lines: rows.map(r => ({ line_number: r.line_number, data: JSON.parse(r.raw_json) })) });
    }
    else if (pathname.match(/^\/api\/archive\/export\/[^/]+$/)) {
      const id = pathname.split('/')[4];
      const rows = db.prepare('SELECT raw_json FROM archive WHERE session_id = ? ORDER BY line_number ASC').all(id);
      if (!rows.length) { json(res, { error: 'No archive data for this session' }, 404); return; }
      const jsonl = rows.map(r => r.raw_json).join('\n') + '\n';
      download(res, jsonl, `session-${id.slice(0,8)}.jsonl`, 'application/x-ndjson');
    }
    else if (pathname.match(/^\/api\/export\/session\/[^/]+$/)) {
      const id = pathname.split('/')[4];
      const format = query.format || 'json';
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) { json(res, { error: 'Not found' }, 404); return; }
      const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(id);
      if (format === 'md') {
        download(res, sessionToMarkdown(session, events), `session-${id.slice(0,8)}.md`, 'text/markdown');
      } else {
        download(res, { session, events }, `session-${id.slice(0,8)}.json`, 'application/json');
      }
    }
    else if (pathname === '/api/export/search') {
      const q = query.q || '';
      const format = query.format || 'json';
      if (!q) { json(res, { error: 'No query' }, 400); return; }
      let results;
      try {
        if (looksLikeSessionId(q)) {
          results = db.prepare(`SELECT e.*, s.start_time as session_start, s.summary as session_summary FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.session_id = ? ORDER BY e.timestamp DESC LIMIT 200`).all(q.trim());
        } else {
          const ftsQuery = toFtsQuery(q);
          results = db.prepare(`SELECT e.*, s.start_time as session_start, s.summary as session_summary FROM events_fts fts JOIN events e ON e.rowid = fts.rowid JOIN sessions s ON s.id = e.session_id WHERE events_fts MATCH ? ORDER BY e.timestamp DESC LIMIT 200`).all(ftsQuery);
        }
      } catch (err) { json(res, { error: 'Invalid search query' }, 400); return; }
      if (format === 'md') {
        let md = `# Search Results: "${q}"\n\n${results.length} results\n\n`;
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
      const q = query.q || '';
      const type = query.type || '';
      const role = query.role || '';
      const from = query.from || '';
      const to = query.to || '';
      const limit = Math.min(parseInt(query.limit) || 50, 200);

      if (!q) { json(res, { results: [], total: 0 }); }
      else {
        const isSessionLookup = looksLikeSessionId(q);
        let sql;
        const params = [];

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
          const results = db.prepare(sql).all(...params);
          json(res, { results, total: results.length });
        } catch (err) {
          json(res, { error: err.message, results: [], total: 0 }, 400);
        }
      }
    }
    else if (pathname === '/api/timeline') {
      const date = query.date || (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
      const from = new Date(date + 'T00:00:00').toISOString();
      const to = new Date(date + 'T23:59:59.999').toISOString();
      const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
      const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);
      const events = db.prepare(
        `SELECT e.*, s.summary as session_summary FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.timestamp >= ? AND e.timestamp <= ?
         ORDER BY e.timestamp DESC
         LIMIT ? OFFSET ?`
      ).all(from, to, limit, offset);
      const total = db.prepare(
        `SELECT COUNT(*) as c FROM events e
         WHERE e.timestamp >= ? AND e.timestamp <= ?`
      ).get(from, to).c;
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

      let lastTs = query.after || new Date().toISOString();
      let lastId = query.afterId || '';

      const onUpdate = () => {
        try {
          const rows = db.prepare(
            `SELECT e.*, s.summary as session_summary FROM events e
             JOIN sessions s ON s.id = e.session_id
             WHERE (e.timestamp > ?) OR (e.timestamp = ? AND e.id > ?)
             ORDER BY e.timestamp ASC, e.id ASC`
          ).all(lastTs, lastTs, lastId);
          if (rows.length) {
            const tail = rows[rows.length - 1];
            lastTs = tail.timestamp || lastTs;
            lastId = tail.id || lastId;
            res.write(`id: ${lastTs}:${lastId}\ndata: ${JSON.stringify(rows)}\n\n`);
          }
        } catch (err) {
          console.error('Timeline SSE error:', err.message);
        }
      };

      sseEmitter.on('session-update', onUpdate);

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 30000);

      req.on('close', () => {
        sseEmitter.off('session-update', onUpdate);
        clearInterval(ping);
      });
    }
    else if (pathname === '/api/maintenance') {
      if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);
      const sizeBefore = getDbSize();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      const sizeAfter = getDbSize();
      json(res, { ok: true, sizeBefore, sizeAfter });
    }
    // --- Context API ---
    else if (pathname === '/api/context/file') {
      const fp = query.path || '';
      if (!fp) return json(res, { error: 'path parameter is required' }, 400);

      const sessionCount = db.prepare(
        'SELECT COUNT(DISTINCT session_id) as c FROM file_activity WHERE file_path = ?'
      ).get(fp).c;

      if (sessionCount === 0) {
        return json(res, { file: fp, sessionCount: 0, lastModified: null, recentChanges: [], operations: {}, relatedFiles: [], recentErrors: [] });
      }

      const lastTouched = db.prepare(
        'SELECT MAX(timestamp) as t FROM file_activity WHERE file_path = ?'
      ).get(fp).t;

      const recentChanges = db.prepare(
        `SELECT DISTINCT s.summary FROM file_activity fa
         JOIN sessions s ON s.id = fa.session_id
         WHERE fa.file_path = ? AND s.summary IS NOT NULL
         ORDER BY s.start_time DESC LIMIT 5`
      ).all(fp).map(r => r.summary);

      const opsRows = db.prepare(
        'SELECT operation, COUNT(*) as c FROM file_activity WHERE file_path = ? GROUP BY operation'
      ).all(fp);
      const operations = {};
      for (const r of opsRows) operations[r.operation] = r.c;

      const relatedFiles = db.prepare(
        `SELECT fa2.file_path, COUNT(DISTINCT fa1.session_id) as c
         FROM file_activity fa1
         JOIN file_activity fa2 ON fa1.session_id = fa2.session_id
         WHERE fa1.file_path = ? AND fa2.file_path != ?
         GROUP BY fa2.file_path
         ORDER BY c DESC LIMIT 5`
      ).all(fp, fp).map(r => ({ path: r.file_path, count: r.c }));

      const sessionIds = db.prepare(
        'SELECT DISTINCT session_id FROM file_activity WHERE file_path = ?'
      ).all(fp).map(r => r.session_id);

      let recentErrors = [];
      if (sessionIds.length) {
        const placeholders = sessionIds.map(() => '?').join(',');
        recentErrors = db.prepare(
          `SELECT tool_result FROM events
           WHERE session_id IN (${placeholders})
             AND tool_result IS NOT NULL
             AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
           ORDER BY timestamp DESC LIMIT 3`
        ).all(...sessionIds).map(r => r.tool_result.slice(0, 200));
      }

      return json(res, {
        file: fp, sessionCount,
        lastModified: relativeTime(lastTouched),
        recentChanges, operations, relatedFiles, recentErrors
      });
    }
    else if (pathname === '/api/context/repo') {
      const repoPath = query.path || '';
      if (!repoPath) return json(res, { error: 'path parameter is required' }, 400);

      // Find sessions matching the repo path via file_activity or initial_prompt
      const sessionIds = db.prepare(
        `SELECT DISTINCT session_id FROM file_activity WHERE file_path = ? OR file_path LIKE ?`
      ).all(repoPath, repoPath + '/%').map(r => r.session_id);

      const promptSessions = db.prepare(
        `SELECT id FROM sessions WHERE initial_prompt LIKE ?`
      ).all('%' + repoPath + '%').map(r => r.id);

      const allIds = [...new Set([...sessionIds, ...promptSessions])];

      if (allIds.length === 0) {
        return json(res, { repo: repoPath, sessionCount: 0, totalCost: 0, totalTokens: 0, agents: [], topFiles: [], recentSessions: [], commonTools: [], commonErrors: [] });
      }

      const ph = allIds.map(() => '?').join(',');

      const agg = db.prepare(
        `SELECT COUNT(*) as c, SUM(total_cost) as cost, SUM(total_tokens) as tokens
         FROM sessions WHERE id IN (${ph})`
      ).get(...allIds);

      const agents = [...new Set(
        db.prepare(`SELECT DISTINCT agent FROM sessions WHERE id IN (${ph}) AND agent IS NOT NULL`).all(...allIds)
          .map(r => normalizeAgentLabel(r.agent)).filter(Boolean)
      )];

      const topFiles = db.prepare(
        `SELECT file_path, COUNT(*) as c FROM file_activity
         WHERE session_id IN (${ph})
         GROUP BY file_path ORDER BY c DESC LIMIT 10`
      ).all(...allIds).map(r => ({ path: r.file_path, count: r.c }));

      const recentSessions = db.prepare(
        `SELECT id, summary, agent, start_time, end_time FROM sessions
         WHERE id IN (${ph})
         ORDER BY start_time DESC LIMIT 5`
      ).all(...allIds).map(r => ({
        id: r.id, summary: r.summary, agent: normalizeAgentLabel(r.agent),
        timestamp: r.start_time, status: r.end_time ? 'completed' : 'in-progress'
      }));

      const commonTools = db.prepare(
        `SELECT tool_name, COUNT(*) as c FROM events
         WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY c DESC LIMIT 10`
      ).all(...allIds).map(r => ({ tool: r.tool_name, count: r.c }));

      const commonErrors = db.prepare(
        `SELECT DISTINCT SUBSTR(tool_result, 1, 200) as err FROM events
         WHERE session_id IN (${ph})
           AND tool_result IS NOT NULL
           AND (tool_result LIKE '%error%' OR tool_result LIKE '%Error%' OR tool_result LIKE '%ERROR%')
         ORDER BY timestamp DESC LIMIT 5`
      ).all(...allIds).map(r => r.err);

      return json(res, {
        repo: repoPath, sessionCount: allIds.length,
        totalCost: agg.cost || 0, totalTokens: agg.tokens || 0,
        agents, topFiles, recentSessions, commonTools, commonErrors
      });
    }
    else if (pathname === '/api/context/agent') {
      const name = query.name || '';
      if (!name) return json(res, { error: 'name parameter is required' }, 400);

      // Try exact match first, then check all sessions with normalized label match
      let sessions = db.prepare(
        'SELECT * FROM sessions WHERE agent = ?'
      ).all(name);
      if (sessions.length === 0) {
        sessions = db.prepare('SELECT * FROM sessions WHERE agent IS NOT NULL').all()
          .filter(s => normalizeAgentLabel(s.agent) === name);
      }

      if (sessions.length === 0) {
        return json(res, { agent: name, sessionCount: 0, totalCost: 0, avgDuration: 0, topTools: [], recentSessions: [], successRate: 0 });
      }

      const totalCost = sessions.reduce((s, r) => s + (r.total_cost || 0), 0);
      let totalDuration = 0;
      let durationCount = 0;
      for (const s of sessions) {
        if (s.start_time && s.end_time) {
          totalDuration += (new Date(s.end_time) - new Date(s.start_time)) / 1000;
          durationCount++;
        }
      }
      const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

      const withSummary = sessions.filter(s => s.summary).length;
      const successRate = Math.round((withSummary / sessions.length) * 100);

      const ids = sessions.map(s => s.id);
      const ph = ids.map(() => '?').join(',');
      const topTools = db.prepare(
        `SELECT tool_name, COUNT(*) as c FROM events
         WHERE session_id IN (${ph}) AND tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY c DESC LIMIT 10`
      ).all(...ids).map(r => ({ tool: r.tool_name, count: r.c }));

      const recentSessions = sessions
        .sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''))
        .slice(0, 5)
        .map(s => ({ id: s.id, summary: s.summary, timestamp: s.start_time }));

      return json(res, {
        agent: name, sessionCount: sessions.length,
        totalCost, avgDuration, topTools, recentSessions, successRate
      });
    }
    else if (pathname === '/api/files') {
      const limit = parseInt(query.limit) || 100;
      const offset = parseInt(query.offset) || 0;
      const rows = db.prepare(`
        SELECT file_path, COUNT(*) as touch_count, COUNT(DISTINCT session_id) as session_count,
               MAX(timestamp) as last_touched,
               GROUP_CONCAT(DISTINCT operation) as operations
        FROM file_activity
        GROUP BY file_path
        ORDER BY touch_count DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      const total = db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM file_activity').get().c;
      json(res, { files: rows, total, limit, offset });
    }
    else if (pathname === '/api/files/sessions') {
      const fp = query.path || '';
      if (!fp) { json(res, { sessions: [] }); return; }
      const rows = db.prepare(`
        SELECT DISTINCT s.*, fa.operation, fa.timestamp as touch_time
        FROM file_activity fa
        JOIN sessions s ON s.id = fa.session_id
        WHERE fa.file_path = ?
        ORDER BY fa.timestamp DESC
      `).all(fp);
      json(res, { file: fp, sessions: rows });
    }
    else if (!serveStatic(req, res)) {
      const index = path.join(PUBLIC, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(index).pipe(res);
      } else {
        json(res, { error: 'Not found' }, 404);
      }
    }
  } catch (err) {
    console.error(err);
    json(res, { error: err.message }, 500);
  }
});

const HOST = process.env.AGENTACTA_HOST || '127.0.0.1';
server.on('error', (err) => {
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
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    try { db.close(); } catch {}
    console.log('AgentActa stopped.');
    process.exit(0);
  });
  // Force exit after 5s if server doesn't close
  setTimeout(() => {
    try { db.close(); } catch {}
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

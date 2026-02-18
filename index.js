#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

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
const { open, init } = require('./db');
const { discoverSessionDirs, indexFile } = require('./indexer');

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

// Init DB and start watcher
init();
const db = open();

// Live re-indexing setup
const stmts = {
  getState: db.prepare('SELECT * FROM index_state WHERE file_path = ?'),
  getSession: db.prepare('SELECT id FROM sessions WHERE id = ?'),
  deleteEvents: db.prepare('DELETE FROM events WHERE session_id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  deleteFileActivity: db.prepare('DELETE FROM file_activity WHERE session_id = ?'),
  insertEvent: db.prepare(`INSERT OR REPLACE INTO events (id, session_id, timestamp, type, role, content, tool_name, tool_args, tool_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upsertSession: db.prepare(`INSERT OR REPLACE INTO sessions (id, start_time, end_time, message_count, tool_count, model, summary, agent, session_type, total_cost, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upsertState: db.prepare(`INSERT OR REPLACE INTO index_state (file_path, last_offset, last_modified) VALUES (?, ?, ?)`),
  insertFileActivity: db.prepare(`INSERT INTO file_activity (session_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?)`),
  deleteArchive: db.prepare('DELETE FROM archive WHERE session_id = ?'),
  insertArchive: db.prepare('INSERT INTO archive (session_id, line_number, raw_json) VALUES (?, ?, ?)')
};

const sessionDirs = discoverSessionDirs(config);

// Initial indexing pass
for (const dir of sessionDirs) {
  const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    try {
      const result = indexFile(db, path.join(dir.path, file), dir.agent, stmts, ARCHIVE_MODE);
      if (!result.skipped) console.log(`Indexed: ${file} (${dir.agent})`);
    } catch (err) {
      console.error(`Error indexing ${file}:`, err.message);
    }
  }
}

console.log(`Watching ${sessionDirs.length} session directories`);

for (const dir of sessionDirs) {
  try {
    fs.watch(dir.path, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const filePath = path.join(dir.path, filename);
      if (!fs.existsSync(filePath)) return;
      setTimeout(() => {
        try {
          const result = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE);
          if (!result.skipped) console.log(`Live re-indexed: ${filename} (${dir.agent})`);
        } catch (err) {
          console.error(`Error re-indexing ${filename}:`, err.message);
        }
      }, 500);
    });
    console.log(`  Watching: ${dir.path}`);
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
      const agents = db.prepare('SELECT DISTINCT agent FROM sessions WHERE agent IS NOT NULL').all().map(r => r.agent);
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
    else if (pathname.match(/^\/api\/sessions\/[^/]+$/) && !pathname.includes('export')) {
      const id = pathname.split('/')[3];
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) { json(res, { error: 'Not found' }, 404); }
      else {
        const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC').all(id);
        const hasArchive = ARCHIVE_MODE && db.prepare('SELECT COUNT(*) as c FROM archive WHERE session_id = ?').get(id).c > 0;
        json(res, { session, events, hasArchive });
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
        results = db.prepare(`SELECT e.*, s.start_time as session_start, s.summary as session_summary FROM events_fts fts JOIN events e ON e.rowid = fts.rowid JOIN sessions s ON s.id = e.session_id WHERE events_fts MATCH ? ORDER BY e.timestamp DESC LIMIT 200`).all(q);
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
        let sql = `SELECT e.*, s.start_time as session_start, s.summary as session_summary
                    FROM events_fts fts
                    JOIN events e ON e.rowid = fts.rowid
                    JOIN sessions s ON s.id = e.session_id
                    WHERE events_fts MATCH ?`;
        const params = [q];
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
      const date = query.date || new Date().toISOString().slice(0, 10);
      const from = date + 'T00:00:00.000Z';
      const to = date + 'T23:59:59.999Z';
      const events = db.prepare(
        `SELECT e.*, s.summary as session_summary FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.timestamp >= ? AND e.timestamp <= ?
         ORDER BY e.timestamp DESC`
      ).all(from, to);
      json(res, { date, events, total: events.length });
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
server.listen(PORT, HOST, () => console.log(`AgentActa running on http://${HOST}:${PORT}`));

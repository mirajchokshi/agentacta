const fs = require('fs');
const path = require('path');
const { open, init, createStmts } = require('./db');
const { loadConfig } = require('./config');

const REINDEX = process.argv.includes('--reindex');
const WATCH = process.argv.includes('--watch');

function discoverSessionDirs(config) {
  const dirs = [];
  const home = process.env.HOME;

  // Config sessionsPath or env var override
  const sessionsOverride = process.env.AGENTACTA_SESSIONS_PATH || (config && config.sessionsPath);
  if (sessionsOverride) {
    for (const p of sessionsOverride.split(':')) {
      if (fs.existsSync(p)) dirs.push({ path: p, agent: path.basename(path.dirname(p)) });
    }
    if (dirs.length) return dirs;
  }

  // Scan ~/.openclaw/agents/*/sessions/
  const oclawAgents = path.join(home, '.openclaw/agents');
  if (fs.existsSync(oclawAgents)) {
    for (const agent of fs.readdirSync(oclawAgents)) {
      const sp = path.join(oclawAgents, agent, 'sessions');
      if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
        dirs.push({ path: sp, agent });
      }
    }
  }

  // Scan ~/.claude/projects/*/sessions/
  const claudeProjects = path.join(home, '.claude/projects');
  if (fs.existsSync(claudeProjects)) {
    for (const proj of fs.readdirSync(claudeProjects)) {
      const sp = path.join(claudeProjects, proj, 'sessions');
      if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
        dirs.push({ path: sp, agent: `claude-${proj}` });
      }
    }
  }

  if (!dirs.length) {
    // Fallback to hardcoded
    const fallback = path.join(home, '.openclaw/agents/main/sessions');
    if (fs.existsSync(fallback)) dirs.push({ path: fallback, agent: 'main' });
  }

  return dirs;
}

function isHeartbeat(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('heartbeat') || lower.includes('heartbeat_ok');
}

function extractContent(msg) {
  if (!msg || !msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

function extractToolCalls(msg) {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter(b => b.type === 'tool_use' || b.type === 'toolCall')
    .map(b => ({
      id: b.id || b.toolCallId || '',
      name: b.name || '',
      args: JSON.stringify(b.input || b.arguments || {})
    }));
}

function extractToolResult(msg) {
  if (!msg) return null;
  if (msg.role === 'toolResult' || msg.role === 'tool') {
    const content = Array.isArray(msg.content)
      ? msg.content.map(b => b.text || '').join('\n')
      : (typeof msg.content === 'string' ? msg.content : '');
    return { toolCallId: msg.toolCallId || '', toolName: msg.toolName || '', content: content.slice(0, 10000) };
  }
  return null;
}

function extractFilePaths(toolName, toolArgs) {
  const paths = [];
  if (!toolArgs) return paths;
  try {
    const args = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
    // Common field names for file paths
    for (const key of ['path', 'file_path', 'filePath', 'file', 'filename']) {
      if (args[key] && typeof args[key] === 'string') paths.push(args[key]);
    }
  } catch {}
  return paths;
}

function indexFile(db, filePath, agentName, stmts, archiveMode) {
  const stat = fs.statSync(filePath);
  const mtime = stat.mtime.toISOString();

  if (!REINDEX) {
    const state = stmts.getState.get(filePath);
    if (state && state.last_modified === mtime) return { skipped: true };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return { skipped: true };

  let sessionId = null;
  let sessionStart = null;
  let sessionEnd = null;
  let msgCount = 0;
  let toolCount = 0;
  let model = null;
  let summary = '';
  let sessionType = null;
  let agent = agentName;
  let totalCost = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let initialPrompt = null;
  let firstMessageId = null;
  let firstMessageTimestamp = null;

  const firstLine = JSON.parse(lines[0]);
  if (firstLine.type === 'session') {
    sessionId = firstLine.id;
    sessionStart = firstLine.timestamp;
    // Parse agent info from session metadata
    if (firstLine.agent) agent = firstLine.agent;
    if (firstLine.sessionType) sessionType = firstLine.sessionType;
    // Detect sub-agent from ID patterns
    if (sessionId.includes('subagent')) sessionType = 'subagent';

    stmts.deleteEvents.run(sessionId);
    stmts.deleteSession.run(sessionId);
    stmts.deleteFileActivity.run(sessionId);
    if (stmts.deleteArchive) stmts.deleteArchive.run(sessionId);
  } else {
    return { skipped: true };
  }

  const pendingEvents = [];
  const fileActivities = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'session' || obj.type === 'model_change' || obj.type === 'thinking_level_change' || obj.type === 'custom') {
      if (obj.type === 'model_change') model = obj.modelId || model;
      continue;
    }

    if (obj.type === 'message' && obj.message) {
      const msg = obj.message;
      const ts = obj.timestamp;
      sessionEnd = ts;

      // Cost tracking
      if (msg.usage && msg.usage.cost && typeof msg.usage.cost.total === 'number') {
        totalCost += msg.usage.cost.total;
      }
      if (msg.usage && typeof msg.usage.totalTokens === 'number') {
        totalTokens += msg.usage.totalTokens;
      }
      if (msg.usage) {
        if (typeof msg.usage.input === 'number') totalInputTokens += msg.usage.input;
        if (typeof msg.usage.output === 'number') totalOutputTokens += msg.usage.output;
        if (typeof msg.usage.cacheRead === 'number') totalCacheReadTokens += msg.usage.cacheRead;
        if (typeof msg.usage.cacheWrite === 'number') totalCacheWriteTokens += msg.usage.cacheWrite;
      }

      const tr = extractToolResult(msg);
      if (tr) {
        pendingEvents.push([obj.id, sessionId, ts, 'tool_result', 'tool', tr.content, tr.toolName, null, tr.content]);
        continue;
      }

      const content = extractContent(msg);
      const role = msg.role || 'unknown';

      if (content) {
        pendingEvents.push([obj.id, sessionId, ts, 'message', role, content, null, null, null]);
        msgCount++;
        // Better summary: skip heartbeat messages
        if (!summary && role === 'user' && !isHeartbeat(content)) {
          summary = content.slice(0, 200);
        }
        // Capture initial prompt from first substantial user message
        if (!initialPrompt && role === 'user' && content.trim().length > 10 && !isHeartbeat(content)) {
          initialPrompt = content.slice(0, 500); // Limit to 500 chars
          firstMessageId = obj.id;
          firstMessageTimestamp = ts;
        }
      }

      const tools = extractToolCalls(msg);
      for (const tool of tools) {
        pendingEvents.push([tool.id || `${obj.id}-${tool.name}`, sessionId, ts, 'tool_call', role, null, tool.name, tool.args, null]);
        toolCount++;

        // File activity tracking
        const fps = extractFilePaths(tool.name, tool.args);
        for (const fp of fps) {
          const op = tool.name.includes('write') || tool.name === 'Write' ? 'write'
            : tool.name.includes('edit') || tool.name === 'Edit' ? 'edit'
            : 'read';
          fileActivities.push([sessionId, fp, op, ts]);
        }
      }
    }
  }

  // If no real summary found, check if it's a heartbeat session
  if (!summary) {
    summary = 'Heartbeat session';
  }

  stmts.upsertSession.run(sessionId, sessionStart, sessionEnd, msgCount, toolCount, model, summary, agent, sessionType, totalCost, totalTokens, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, initialPrompt, firstMessageId, firstMessageTimestamp);
  for (const ev of pendingEvents) stmts.insertEvent.run(...ev);
  for (const fa of fileActivities) stmts.insertFileActivity.run(...fa);

  // Archive mode: store raw JSONL lines
  if (archiveMode && stmts.insertArchive) {
    for (let i = 0; i < lines.length; i++) {
      stmts.insertArchive.run(sessionId, i + 1, lines[i]);
    }
  }

  stmts.upsertState.run(filePath, lines.length, mtime);

  return { sessionId, msgCount, toolCount };
}

function run() {
  const config = loadConfig();
  init();
  const db = open();
  const archiveMode = config.storage === 'archive';

  console.log(`AgentActa indexer running in ${config.storage} mode`);

  const stmts = createStmts(db);

  const sessionDirs = discoverSessionDirs(config);
  console.log(`Discovered ${sessionDirs.length} session directories:`);
  sessionDirs.forEach(d => console.log(`  ${d.agent}: ${d.path}`));

  let allFiles = [];
  for (const dir of sessionDirs) {
    const files = fs.readdirSync(dir.path)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: path.join(dir.path, f), agent: dir.agent }));
    allFiles.push(...files);
  }

  console.log(`Found ${allFiles.length} session files`);

  const indexMany = db.transaction(() => {
    let indexed = 0;
    for (const f of allFiles) {
      const result = indexFile(db, f.path, f.agent, stmts, archiveMode);
      if (!result.skipped) {
        indexed++;
        if (indexed % 10 === 0) process.stdout.write('.');
      }
    }
    return indexed;
  });

  const count = indexMany();
  console.log(`\nIndexed ${count} sessions`);

  const stats = db.prepare('SELECT COUNT(*) as sessions FROM sessions').get();
  const evStats = db.prepare('SELECT COUNT(*) as events FROM events').get();
  console.log(`Total: ${stats.sessions} sessions, ${evStats.events} events`);

  if (WATCH) {
    console.log('\nWatching for changes...');
    for (const dir of sessionDirs) {
      fs.watch(dir.path, { persistent: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const filePath = path.join(dir.path, filename);
        if (!fs.existsSync(filePath)) return;
        setTimeout(() => {
          try {
            const result = indexFile(db, filePath, dir.agent, stmts, archiveMode);
            if (!result.skipped) console.log(`Re-indexed: ${filename} (${dir.agent})`);
          } catch (err) {
            console.error(`Error re-indexing ${filename}:`, err.message);
          }
        }, 500);
      });
    }
  } else {
    db.close();
  }
}

function indexAll(db, config) {
  const sessionDirs = discoverSessionDirs(config);
  const archiveMode = config.storage === 'archive';
  const stmts = createStmts(db);
  let totalSessions = 0;
  for (const dir of sessionDirs) {
    const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const result = indexFile(db, path.join(dir.path, file), dir.agent, stmts, archiveMode);
      if (!result.skipped) totalSessions++;
    }
  }
  const stats = db.prepare('SELECT COUNT(*) as sessions FROM sessions').get();
  const evStats = db.prepare('SELECT COUNT(*) as events FROM events').get();
  return { sessions: stats.sessions, events: evStats.events, newSessions: totalSessions };
}

module.exports = { discoverSessionDirs, indexFile, indexAll };

if (require.main === module) run();

const fs = require('fs');
const path = require('path');
const { open, init, createStmts } = require('./db');
const { loadConfig } = require('./config');

const REINDEX = process.argv.includes('--reindex');
const WATCH = process.argv.includes('--watch');

function listJsonlFiles(baseDir, recursive = false) {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }

  walk(baseDir);
  return out;
}

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

  // Scan ~/.claude/projects/*/ (Claude Code stores JSONL directly in project dirs)
  const claudeProjects = path.join(home, '.claude/projects');
  if (fs.existsSync(claudeProjects)) {
    for (const proj of fs.readdirSync(claudeProjects)) {
      const projDir = path.join(claudeProjects, proj);
      // Claude Code: JSONL files directly in project dir
      if (fs.existsSync(projDir) && fs.statSync(projDir).isDirectory()) {
        const hasJsonl = fs.readdirSync(projDir).some(f => f.endsWith('.jsonl'));
        if (hasJsonl) dirs.push({ path: projDir, agent: 'claude-code' });
      }
      // Also check sessions/ subdirectory (future-proofing)
      const sp = path.join(projDir, 'sessions');
      if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
        dirs.push({ path: sp, agent: 'claude-code' });
      }
    }
  }

  // Scan ~/.codex/sessions recursively (Codex CLI stores nested YYYY/MM/DD/*.jsonl)
  const codexSessions = path.join(home, '.codex/sessions');
  if (fs.existsSync(codexSessions) && fs.statSync(codexSessions).isDirectory()) {
    dirs.push({ path: codexSessions, agent: 'codex-cli', recursive: true });
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

function isBoilerplatePrompt(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('<permissions instructions>')
    || lower.includes('filesystem sandboxing defines which files can be read or written')
    || lower.includes('# agents.md instructions for ');
}

function isSummaryCandidate(text) {
  if (!text || text.trim().length <= 10) return false;
  if (isHeartbeat(text)) return false;
  if (isBoilerplatePrompt(text)) return false;
  return true;
}

function stripLeadingDatetimePrefix(text) {
  if (!text) return text;
  return text
    .replace(/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}[^\]]*\]\s*/i, '')
    .trim();
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

function extractCodexMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.output_text === 'string') return part.output_text;
      if (typeof part.input_text === 'string') return part.input_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractFilePaths(toolName, toolArgs) {
  const paths = [];
  if (!toolArgs) return paths;

  const maybePath = (value) => {
    if (typeof value !== 'string') return;
    if (value.startsWith('/') || value.startsWith('~/') || value.startsWith('./') || value.startsWith('../')) {
      paths.push(value);
      return;
    }
    if (value.includes('/') || value.includes('\\')) paths.push(value);
  };

  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) visit(item);
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        if (['path', 'file_path', 'filePath', 'file', 'filename', 'cwd', 'workdir', 'directory', 'dir'].includes(key)) {
          maybePath(value);
        }
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };

  try {
    const args = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
    visit(args);
  } catch {}

  return [...new Set(paths)];
}

function aliasProject(project, config) {
  if (!project) return project;
  const aliases = (config && config.projectAliases && typeof config.projectAliases === 'object') ? config.projectAliases : {};
  return aliases[project] || project;
}

function extractProjectFromPath(filePath, config) {
  if (!filePath || typeof filePath !== 'string') return null;

  const normalized = filePath.replace(/\\/g, '/');

  // Relative paths are usually from workspace cwd -> treat as workspace activity
  if (!normalized.startsWith('/') && !normalized.startsWith('~')) return aliasProject('workspace', config);

  let rel = normalized
    .replace(/^\/home\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^~\//, '');

  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;

  // Common repo location: ~/Developer/<repo>/...
  if (parts[0] === 'Developer' && parts[1]) return aliasProject(parts[1], config);

  // OpenClaw workspace and agent stores
  if (parts[0] === '.openclaw' && parts[1] === 'workspace') return aliasProject('workspace', config);
  if (parts[0] === '.openclaw' && parts[1] === 'agents' && parts[2]) return aliasProject(`agent:${parts[2]}`, config);

  // Claude Code projects
  if (parts[0] === '.claude' && parts[1] === 'projects' && parts[2]) return aliasProject(`claude:${parts[2]}`, config);

  // Shared files area
  if (parts[0] === 'Shared') return aliasProject('shared', config);

  return null;
}

function indexFile(db, filePath, agentName, stmts, archiveMode, config) {
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
  const modelsSet = new Set();
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
  let codexProvider = null;
  let codexSource = null;
  let sawSnapshotRecord = false;
  let sawNonSnapshotRecord = false;

  let firstLine;
  try {
    firstLine = JSON.parse(lines[0]);
  } catch {
    return { skipped: true };
  }

  let isClaudeCode = false;
  let isCodexCli = false;

  if (firstLine.type === 'session') {
    // OpenClaw format
    sessionId = firstLine.id;
    sessionStart = firstLine.timestamp;
    if (firstLine.agent) agent = firstLine.agent;
    if (firstLine.sessionType) sessionType = firstLine.sessionType;
    if (sessionId.includes('subagent')) sessionType = 'subagent';
  } else if (firstLine.type === 'user' || firstLine.type === 'assistant' || firstLine.type === 'file-history-snapshot') {
    // Claude Code format — no session header, extract from first message line
    isClaudeCode = true;
    for (const line of lines) {
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if ((obj.type === 'user' || obj.type === 'assistant') && obj.sessionId) {
        sessionId = obj.sessionId;
        sessionStart = obj.timestamp;
        break;
      }
    }
    if (!sessionId) {
      // Fallback: use filename as session ID
      sessionId = path.basename(filePath, '.jsonl');
      sessionStart = new Date(firstLine.timestamp || Date.now()).toISOString();
    }
  } else if (firstLine.type === 'session_meta') {
    // Codex CLI format
    isCodexCli = true;
    const meta = firstLine.payload || {};
    sessionId = meta.id || path.basename(filePath, '.jsonl');
    sessionStart = meta.timestamp || firstLine.timestamp || new Date().toISOString();
    sessionType = 'codex-cli';
    agent = 'codex-cli';
    if (meta.model) {
      model = meta.model;
      modelsSet.add(meta.model);
    }
    codexProvider = meta.model_provider || null;
    codexSource = meta.source || null;
  } else {
    return { skipped: true };
  }

  // --- Parse the entire file BEFORE any DB operations ---
  const pendingEvents = [];
  const fileActivities = [];
  const projectCounts = new Map();

  // Seed project from session cwd when available (helps chat-only sessions)
  const sessionCwd = (firstLine && firstLine.cwd) || (firstLine && firstLine.payload && firstLine.payload.cwd);
  if (sessionCwd) {
    const p = extractProjectFromPath(sessionCwd, config);
    if (p) projectCounts.set(p, 1);
  }

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'file-history-snapshot') sawSnapshotRecord = true;
    else sawNonSnapshotRecord = true;

    if (isCodexCli) {
      if (obj.type === 'session_meta') {
        const meta = obj.payload || {};
        if (meta.id) sessionId = meta.id;
        if (meta.timestamp && !sessionStart) sessionStart = meta.timestamp;
        if (meta.model) {
          if (!model) model = meta.model;
          modelsSet.add(meta.model);
        }
        if (meta.model_provider) codexProvider = meta.model_provider;
        if (meta.source) codexSource = meta.source;
        if (meta.model_provider && !model) model = meta.model_provider;
        continue;
      }

      if (obj.type === 'turn_context' && obj.payload) {
        const tc = obj.payload;
        if (tc.model && typeof tc.model === 'string') {
          if (!model || model === codexProvider) model = tc.model;
          modelsSet.add(tc.model);
        }
        continue;
      }

      if (obj.type === 'response_item' && obj.payload) {
        const p = obj.payload;
        const ts = obj.timestamp || sessionStart;
        const eventId = `evt-${obj.type}-${Date.parse(ts) || Math.random()}`;

        if (p.type === 'function_call') {
          const toolName = p.name || p.tool_name || '';
          const toolArgs = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {});
          const callBaseId = p.call_id || p.id || eventId;
          pendingEvents.push([`${callBaseId}:call`, sessionId, ts, 'tool_call', 'assistant', null, toolName, toolArgs, null]);
          toolCount++;

          const fps = extractFilePaths(toolName, toolArgs);
          for (const fp of fps) {
            fileActivities.push([sessionId, fp, 'read', ts]);
            const project = extractProjectFromPath(fp, config);
            if (project) projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
          }
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'function_call_output') {
          const output = (typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '')).slice(0, 10000);
          const resultBaseId = p.call_id || p.id || eventId;
          pendingEvents.push([`${resultBaseId}:result`, sessionId, ts, 'tool_result', 'tool', output, p.name || p.tool_name || '', null, output]);
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'message') {
          const rawRole = p.role || 'assistant';
          const role = rawRole === 'assistant' ? 'assistant' : 'user';
          const content = extractCodexMessageText(p.content);
          if (content) {
            pendingEvents.push([p.id || eventId, sessionId, ts, 'message', role, content, null, null, null]);
            msgCount++;
            if (!summary && role === 'user' && isSummaryCandidate(content)) summary = content.slice(0, 200);
            if (!initialPrompt && role === 'user' && isSummaryCandidate(content)) {
              initialPrompt = content.slice(0, 500);
              firstMessageId = p.id || eventId;
              firstMessageTimestamp = ts;
            }
          }
          sessionEnd = ts;
          continue;
        }
      }

      if (obj.type === 'event_msg' && obj.payload) {
        const p = obj.payload;
        const ts = obj.timestamp || sessionStart;
        const eventId = `evt-${p.type || 'event'}-${Date.parse(ts) || Math.random()}`;

        if (p.type === 'agent_message' && p.message) {
          pendingEvents.push([eventId, sessionId, ts, 'message', 'assistant', p.message, null, null, null]);
          msgCount++;
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'user_message' && p.message) {
          pendingEvents.push([eventId, sessionId, ts, 'message', 'user', p.message, null, null, null]);
          msgCount++;
          if (!summary && isSummaryCandidate(p.message)) summary = p.message.slice(0, 200);
          if (!initialPrompt && isSummaryCandidate(p.message)) {
            initialPrompt = p.message.slice(0, 500);
            firstMessageId = eventId;
            firstMessageTimestamp = ts;
          }
          sessionEnd = ts;
          continue;
        }
      }

      continue;
    }

    if (obj.type === 'session' || obj.type === 'model_change' || obj.type === 'thinking_level_change' || obj.type === 'custom' || obj.type === 'file-history-snapshot') {
      if (obj.type === 'model_change' && obj.modelId) {
        if (!model) model = obj.modelId; // First model for backwards compat
        modelsSet.add(obj.modelId); // Collect all unique models
      }
      continue;
    }

    // Normalize: Claude Code uses top-level type "user"/"assistant" with message object
    // OpenClaw uses type "message" with message.role
    let msg, ts;
    if (obj.type === 'message' && obj.message) {
      msg = obj.message;
      ts = obj.timestamp;
    } else if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) {
      // Claude Code format: wrap into consistent shape
      msg = obj.message;
      if (!msg.role) msg.role = obj.type === 'user' ? 'user' : 'assistant';
      ts = obj.timestamp;
    } else {
      continue;
    }

    if (msg) {
      sessionEnd = ts;

      // Extract model from assistant messages
      if (msg.role === 'assistant' && msg.model && msg.model !== 'delivery-mirror' && !msg.model.startsWith('<')) {
        if (!model) model = msg.model; // Keep first model for backwards compat
        modelsSet.add(msg.model); // Collect all unique models
      }

      // Cost tracking
      if (msg.usage && msg.usage.cost && typeof msg.usage.cost.total === 'number') {
        totalCost += msg.usage.cost.total;
      }
      if (msg.usage && typeof msg.usage.totalTokens === 'number') {
        totalTokens += msg.usage.totalTokens;
      }
      if (msg.usage) {
        // OpenClaw format
        if (typeof msg.usage.input === 'number') totalInputTokens += msg.usage.input;
        if (typeof msg.usage.output === 'number') totalOutputTokens += msg.usage.output;
        if (typeof msg.usage.cacheRead === 'number') totalCacheReadTokens += msg.usage.cacheRead;
        if (typeof msg.usage.cacheWrite === 'number') totalCacheWriteTokens += msg.usage.cacheWrite;
        // Claude Code format
        if (typeof msg.usage.input_tokens === 'number') totalInputTokens += msg.usage.input_tokens;
        if (typeof msg.usage.output_tokens === 'number') totalOutputTokens += msg.usage.output_tokens;
        if (typeof msg.usage.cache_read_input_tokens === 'number') totalCacheReadTokens += msg.usage.cache_read_input_tokens;
        if (typeof msg.usage.cache_creation_input_tokens === 'number') totalCacheWriteTokens += msg.usage.cache_creation_input_tokens;
      }

      const eventId = obj.id || obj.uuid || `evt-${Date.parse(ts) || Math.random()}`;

      const tr = extractToolResult(msg);
      if (tr) {
        pendingEvents.push([eventId, sessionId, ts, 'tool_result', 'tool', tr.content, tr.toolName, null, tr.content]);
        continue;
      }

      const content = extractContent(msg);
      const role = msg.role || 'unknown';

      if (content) {
        pendingEvents.push([eventId, sessionId, ts, 'message', role, content, null, null, null]);
        msgCount++;
        // Better summary: skip heartbeat/boilerplate messages
        if (!summary && role === 'user' && isSummaryCandidate(content)) {
          summary = content.slice(0, 200);
        }
        // Capture initial prompt from first substantial user message
        if (!initialPrompt && role === 'user' && isSummaryCandidate(content)) {
          initialPrompt = content.slice(0, 500); // Limit to 500 chars
          firstMessageId = eventId;
          firstMessageTimestamp = ts;
        }
      }

      const tools = extractToolCalls(msg);
      for (const tool of tools) {
        pendingEvents.push([tool.id || `${eventId}-${tool.name}`, sessionId, ts, 'tool_call', role, null, tool.name, tool.args, null]);
        toolCount++;

        // File activity tracking
        const fps = extractFilePaths(tool.name, tool.args);
        for (const fp of fps) {
          const op = tool.name.includes('write') || tool.name === 'Write' ? 'write'
            : tool.name.includes('edit') || tool.name === 'Edit' ? 'edit'
            : 'read';
          fileActivities.push([sessionId, fp, op, ts]);

          const project = extractProjectFromPath(fp, config);
          if (project) projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
        }
      }
    }
  }

  // Classify snapshot-only Claude files explicitly (avoid heartbeat mislabel)
  if (isClaudeCode && sawSnapshotRecord && !sawNonSnapshotRecord) {
    sessionType = 'snapshot';
    if (!summary) summary = 'Claude file snapshot';
  }

  // Normalize summary text
  if (summary) summary = stripLeadingDatetimePrefix(summary);

  // If no real summary found, set a sensible default
  if (!summary) {
    if (isCodexCli) {
      const parts = ['Codex CLI session'];
      if (codexProvider) parts.push(`provider=${codexProvider}`);
      if (codexSource) parts.push(`source=${codexSource}`);
      summary = parts.join(' · ');
    } else {
      summary = 'Heartbeat session';
    }
  }

  // Infer session type from first user message content
  if (!sessionType && initialPrompt) {
    const p = initialPrompt.toLowerCase();
    if (p.includes('[cron:')) sessionType = 'cron';
    else if (p.includes('heartbeat') && p.includes('heartbeat_ok')) sessionType = 'heartbeat';
  }
  if (!sessionType && !initialPrompt) sessionType = 'heartbeat';
  // Detect subagent: task-style prompts injected by sessions_spawn
  if (!sessionType && initialPrompt) {
    const p = initialPrompt.trim();
    if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-/.test(p) && !p.includes('[System Message]')) {
      sessionType = 'subagent';
    }
  }

  const modelsJson = modelsSet.size > 0 ? JSON.stringify([...modelsSet]) : null;
  const projects = [...projectCounts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  const projectsJson = projects.length > 0 ? JSON.stringify(projects) : null;

  // --- All DB operations in a single transaction for atomicity ---
  const commitIndex = db.transaction(() => {
    stmts.deleteEvents.run(sessionId);
    stmts.deleteFileActivity.run(sessionId);
    if (stmts.deleteArchive) stmts.deleteArchive.run(sessionId);
    stmts.deleteSession.run(sessionId);

    stmts.upsertSession.run(sessionId, sessionStart, sessionEnd, msgCount, toolCount, model, summary, agent, sessionType, totalCost, totalTokens, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, initialPrompt, firstMessageId, firstMessageTimestamp, modelsJson, projectsJson);
    for (const ev of pendingEvents) stmts.insertEvent.run(...ev);
    for (const fa of fileActivities) stmts.insertFileActivity.run(...fa);

    // Archive mode: store raw JSONL lines
    if (archiveMode && stmts.insertArchive) {
      for (let i = 0; i < lines.length; i++) {
        stmts.insertArchive.run(sessionId, i + 1, lines[i]);
      }
    }

    stmts.upsertState.run(filePath, lines.length, mtime);
  });

  commitIndex();

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
    const files = listJsonlFiles(dir.path, !!dir.recursive)
      .map(filePath => ({ path: filePath, agent: dir.agent }));
    allFiles.push(...files);
  }

  console.log(`Found ${allFiles.length} session files`);

  const indexMany = db.transaction(() => {
    let indexed = 0;
    for (const f of allFiles) {
      const result = indexFile(db, f.path, f.agent, stmts, archiveMode, config);
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
    const rescanTimers = new Map();

    for (const dir of sessionDirs) {
      fs.watch(dir.path, { persistent: true }, (eventType, filename) => {
        // Recursive sources (e.g. ~/.codex/sessions/YYYY/MM/DD/*.jsonl):
        // fs.watch on Linux does not watch nested dirs recursively, so on any root event
        // run a debounced full rescan of known JSONL files under this source.
        if (dir.recursive) {
          const key = dir.path;
          if (rescanTimers.get(key)) clearTimeout(rescanTimers.get(key));
          const t = setTimeout(() => {
            try {
              const files = listJsonlFiles(dir.path, true);
              let changed = 0;
              for (const filePath of files) {
                const result = indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
                if (!result.skipped) changed++;
              }
              if (changed > 0) console.log(`Re-indexed ${changed} files (${dir.agent})`);
            } catch (err) {
              console.error(`Error rescanning ${dir.path}:`, err.message);
            }
          }, 500);
          rescanTimers.set(key, t);
          return;
        }

        if (!filename || !filename.endsWith('.jsonl')) return;
        const filePath = path.join(dir.path, filename);
        if (!fs.existsSync(filePath)) return;
        setTimeout(() => {
          try {
            const result = indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
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
    const files = listJsonlFiles(dir.path, !!dir.recursive);
    for (const filePath of files) {
      try {
        const result = indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
        if (!result.skipped) totalSessions++;
      } catch (err) {
        console.error(`Error indexing ${path.basename(filePath)}:`, err.message);
      }
    }
  }
  const stats = db.prepare('SELECT COUNT(*) as sessions FROM sessions').get();
  const evStats = db.prepare('SELECT COUNT(*) as events FROM events').get();
  return { sessions: stats.sessions, events: evStats.events, newSessions: totalSessions };
}

module.exports = { discoverSessionDirs, indexFile, indexAll };

if (require.main === module) run();

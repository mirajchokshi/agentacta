import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentActaConfig,
  SessionDir,
  IndexResult,
  IndexAllResult,
  ExtractedToolCall,
  ExtractedToolResult,
  PreparedStatements,
  IndexStateRow,
  JsonlLine,
  ContentBlock,
  CronMetadata,
  CodexSessionMeta,
  CodexResponsePayload,
  CodexEventPayload,
  CountRow,
  HasEventsRow,
} from './types.js';
import { open, init, createStmts } from './db.js';
import { loadConfig } from './config.js';

const REINDEX: boolean = process.argv.includes('--reindex');
const WATCH: boolean = process.argv.includes('--watch');

function listJsonlFiles(baseDir: string, recursive: boolean = false): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const out: string[] = [];

  function walk(dir: string): void {
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

function discoverSessionDirs(config: AgentActaConfig): SessionDir[] {
  const dirs: SessionDir[] = [];
  const home = process.env.HOME as string;
  const codexSessionsPath = path.join(home, '.codex/sessions');
  const cronRunsPath = path.join(home, '.openclaw/cron/runs');

  function normalizedPath(p: string): string {
    return path.resolve(p).replace(/[\\\/]+$/, '');
  }

  function hasDir(targetPath: string, sourceType: string = 'transcript'): boolean {
    const wanted = normalizedPath(targetPath);
    return dirs.some(d => normalizedPath(d.path) === wanted && (d.sourceType || 'transcript') === sourceType);
  }

  function addDir(dir: SessionDir | null): void {
    if (!dir || !dir.path) return;
    if (hasDir(dir.path, dir.sourceType || 'transcript')) return;
    dirs.push(dir);
  }

  // Expand a single path into session dirs, handling Claude Code's per-project structure
  function expandPath(p: string): void {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return;
    const normalized = normalizedPath(p);
    const normalizedCodex = normalizedPath(codexSessionsPath);
    // Claude Code: ~/.claude/projects contains per-project subdirs with JSONL files
    if (normalized.endsWith('/.claude/projects')) {
      for (const proj of fs.readdirSync(p)) {
        const projDir = path.join(p, proj);
        if (fs.statSync(projDir).isDirectory()) {
          const hasJsonl = fs.readdirSync(projDir).some(f => f.endsWith('.jsonl'));
          if (hasJsonl) addDir({ path: projDir, agent: 'claude-code' });
        }
      }
    } else if (normalized === normalizedCodex) {
      // Codex CLI stores nested YYYY/MM/DD directories and must be recursive.
      addDir({ path: p, agent: 'codex-cli', recursive: true });
    } else {
      addDir({ path: p, agent: path.basename(path.dirname(p)) });
    }
  }

  // Config sessionsPath or env var override
  const sessionsOverride = process.env.AGENTACTA_SESSIONS_PATH || (config && config.sessionsPath);
  if (sessionsOverride) {
    const overridePaths: string[] = Array.isArray(sessionsOverride)
      ? sessionsOverride
      : sessionsOverride.split(':');
    overridePaths.forEach(expandPath);
  }

  // Auto-discover: ~/.openclaw/agents/*/sessions/
  const oclawAgents = path.join(home, '.openclaw/agents');
  if (fs.existsSync(oclawAgents)) {
    for (const agent of fs.readdirSync(oclawAgents)) {
      const sp = path.join(oclawAgents, agent, 'sessions');
      if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
        addDir({ path: sp, agent });
      }
    }
  }

  // Auto-discover: ~/.claude/projects/
  expandPath(path.join(home, '.claude/projects'));

  // Scan ~/.codex/sessions recursively (Codex CLI stores nested YYYY/MM/DD/*.jsonl)
  const codexSessions = codexSessionsPath;
  if (fs.existsSync(codexSessions) && fs.statSync(codexSessions).isDirectory()) {
    addDir({ path: codexSessions, agent: 'codex-cli', recursive: true });
  }

  // Fallback synthetic source for cron-backed runs that have metadata but no transcript JSONL.
  if (fs.existsSync(cronRunsPath) && fs.statSync(cronRunsPath).isDirectory()) {
    addDir({ path: cronRunsPath, agent: 'cron', sourceType: 'cron-run' });
  }

  if (!dirs.length) {
    // Fallback to hardcoded
    const fallback = path.join(home, '.openclaw/agents/main/sessions');
    if (fs.existsSync(fallback)) addDir({ path: fallback, agent: 'main' });
  }

  return dirs;
}

function isHeartbeat(text: string | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('heartbeat') || lower.includes('heartbeat_ok');
}

function isBoilerplatePrompt(text: string | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('<permissions instructions>')
    || lower.includes('filesystem sandboxing defines which files can be read or written')
    || lower.includes('# agents.md instructions for ');
}

function isSummaryCandidate(text: string | null): boolean {
  if (!text || text.trim().length <= 10) return false;
  if (isHeartbeat(text)) return false;
  if (isBoilerplatePrompt(text)) return false;
  return true;
}

function stripLeadingDatetimePrefix(text: string | null): string {
  if (!text) return text as string;
  return text
    .replace(/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}[^\]]*\]\s*/i, '')
    .trim();
}

function extractContent(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as Record<string, unknown>;
  if (!m.content) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

function extractToolCalls(msg: unknown): ExtractedToolCall[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as Record<string, unknown>;
  if (!Array.isArray(m.content)) return [];
  return (m.content as ContentBlock[])
    .filter(b => b.type === 'tool_use' || b.type === 'toolCall')
    .map(b => ({
      id: b.id || (b as Record<string, unknown>).toolCallId as string || '',
      name: b.name || '',
      args: JSON.stringify(b.input || b.arguments || {})
    }));
}

function extractToolResult(msg: unknown): ExtractedToolResult | null {
  if (!msg) return null;
  const m = msg as Record<string, unknown>;
  if (m.role === 'toolResult' || m.role === 'tool') {
    const content = Array.isArray(m.content)
      ? (m.content as ContentBlock[]).map(b => b.text || '').join('\n')
      : (typeof m.content === 'string' ? m.content : '');
    return { toolCallId: (m.toolCallId as string) || '', toolName: (m.toolName as string) || '', content: content.slice(0, 10000) };
  }
  return null;
}

function extractCodexMessageText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return (content as Array<Record<string, unknown>>)
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

function extractFilePaths(toolName: string, toolArgs: unknown): string[] {
  const paths: string[] = [];
  if (!toolArgs) return paths;

  const maybePath = (value: unknown): void => {
    if (typeof value !== 'string') return;
    if (value.startsWith('/') || value.startsWith('~/') || value.startsWith('./') || value.startsWith('../')) {
      paths.push(value);
      return;
    }
    if (value.includes('/') || value.includes('\\')) paths.push(value);
  };

  const visit = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) visit(item);
      return;
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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
    const args: unknown = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
    visit(args);
  } catch {
    // ignore parse errors
  }

  return [...new Set(paths)];
}

function aliasProject(project: string | null, config: AgentActaConfig): string | null {
  if (!project) return project;
  const aliases = (config && config.projectAliases && typeof config.projectAliases === 'object') ? config.projectAliases : {};
  return aliases[project] || project;
}

function extractProjectFromPath(filePath: string, config: AgentActaConfig): string | null {
  if (!filePath || typeof filePath !== 'string') return null;

  const normalized = filePath.replace(/\\/g, '/');

  // Relative paths are usually from workspace cwd -> treat as workspace activity
  if (!normalized.startsWith('/') && !normalized.startsWith('~')) return aliasProject('workspace', config);

  const rel = normalized
    .replace(/^\/home\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^~\//, '');

  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;

  // Common repo location: ~/Developer/<repo>/...
  if (parts[0] === 'Developer' && parts[1]) return aliasProject(parts[1], config);
  // Symphony worktrees: ~/symphony-workspaces/<issue>/...
  if (parts[0] === 'symphony-workspaces' && parts[1]) return aliasProject(parts[1], config);

  // OpenClaw workspace and agent stores
  if (parts[0] === '.openclaw' && parts[1] === 'workspace') return aliasProject('workspace', config);
  if (parts[0] === '.openclaw' && parts[1] === 'agents' && parts[2]) return aliasProject(`agent:${parts[2]}`, config);

  // Claude Code projects
  if (parts[0] === '.claude' && parts[1] === 'projects' && parts[2]) return aliasProject(`claude:${parts[2]}`, config);

  // Shared files area
  if (parts[0] === 'Shared') return aliasProject('shared', config);

  return null;
}

function indexCronRunFile(db: Database.Database, filePath: string, agentName: string, stmts: PreparedStatements): IndexResult {
  const stat = fs.statSync(filePath);
  const mtime = stat.mtime.toISOString();

  if (!REINDEX) {
    const state = stmts.getState.get(filePath) as IndexStateRow | undefined;
    if (state && state.last_modified === mtime) return { skipped: true };
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return { skipped: true };

  let meta: CronMetadata;
  try {
    meta = JSON.parse(raw.split('\n').find(Boolean) as string) as CronMetadata;
  } catch {
    return { skipped: true };
  }

  const sessionId = meta.sessionId;
  if (!sessionId) return { skipped: true };

  // Guard: don't overwrite a session that was already indexed from a real transcript.
  // Check both event presence AND session_type — a transcript session with zero events
  // (e.g. header-only file) should still win over synthetic cron metadata.
  const existingSession = db.prepare('SELECT session_type FROM sessions WHERE id = ?').get(sessionId) as { session_type: string | null } | undefined;
  if (existingSession && existingSession.session_type !== 'cron') {
    stmts.upsertState.run(filePath, 1, mtime);
    return { skipped: true, preferredTranscript: true, sessionId };
  }
  const existingRealSession = db.prepare('SELECT EXISTS(SELECT 1 FROM events WHERE session_id = ?) AS has_events').get(sessionId) as HasEventsRow | undefined;
  if (existingRealSession && existingRealSession.has_events) {
    stmts.upsertState.run(filePath, 1, mtime);
    return { skipped: true, preferredTranscript: true, sessionId };
  }

  const ts = typeof meta.ts === 'number' ? new Date(meta.ts).toISOString() : new Date().toISOString();
  const runAt = typeof meta.runAtMs === 'number' ? new Date(meta.runAtMs).toISOString() : ts;
  const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : null;
  const endTime = ts;
  const startTime = durationMs ? new Date(new Date(endTime).getTime() - durationMs).toISOString() : runAt;
  const summary = stripLeadingDatetimePrefix(meta.summary || 'Cron run');
  const sessionKey = typeof meta.sessionKey === 'string' ? meta.sessionKey : '';
  const sessionKeyParts = sessionKey.split(':');
  const inferredAgent = sessionKeyParts[0] === 'agent' && sessionKeyParts[1] ? sessionKeyParts[1] : agentName;
  const model = meta.model || meta.provider || null;
  const totalInputTokens = meta.usage && typeof meta.usage.input_tokens === 'number' ? meta.usage.input_tokens : 0;
  const totalOutputTokens = meta.usage && typeof meta.usage.output_tokens === 'number' ? meta.usage.output_tokens : 0;
  const totalTokens = meta.usage && typeof meta.usage.total_tokens === 'number'
    ? meta.usage.total_tokens
    : totalInputTokens + totalOutputTokens;

  const commitIndex = db.transaction(() => {
    if (stmts.deleteArchive) stmts.deleteArchive.run(sessionId);
    stmts.deleteFileActivity.run(sessionId);
    stmts.deleteEvents.run(sessionId);
    stmts.deleteSession.run(sessionId);

    stmts.upsertSession.run(
      sessionId,
      startTime,
      endTime,
      0,
      0,
      model,
      summary,
      inferredAgent,
      'cron',
      0,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      0,
      0,
      null,
      null,
      null,
      model ? JSON.stringify([model]) : null,
      null
    );

    stmts.upsertState.run(filePath, 1, mtime);
  });

  commitIndex();
  return { sessionId, synthetic: true };
}

function indexFile(db: Database.Database, filePath: string, agentName: string, stmts: PreparedStatements, archiveMode: boolean, config: AgentActaConfig): IndexResult {
  const stat = fs.statSync(filePath);
  const mtime = stat.mtime.toISOString();

  if (!REINDEX) {
    const state = stmts.getState.get(filePath) as IndexStateRow | undefined;
    if (state && state.last_modified === mtime) return { skipped: true };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return { skipped: true };

  let sessionId: string | null = null;
  let sessionStart: string | null = null;
  let sessionEnd: string | null = null;
  let msgCount = 0;
  let toolCount = 0;
  let model: string | null = null;
  const modelsSet = new Set<string>();
  let summary = '';
  let sessionType: string | null = null;
  let agent = agentName;
  let totalCost = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let initialPrompt: string | null = null;
  let firstMessageId: string | null = null;
  let firstMessageTimestamp: string | null = null;
  let codexProvider: string | null = null;
  let codexSource: string | null = null;
  let codexOriginator: string | null = null;
  let sawSnapshotRecord = false;
  let sawNonSnapshotRecord = false;

  let firstLine: JsonlLine;
  try {
    firstLine = JSON.parse(lines[0]) as JsonlLine;
  } catch {
    return { skipped: true };
  }

  let isClaudeCode = false;
  let isCodexCli = false;

  if (firstLine.type === 'session') {
    // OpenClaw format
    sessionId = firstLine.id || null;
    sessionStart = firstLine.timestamp || null;
    if (firstLine.agent) agent = firstLine.agent;
    if (firstLine.sessionType) sessionType = firstLine.sessionType;
    if (sessionId && sessionId.includes('subagent')) sessionType = 'subagent';
  } else if (firstLine.type === 'user' || firstLine.type === 'assistant' || firstLine.type === 'file-history-snapshot' || firstLine.type === 'queue-operation') {
    // Claude Code format — no session header, extract from first message or queue-operation line
    isClaudeCode = true;
    for (const line of lines) {
      let obj: JsonlLine; try { obj = JSON.parse(line) as JsonlLine; } catch { continue; }
      if (obj.sessionId && obj.timestamp) {
        sessionId = obj.sessionId;
        sessionStart = obj.timestamp;
        break;
      }
      if ((obj.type === 'user' || obj.type === 'assistant') && obj.sessionId) {
        sessionId = obj.sessionId;
        sessionStart = obj.timestamp || null;
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
    const meta = (firstLine.payload || {}) as CodexSessionMeta;
    sessionId = meta.id || path.basename(filePath, '.jsonl');
    sessionStart = meta.timestamp || firstLine.timestamp || new Date().toISOString();
    sessionType = 'codex-direct';
    agent = 'codex-cli';
    if (meta.model) {
      model = meta.model;
      modelsSet.add(meta.model);
    }
    codexProvider = meta.model_provider || null;
    codexSource = meta.source || null;
    codexOriginator = meta.originator || null;
    if (codexOriginator && codexOriginator.includes('symphony')) sessionType = 'codex-symphony';
  } else {
    return { skipped: true };
  }

  // --- Parse the entire file BEFORE any DB operations ---
  const pendingEvents: Array<[string, string, string, string, string, string | null, string | null, string | null, string | null]> = [];
  const fileActivities: Array<[string, string, string, string]> = [];
  const projectCounts: Map<string, number> = new Map();

  // Seed project from session cwd when available (helps chat-only sessions)
  const sessionCwd = (firstLine && firstLine.cwd) || (firstLine && firstLine.payload && (firstLine.payload as Record<string, unknown>).cwd as string | undefined);
  if (sessionCwd) {
    const p = extractProjectFromPath(sessionCwd, config);
    if (p) projectCounts.set(p, 1);
  }

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (obj.type === 'file-history-snapshot') sawSnapshotRecord = true;
    else sawNonSnapshotRecord = true;

    if (isCodexCli) {
      if (obj.type === 'session_meta') {
        const meta = (obj.payload || {}) as CodexSessionMeta;
        if (meta.id) sessionId = meta.id;
        if (meta.timestamp && !sessionStart) sessionStart = meta.timestamp;
        if (meta.model) {
          if (!model) model = meta.model;
          modelsSet.add(meta.model);
        }
        if (meta.model_provider) codexProvider = meta.model_provider;
        if (meta.source) codexSource = meta.source;
        if (meta.originator) codexOriginator = meta.originator;
        if (codexOriginator && codexOriginator.includes('symphony')) sessionType = 'codex-symphony';
        if (meta.model_provider && !model) model = meta.model_provider;
        continue;
      }

      if (obj.type === 'turn_context' && obj.payload) {
        const tc = obj.payload as Record<string, unknown>;
        if (tc.model && typeof tc.model === 'string') {
          if (!model || model === codexProvider) model = tc.model;
          modelsSet.add(tc.model);
        }
        continue;
      }

      if (obj.type === 'response_item' && obj.payload) {
        const p = obj.payload as CodexResponsePayload;
        const ts = (obj.timestamp as string) || sessionStart as string;
        const eventId = `evt-${obj.type}-${Date.parse(ts) || Math.random()}`;

        if (p.type === 'function_call') {
          const toolName = p.name || p.tool_name || '';
          const toolArgs = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {});
          const callBaseId = p.call_id || p.id || eventId;
          pendingEvents.push([`${callBaseId}:call`, sessionId as string, ts, 'tool_call', 'assistant', null, toolName, toolArgs, null]);
          toolCount++;

          const fps = extractFilePaths(toolName, toolArgs);
          for (const fp of fps) {
            fileActivities.push([sessionId as string, fp, 'read', ts]);
            const project = extractProjectFromPath(fp, config);
            if (project) projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
          }
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'function_call_output') {
          const output = (typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '')).slice(0, 10000);
          const resultBaseId = p.call_id || p.id || eventId;
          pendingEvents.push([`${resultBaseId}:result`, sessionId as string, ts, 'tool_result', 'tool', output, p.name || p.tool_name || '', null, output]);
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'message') {
          const rawRole = p.role || 'assistant';
          const role = rawRole === 'assistant' ? 'assistant' : 'user';
          const content = extractCodexMessageText(p.content);
          if (content) {
            pendingEvents.push([p.id || eventId, sessionId as string, ts, 'message', role, content, null, null, null]);
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
        const p = obj.payload as CodexEventPayload;
        const ts = (obj.timestamp as string) || sessionStart as string;
        const eventId = `evt-${p.type || 'event'}-${Date.parse(ts) || Math.random()}`;

        if (p.type === 'agent_message' && p.message) {
          pendingEvents.push([eventId, sessionId as string, ts, 'message', 'assistant', p.message, null, null, null]);
          msgCount++;
          sessionEnd = ts;
          continue;
        }

        if (p.type === 'user_message' && p.message) {
          pendingEvents.push([eventId, sessionId as string, ts, 'message', 'user', p.message, null, null, null]);
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
        if (!model) model = obj.modelId as string; // First model for backwards compat
        modelsSet.add(obj.modelId as string); // Collect all unique models
      }
      continue;
    }

    // Normalize: Claude Code uses top-level type "user"/"assistant" with message object
    // OpenClaw uses type "message" with message.role
    let msg: Record<string, unknown> | undefined;
    let ts: string | undefined;
    if (obj.type === 'message' && obj.message) {
      msg = obj.message as Record<string, unknown>;
      ts = obj.timestamp as string;
    } else if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) {
      // Claude Code format: wrap into consistent shape
      msg = obj.message as Record<string, unknown>;
      if (!msg.role) msg.role = obj.type === 'user' ? 'user' : 'assistant';
      ts = obj.timestamp as string;
    } else {
      continue;
    }

    if (msg) {
      sessionEnd = ts || null;

      // Extract model from assistant messages
      if (msg.role === 'assistant' && msg.model && msg.model !== 'delivery-mirror' && !(msg.model as string).startsWith('<')) {
        if (!model) model = msg.model as string; // Keep first model for backwards compat
        modelsSet.add(msg.model as string); // Collect all unique models
      }

      // Cost tracking
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) {
        const cost = usage.cost as Record<string, unknown> | undefined;
        if (cost && typeof cost.total === 'number') {
          totalCost += cost.total;
        }
        if (typeof usage.totalTokens === 'number') {
          totalTokens += usage.totalTokens;
        }
        // OpenClaw format
        if (typeof usage.input === 'number') totalInputTokens += usage.input;
        if (typeof usage.output === 'number') totalOutputTokens += usage.output;
        if (typeof usage.cacheRead === 'number') totalCacheReadTokens += usage.cacheRead;
        if (typeof usage.cacheWrite === 'number') totalCacheWriteTokens += usage.cacheWrite;
        // Claude Code format
        if (typeof usage.input_tokens === 'number') totalInputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === 'number') totalOutputTokens += usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === 'number') totalCacheReadTokens += usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === 'number') totalCacheWriteTokens += usage.cache_creation_input_tokens;
      }

      const eventId = (obj.id as string) || (obj.uuid as string) || `evt-${Date.parse(ts as string) || Math.random()}`;

      const tr = extractToolResult(msg);
      if (tr) {
        pendingEvents.push([eventId, sessionId as string, ts as string, 'tool_result', 'tool', tr.content, tr.toolName, null, tr.content]);
        continue;
      }

      const content = extractContent(msg);
      const role = (msg.role as string) || 'unknown';

      if (content) {
        pendingEvents.push([eventId, sessionId as string, ts as string, 'message', role, content, null, null, null]);
        msgCount++;
        // Better summary: skip heartbeat/boilerplate messages
        if (!summary && role === 'user' && isSummaryCandidate(content)) {
          summary = content.slice(0, 200);
        }
        // Capture initial prompt from first substantial user message
        if (!initialPrompt && role === 'user' && isSummaryCandidate(content)) {
          initialPrompt = content.slice(0, 500); // Limit to 500 chars
          firstMessageId = eventId;
          firstMessageTimestamp = ts || null;
        }
      }

      const tools = extractToolCalls(msg);
      for (const tool of tools) {
        pendingEvents.push([tool.id || `${eventId}-${tool.name}`, sessionId as string, ts as string, 'tool_call', role, null, tool.name, tool.args, null]);
        toolCount++;

        // File activity tracking
        const fps = extractFilePaths(tool.name, tool.args);
        for (const fp of fps) {
          const op = tool.name.includes('write') || tool.name === 'Write' ? 'write'
            : tool.name.includes('edit') || tool.name === 'Edit' ? 'edit'
            : 'read';
          fileActivities.push([sessionId as string, fp, op, ts as string]);

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
      if (codexOriginator) parts.push(`originator=${codexOriginator}`);
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

  return { sessionId: sessionId as string, msgCount, toolCount };
}

function run(): void {
  const config = loadConfig();
  init();
  const db = open();
  const archiveMode = config.storage === 'archive';

  console.log(`AgentActa indexer running in ${config.storage} mode`);

  const stmts = createStmts(db);

  const sessionDirs = discoverSessionDirs(config);
  console.log(`Discovered ${sessionDirs.length} session directories:`);
  sessionDirs.forEach(d => console.log(`  ${d.agent}: ${d.path}`));

  interface FileEntry {
    path: string;
    agent: string;
    sourceType: string;
  }

  let allFiles: FileEntry[] = [];
  for (const dir of sessionDirs) {
    const files: FileEntry[] = listJsonlFiles(dir.path, !!dir.recursive)
      .map(filePath => ({ path: filePath, agent: dir.agent, sourceType: dir.sourceType || 'transcript' }));
    allFiles.push(...files);
  }

  console.log(`Found ${allFiles.length} session files`);

  const indexMany = db.transaction(() => {
    let indexed = 0;
    for (const f of allFiles) {
      const result = f.sourceType === 'cron-run'
        ? indexCronRunFile(db, f.path, f.agent, stmts)
        : indexFile(db, f.path, f.agent, stmts, archiveMode, config);
      if (!result.skipped) {
        indexed++;
        if (indexed % 10 === 0) process.stdout.write('.');
      }
    }
    return indexed;
  });

  const count = indexMany();
  console.log(`\nIndexed ${count} sessions`);

  const stats = db.prepare('SELECT COUNT(*) as sessions FROM sessions').get() as { sessions: number };
  const evStats = db.prepare('SELECT COUNT(*) as events FROM events').get() as { events: number };
  console.log(`Total: ${stats.sessions} sessions, ${evStats.events} events`);

  if (WATCH) {
    console.log('\nWatching for changes...');
    const rescanTimers = new Map<string, ReturnType<typeof setTimeout>>();

    for (const dir of sessionDirs) {
      fs.watch(dir.path, { persistent: true }, (_eventType: string, filename: string | null) => {
        // Recursive sources (e.g. ~/.codex/sessions/YYYY/MM/DD/*.jsonl):
        // fs.watch on Linux does not watch nested dirs recursively, so on any root event
        // run a debounced full rescan of known JSONL files under this source.
        if (dir.recursive) {
          const key = dir.path;
          const existing = rescanTimers.get(key);
          if (existing) clearTimeout(existing);
          const t = setTimeout(() => {
            try {
              const files = listJsonlFiles(dir.path, true);
              let changed = 0;
              for (const filePath of files) {
                const result = dir.sourceType === 'cron-run'
                  ? indexCronRunFile(db, filePath, dir.agent, stmts)
                  : indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
                if (!result.skipped) changed++;
              }
              if (changed > 0) console.log(`Re-indexed ${changed} files (${dir.agent})`);
            } catch (err: unknown) {
              console.error(`Error rescanning ${dir.path}:`, (err as Error).message);
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
            const result = dir.sourceType === 'cron-run'
              ? indexCronRunFile(db, filePath, dir.agent, stmts)
              : indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
            if (!result.skipped) console.log(`Re-indexed: ${filename} (${dir.agent})`);
          } catch (err: unknown) {
            console.error(`Error re-indexing ${filename}:`, (err as Error).message);
          }
        }, 500);
      });
    }
  } else {
    db.close();
  }
}

function indexAll(db: Database.Database, config: AgentActaConfig): IndexAllResult {
  const sessionDirs = discoverSessionDirs(config);
  const archiveMode = config.storage === 'archive';
  const stmts = createStmts(db);
  let totalSessions = 0;
  for (const dir of sessionDirs) {
    const files = listJsonlFiles(dir.path, !!dir.recursive);
    for (const filePath of files) {
      try {
        const result = dir.sourceType === 'cron-run'
          ? indexCronRunFile(db, filePath, dir.agent, stmts)
          : indexFile(db, filePath, dir.agent, stmts, archiveMode, config);
        if (!result.skipped) totalSessions++;
      } catch (err: unknown) {
        console.error(`Error indexing ${path.basename(filePath)}:`, (err as Error).message);
      }
    }
  }
  const stats = db.prepare('SELECT COUNT(*) as sessions FROM sessions').get() as { sessions: number };
  const evStats = db.prepare('SELECT COUNT(*) as events FROM events').get() as { events: number };
  return { sessions: stats.sessions, events: evStats.events, newSessions: totalSessions };
}

export { discoverSessionDirs, listJsonlFiles, indexFile, indexCronRunFile, indexAll };

if (require.main === module) run();

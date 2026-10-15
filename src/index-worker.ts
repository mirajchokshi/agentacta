// Background indexer. Parsing transcripts is synchronous and a long session's
// log can be over 100 MB, so indexing on the HTTP thread stalled every request
// (and startup) for as long as a re-parse took. This worker owns the startup
// pass, the watchers, and insight scoring; the server thread only reads.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import type { AgentActaConfig, IndexResult, IndexAllResult, InsightResult, PreparedStatements, SessionDir } from './types.js';
import { loadConfig } from './config.js';
import { open, createStmts } from './db.js';
import { discoverSessionDirs, listSessionFiles, listClaudeSubagentFiles, indexFile, indexOpenClawDb, watchOpenClawDb, indexAll } from './indexer.js';
import { analyzeSession, analyzeAll, analyzeChanged } from './insights.js';

export type WorkerMessage =
  | { type: 'ready'; changed: number; ms: number }
  | { type: 'updated'; ids: string[] }
  | { type: 'reindexed'; requestId: number; result?: IndexAllResult; error?: string };

export type MainMessage = { type: 'reindex'; requestId: number };

if (!parentPort) throw new Error('index-worker must run as a worker thread');
const port = parentPort;
const post = (m: WorkerMessage): void => port.postMessage(m);

const config: AgentActaConfig = loadConfig();
const ARCHIVE_MODE: boolean = config.storage === 'archive';
const db: Database.Database = open();
db.pragma('busy_timeout = 5000');
const stmts: PreparedStatements = createStmts(db);
const sessionDirs: SessionDir[] = discoverSessionDirs(config);

const REINDEX_DEBOUNCE_MS: number = 2000;
const RECURSIVE_RESCAN_MS: number = 15000;

// Initial indexing pass
const t0: number = performance.now();
const startupChanged: Set<string> = new Set();
for (const dir of sessionDirs) {
  if (dir.sourceType === 'openclaw-db') {
    try {
      const ids: string[] = indexOpenClawDb(db, dir.path, dir.agent, stmts, ARCHIVE_MODE, config);
      for (const sid of ids) startupChanged.add(sid);
      if (ids.length > 0) console.log(`Indexed ${ids.length} DB sessions from ${path.basename(dir.path)} (${dir.agent})`);
    } catch (err: unknown) {
      console.error(`Error indexing ${path.basename(dir.path)}:`, (err as Error).message);
    }
    continue;
  }
  const files: string[] = listSessionFiles(dir);
  for (const filePath of files) {
    try {
      const result: IndexResult = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) {
        if (result.sessionId) startupChanged.add(result.sessionId);
        console.log(`Indexed: ${path.basename(filePath)} (${dir.agent})`);
      }
    } catch (err: unknown) {
      console.error(`Error indexing ${path.basename(filePath)}:`, (err as Error).message);
    }
  }
}

// Insights for sessions that changed (or were never scored) since last run
try {
  const n: number = analyzeChanged(db, startupChanged);
  console.log(`Insights computed for ${n} session${n === 1 ? '' : 's'}`);
} catch (err: unknown) {
  console.error('Error computing insights:', (err as Error).message);
}
post({ type: 'ready', changed: startupChanged.size, ms: Math.round(performance.now() - t0) });
// Pages opened while the pass ran were served the older index; let them catch up.
if (startupChanged.size) post({ type: 'updated', ids: [...startupChanged] });

// Debounce map: filePath -> timeout handle
const _reindexTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// Recompute insights for re-indexed sessions and tell the server to push updates
const upsertInsight: Database.Statement = db.prepare('INSERT OR REPLACE INTO session_insights (session_id, signals, confusion_score, flagged, computed_at) VALUES (?, ?, ?, ?, ?)');
function refreshInsightsAndNotify(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    try {
      const insight: InsightResult | null = analyzeSession(db, sessionId);
      if (insight) upsertInsight.run(insight.session_id, JSON.stringify(insight.signals), insight.confusion_score, insight.flagged ? 1 : 0, insight.computed_at);
    } catch { /* ignore */ }
  }
  post({ type: 'updated', ids: sessionIds });
}

function reindexRecursiveDir(dir: SessionDir): void {
  try {
    // Claude project dirs: top-level transcripts are covered by fs.watch, so
    // the interval only needs to poll the nested subagents/ folders.
    const files: string[] = dir.subagents && !dir.recursive ? listClaudeSubagentFiles(dir.path) : listSessionFiles(dir);
    let changed: number = 0;
    for (const filePath of files) {
      const result: IndexResult = indexFile(db, filePath, dir.agent, stmts, ARCHIVE_MODE, config);
      if (!result.skipped) {
        changed++;
        if (result.sessionId) refreshInsightsAndNotify([result.sessionId]);
      }
    }
    if (changed > 0) console.log(`Live re-indexed ${changed} files (${dir.agent})`);
  } catch (err: unknown) {
    console.error(`Error rescanning ${dir.path}:`, (err as Error).message);
  }
}

function reindexOpenClawDb(dir: SessionDir): void {
  try {
    const ids: string[] = indexOpenClawDb(db, dir.path, dir.agent, stmts, ARCHIVE_MODE, config);
    if (ids.length > 0) {
      console.log(`Live re-indexed ${ids.length} DB sessions (${dir.agent})`);
      refreshInsightsAndNotify(ids);
    }
  } catch (err: unknown) {
    console.error(`Error re-indexing ${dir.path}:`, (err as Error).message);
  }
}

for (const dir of sessionDirs) {
  try {
    if (dir.sourceType === 'openclaw-db') {
      watchOpenClawDb(dir.path, { debounceMs: REINDEX_DEBOUNCE_MS }, () => reindexOpenClawDb(dir));
      console.log(`  Watching: ${dir.path}`);
      continue;
    }
    fs.watch(dir.path, (_eventType: string, filename: string | null) => {
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
            if (result.sessionId) refreshInsightsAndNotify([result.sessionId]);
          }
        } catch (err: unknown) {
          console.error(`Error re-indexing ${filename}:`, (err as Error).message);
        }
      }, REINDEX_DEBOUNCE_MS));
    });
    console.log(`  Watching: ${dir.path}`);
    // Nested files (Codex date dirs, Claude <session>/subagents/) aren't seen by a
    // non-recursive fs.watch, so rescan them on an interval.
    if (dir.recursive || dir.subagents) setInterval(() => reindexRecursiveDir(dir), RECURSIVE_RESCAN_MS);
  } catch (err: unknown) {
    console.error(`  Failed to watch ${dir.path}:`, (err as Error).message);
  }
}

port.on('message', (m: MainMessage) => {
  if (m.type !== 'reindex') return;
  try {
    const result: IndexAllResult = indexAll(db, config);
    try { analyzeAll(db); } catch (e: unknown) { console.error('Insights recompute error:', (e as Error).message); }
    post({ type: 'reindexed', requestId: m.requestId, result });
  } catch (err: unknown) {
    post({ type: 'reindexed', requestId: m.requestId, error: (err as Error).message });
  }
});

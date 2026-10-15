// Search-as-you-type for the command palette: sessions (title, prompt, id),
// files (path) and event text (full-text, last word as a prefix), in one
// round trip. Sessions and files are searched across everything, not just the
// recent rows a client has on hand.
import type Database from 'better-sqlite3';

export interface QuickSearchResult {
  sessions: Array<{ id: string; label: string | null; summary: string | null; initial_prompt: string | null; agent: string | null; start_time: string; end_time: string | null }>;
  files: Array<{ file_path: string; touches: number; last_touched: string | null }>;
  events: Array<{ id: string; session_id: string; timestamp: string; type: string; role: string | null; tool_name: string | null; snippet: string; session_label: string | null; session_summary: string | null }>;
}

// Marks around matched terms in snippets (control characters, so they can't
// collide with text and the client can escape everything else first).
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
}

// Each word must appear; the last one may be unfinished (prefix match) unless
// the query ends with a space. Prefixes start at 3 letters: a 2-letter prefix
// matches most of the index and costs far more than it helps. Quoting keeps
// punctuation from breaking FTS.
export function toPrefixFtsQuery(q: string): string {
  const words = q.match(/[^\s"]+/g) || [];
  if (!words.length) return '';
  const tokens = words.map(t => `"${t}"`);
  if (!/\s$/.test(q) && words[words.length - 1].length >= 3) tokens[tokens.length - 1] += '*';
  return tokens.join(' AND ');
}

export function quickSearch(db: Database.Database, query: string): QuickSearchResult {
  const q = query.trim();
  if (!q) return { sessions: [], files: [], events: [] };
  const like = likePattern(q);

  const sessions = db.prepare(
    `SELECT id, label, summary, SUBSTR(initial_prompt, 1, 300) AS initial_prompt, agent, start_time, end_time
     FROM sessions
     WHERE label LIKE @like ESCAPE '\\' OR summary LIKE @like ESCAPE '\\' OR initial_prompt LIKE @like ESCAPE '\\' OR id LIKE @like ESCAPE '\\'
     ORDER BY (label LIKE @like ESCAPE '\\' OR summary LIKE @like ESCAPE '\\') DESC, COALESCE(end_time, start_time) DESC
     LIMIT 5`
  ).all({ like }) as QuickSearchResult['sessions'];

  // Files whose name matches rank above files that only match on a folder.
  const files = db.prepare(
    `SELECT file_path, COUNT(*) AS touches, MAX(timestamp) AS last_touched
     FROM file_activity WHERE file_path LIKE @like ESCAPE '\\'
     GROUP BY file_path
     ORDER BY (SUBSTR(file_path, LENGTH(RTRIM(file_path, REPLACE(file_path, '/', ''))) + 1) LIKE @like ESCAPE '\\') DESC, touches DESC
     LIMIT 4`
  ).all({ like }) as QuickSearchResult['files'];

  // One character matches nearly every event; wait for a second one.
  let events: QuickSearchResult['events'] = [];
  const fts = q.replace(/\s/g, '').length >= 2 ? toPrefixFtsQuery(query) : '';
  if (fts) {
    try {
      // Pick the newest matches first, then build snippets for just those:
      // with snippet() in the sorted query it ran for every match.
      const top = (db.prepare(
        `SELECT e.rowid AS rid FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
         WHERE events_fts MATCH ? ORDER BY e.timestamp DESC LIMIT 6`
      ).all(fts) as Array<{ rid: number }>).map(r => r.rid);
      if (top.length) {
        events = db.prepare(
          `SELECT e.id, e.session_id, e.timestamp, e.type, e.role, e.tool_name,
                  snippet(events_fts, -1, char(2), char(3), '…', 14) AS snippet,
                  s.label AS session_label, s.summary AS session_summary
           FROM events_fts JOIN events e ON e.rowid = events_fts.rowid JOIN sessions s ON s.id = e.session_id
           WHERE events_fts MATCH ? AND events_fts.rowid IN (SELECT value FROM json_each(?))
           ORDER BY e.timestamp DESC`
        ).all(fts, JSON.stringify(top)) as QuickSearchResult['events'];
      }
    } catch {
      events = []; // a query FTS can't parse just has no text matches
    }
  }
  return { sessions, files, events };
}

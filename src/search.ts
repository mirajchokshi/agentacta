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

function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
}

// FTS5 query from user text: every word (or "quoted phrase") must appear;
// each is quoted so dashes and punctuation don't break FTS parsing. With
// prefix, an unfinished last word (3+ letters, no trailing space, not a
// quoted phrase) also matches longer words: a 2-letter prefix matches most of
// the index and costs far more than it helps.
export function toFtsQuery(q: string, { prefix = false }: { prefix?: boolean } = {}): string {
  const raw: string[] = (q || '').trim().match(/"[^"]+"|\S+/g) || [];
  const tokens: string[] = raw
    .map((t: string) => t.replace(/^"|"$/g, '').replace(/"/g, '""'))
    .filter(Boolean)
    .map((t: string) => `"${t}"`);
  if (!tokens.length) return '';
  const last: string = raw[raw.length - 1];
  if (prefix && !/\s$/.test(q) && !last.startsWith('"') && last.length >= 3) tokens[tokens.length - 1] += '*';
  return tokens.join(' AND ');
}

export function quickSearch(db: Database.Database, query: string): QuickSearchResult {
  const q = query.trim();
  if (!q) return { sessions: [], files: [], events: [] };
  // Every word must appear somewhere (in any order), as with the text search.
  const words: string[] = (q.match(/"[^"]+"|\S+/g) || []).map(w => w.replace(/^"|"$/g, '')).filter(Boolean).slice(0, 8);
  if (!words.length) return { sessions: [], files: [], events: [] };
  const params: Record<string, string> = {};
  words.forEach((w, i) => { params[`w${i}`] = likePattern(w); });
  const eachWord = (expr: (p: string) => string): string => words.map((_, i) => `(${expr(`@w${i}`)})`).join(' AND ');
  const inTitle = (p: string): string => `label LIKE ${p} ESCAPE '\\' OR summary LIKE ${p} ESCAPE '\\'`;

  const sessions = db.prepare(
    `SELECT id, label, summary, SUBSTR(initial_prompt, 1, 300) AS initial_prompt, agent, start_time, end_time
     FROM sessions
     WHERE ${eachWord(p => `${inTitle(p)} OR initial_prompt LIKE ${p} ESCAPE '\\' OR id LIKE ${p} ESCAPE '\\'`)}
     ORDER BY (${eachWord(inTitle)}) DESC, COALESCE(end_time, start_time) DESC
     LIMIT 5`
  ).all(params) as QuickSearchResult['sessions'];

  // Files whose name matches rank above files that only match on a folder.
  const baseName = "SUBSTR(file_path, LENGTH(RTRIM(file_path, REPLACE(file_path, '/', ''))) + 1)";
  const files = db.prepare(
    `SELECT file_path, COUNT(*) AS touches, MAX(timestamp) AS last_touched
     FROM file_activity WHERE ${eachWord(p => `file_path LIKE ${p} ESCAPE '\\'`)}
     GROUP BY file_path
     ORDER BY (${words.map((_, i) => `${baseName} LIKE @w${i} ESCAPE '\\'`).join(' OR ')}) DESC, touches DESC
     LIMIT 4`
  ).all(params) as QuickSearchResult['files'];

  // One character matches nearly every event; wait for a second one.
  let events: QuickSearchResult['events'] = [];
  const fts = q.replace(/\s/g, '').length >= 2 ? toFtsQuery(query, { prefix: true }) : '';
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

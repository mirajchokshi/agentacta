// Stored project attribution. Attributing a session scores every event against
// candidates drawn from the whole session, so it can't be done for one page of
// events in isolation, and doing it on every open grew with session length.
// The indexer computes it once per (re)index, in the same transaction that
// writes the events, and the session endpoint reads it back.
import type Database from 'better-sqlite3';
import type { EventRow, SessionRow } from './types.js';
import { attributeSessionEvents } from './project-attribution.js';

// Bump when attribution rules change so stored rows are recomputed.
export const ATTRIBUTION_VERSION = 1;

const stmtCache = new WeakMap<Database.Database, ReturnType<typeof prepare>>();
function prepare(db: Database.Database) {
  return {
    session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    events: db.prepare('SELECT * FROM events WHERE session_id = ?'),
    clear: db.prepare('DELETE FROM event_attr WHERE session_id = ?'),
    insert: db.prepare('INSERT OR REPLACE INTO event_attr (session_id, event_id, project, confidence) VALUES (?, ?, ?, ?)'),
    mark: db.prepare('INSERT OR REPLACE INTO session_attr (session_id, version) VALUES (?, ?)'),
    unmark: db.prepare('DELETE FROM session_attr WHERE session_id = ?'),
    isCurrent: db.prepare('SELECT 1 FROM session_attr WHERE session_id = ? AND version = ?'),
    stale: db.prepare('SELECT s.id FROM sessions s LEFT JOIN session_attr a ON a.session_id = s.id AND a.version = ? WHERE a.session_id IS NULL ORDER BY s.start_time DESC'),
  };
}
function stmts(db: Database.Database) {
  let s = stmtCache.get(db);
  if (!s) { s = prepare(db); stmtCache.set(db, s); }
  return s;
}

// Call inside the transaction that wrote the session's events. Never throws:
// if attribution fails, the session is left unmarked (it is attributed on read
// instead) rather than rolling back the indexing it rides along with.
export function storeSessionAttribution(db: Database.Database, sessionId: string): void {
  const st = stmts(db);
  try {
    const session = st.session.get(sessionId) as SessionRow | undefined;
    if (!session) return;
    const events = st.events.all(sessionId) as EventRow[];
    const { events: attributed } = attributeSessionEvents(session, events);
    st.clear.run(sessionId);
    for (const e of attributed) if (e.project) st.insert.run(sessionId, e.id, e.project, e.project_confidence);
    st.mark.run(sessionId, ATTRIBUTION_VERSION);
  } catch (err: unknown) {
    console.error(`Attribution failed for ${sessionId}:`, (err as Error).message);
    try { st.clear.run(sessionId); st.unmark.run(sessionId); } catch { /* leave as is */ }
  }
}

export function hasStoredAttribution(db: Database.Database, sessionId: string): boolean {
  return !!stmts(db).isCurrent.get(sessionId, ATTRIBUTION_VERSION);
}

// Fill in sessions indexed before attribution was stored (or under an older
// version), newest first so recently used sessions get the fast path soonest.
export function staleAttributionIds(db: Database.Database): string[] {
  return (stmts(db).stale.all(ATTRIBUTION_VERSION) as Array<{ id: string }>).map(r => r.id);
}

export function storeAttributionNow(db: Database.Database, sessionId: string): void {
  db.transaction(() => storeSessionAttribution(db, sessionId))();
}

export function backfillAttribution(db: Database.Database): number {
  const ids = staleAttributionIds(db);
  for (const id of ids) storeAttributionNow(db, id);
  return ids.length;
}

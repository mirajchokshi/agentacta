import type Database from 'better-sqlite3';
import type { AttributedEvent, AttributionResult, EventRow, ProjectFilter, SessionRow } from './types.js';
import { attributeSessionEvents } from './project-attribution.js';
import { hasStoredAttribution } from './attribution-store.js';
import { sessionShape } from './session-status.js';
import type { SessionShape } from './session-status.js';

// A session's events (newest first, limit 0 = all) with project attribution,
// project filters and shape. Sessions whose attribution the indexer has stored
// read only the requested page of event bodies; the rest comes from indexes.
// Others (not yet backfilled) attribute every event here, as before.
export function loadSessionEvents(db: Database.Database, session: SessionRow, limit: number): { events: AttributedEvent[]; eventTotal: number; shape: SessionShape; projectFilters: ProjectFilter[] } {
  const id: string = session.id;
  // One read transaction: every part comes from the same snapshot even if the
  // indexer rewrites this session meanwhile.
  return db.transaction(() => {
  if (hasStoredAttribution(db, id)) {
    const events = db.prepare(
      `SELECT e.*, a.project AS project, COALESCE(a.confidence, 0) AS project_confidence
       FROM events e LEFT JOIN event_attr a ON a.session_id = e.session_id AND a.event_id = e.id
       WHERE e.session_id = ? ORDER BY e.timestamp DESC, e.id DESC LIMIT ?`
    ).all(id, limit > 0 ? limit : -1) as AttributedEvent[];
    const light = db.prepare('SELECT timestamp, type, tool_name FROM events WHERE session_id = ? ORDER BY timestamp DESC, id DESC')
      .all(id) as Array<{ timestamp: string; type: string; tool_name: string | null }>;
    // Joined to events so a row whose event id moved to another session (ids
    // are global) is not counted.
    const projectFilters: ProjectFilter[] = (db.prepare(
      `SELECT a.project AS project, COUNT(*) AS c FROM event_attr a
       JOIN events e ON e.id = a.event_id AND e.session_id = a.session_id
       WHERE a.session_id = ? GROUP BY a.project`
    ).all(id) as Array<{ project: string; c: number }>)
      .sort((a, b) => (b.c - a.c) || a.project.localeCompare(b.project))
      .map(r => ({ project: r.project, eventCount: r.c }));
    return { events, eventTotal: light.length, shape: sessionShape(session, light), projectFilters };
  }
  const all: EventRow[] = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC, id DESC').all(id) as EventRow[];
  const attributed: AttributionResult = attributeSessionEvents(session, all);
  return {
    events: limit > 0 ? attributed.events.slice(0, limit) : attributed.events,
    eventTotal: all.length,
    shape: sessionShape(session, all),
    projectFilters: attributed.projectFilters,
  };
  })();
}

// Older events for scrolling: the `limit` events after a cursor (timestamp|id
// of the oldest event the page has), newest first. Without stored attribution
// it returns all older events (more than `limit`).
export function loadOlderSessionEvents(db: Database.Database, session: SessionRow, before: { timestamp: string; id: string }, limit: number): AttributedEvent[] {
  const id: string = session.id;
  if (hasStoredAttribution(db, id)) {
    return db.prepare(
      `SELECT e.*, a.project AS project, COALESCE(a.confidence, 0) AS project_confidence
       FROM events e LEFT JOIN event_attr a ON a.session_id = e.session_id AND a.event_id = e.id
       WHERE e.session_id = ? AND (e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))
       ORDER BY e.timestamp DESC, e.id DESC LIMIT ?`
    ).all(id, before.timestamp, before.timestamp, before.id, limit) as AttributedEvent[];
  }
  // Not stored yet: attributing costs the whole session either way, so send
  // everything older at once rather than re-attributing for every page.
  const all = loadSessionEvents(db, session, 0).events;
  const at = all.findIndex(e => e.timestamp < before.timestamp || (e.timestamp === before.timestamp && e.id < before.id));
  return at < 0 ? [] : all.slice(at);
}

import type Database from 'better-sqlite3';
import type { EventRow } from './types.js';

export function extractCallBaseId(id: string | null | undefined): string {
  if (!id) return '';
  return String(id).replace(/:(call|result)$/, '');
}

export function loadDeltaAttributionContext(
  db: Database.Database,
  sessionId: string,
  rows: EventRow[]
): EventRow[] {
  if (!db || !Array.isArray(rows) || !rows.length) return [];

  const ordered = [...rows].sort((a: EventRow, b: EventRow): number => {
    const ta = Date.parse(a?.timestamp || '0') || 0;
    const tb = Date.parse(b?.timestamp || '0') || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const first: EventRow = ordered[0];
  const firstTs: string = first?.timestamp || '1970-01-01T00:00:00.000Z';
  const firstId: string = first?.id || '';
  const neighborhoodRows: EventRow[] = db.prepare(
    `SELECT * FROM events
     WHERE session_id = ?
       AND (timestamp < ? OR (timestamp = ? AND id < ?))
     ORDER BY timestamp DESC, id DESC
     LIMIT 12`
  ).all(sessionId, firstTs, firstTs, firstId).reverse() as EventRow[];

  const callIds: string[] = [...new Set(
    rows
      .filter((row: EventRow): boolean => row != null && row.type === 'tool_result')
      .map((row: EventRow): string => extractCallBaseId(row.id))
      .filter(Boolean)
      .map((base: string): string => `${base}:call`)
  )];

  if (!callIds.length) return neighborhoodRows;

  const placeholders: string = callIds.map((): string => '?').join(',');
  const linkedCallRows: EventRow[] = db.prepare(
    `SELECT * FROM events
     WHERE session_id = ?
       AND type = 'tool_call'
       AND id IN (${placeholders})`
  ).all(sessionId, ...callIds) as EventRow[];

  const merged: EventRow[] = [];
  const seen: Set<string> = new Set();
  for (const row of [...neighborhoodRows, ...linkedCallRows]) {
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

'use strict';

function extractCallBaseId(id) {
  if (!id) return '';
  return String(id).replace(/:(call|result)$/, '');
}

function loadDeltaAttributionContext(db, sessionId, rows) {
  if (!db || !Array.isArray(rows) || !rows.length) return [];

  const ordered = [...rows].sort((a, b) => {
    const ta = Date.parse(a?.timestamp || 0) || 0;
    const tb = Date.parse(b?.timestamp || 0) || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const first = ordered[0];
  const firstTs = first?.timestamp || '1970-01-01T00:00:00.000Z';
  const firstId = first?.id || '';
  const neighborhoodRows = db.prepare(
    `SELECT * FROM events
     WHERE session_id = ?
       AND (timestamp < ? OR (timestamp = ? AND id < ?))
     ORDER BY timestamp DESC, id DESC
     LIMIT 12`
  ).all(sessionId, firstTs, firstTs, firstId).reverse();

  const callIds = [...new Set(
    rows
      .filter(row => row && row.type === 'tool_result')
      .map(row => extractCallBaseId(row.id))
      .filter(Boolean)
      .map(base => `${base}:call`)
  )];

  if (!callIds.length) return neighborhoodRows;

  const placeholders = callIds.map(() => '?').join(',');
  const linkedCallRows = db.prepare(
    `SELECT * FROM events
     WHERE session_id = ?
       AND type = 'tool_call'
       AND id IN (${placeholders})`
  ).all(sessionId, ...callIds);

  const merged = [];
  const seen = new Set();
  for (const row of [...neighborhoodRows, ...linkedCallRows]) {
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

module.exports = { loadDeltaAttributionContext };

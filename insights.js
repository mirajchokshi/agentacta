'use strict';

const SIGNAL_WEIGHTS = {
  tool_retry_loop: 30,
  session_bail: 25,
  high_error_rate: 20,
  long_prompt_short_session: 15,
  no_completion: 10
};

function analyzeSession(db, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const events = db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId);

  const signals = [];

  // 1. tool_retry_loop: Same tool called 3+ times consecutively
  const toolCalls = events.filter(e => e.type === 'tool_call');
  if (toolCalls.length >= 3) {
    let consecutive = 1;
    for (let i = 1; i < toolCalls.length; i++) {
      if (toolCalls[i].tool_name === toolCalls[i - 1].tool_name) {
        consecutive++;
        if (consecutive >= 3) {
          signals.push({
            type: 'tool_retry_loop',
            tool: toolCalls[i].tool_name,
            count: consecutive
          });
          // Continue counting but don't add duplicate signals for same streak
          while (i + 1 < toolCalls.length && toolCalls[i + 1].tool_name === toolCalls[i].tool_name) {
            consecutive++;
            i++;
            signals[signals.length - 1].count = consecutive;
          }
          consecutive = 1;
        }
      } else {
        consecutive = 1;
      }
    }
  }

  // 2. session_bail: >20 tool calls but no file write events
  if (toolCalls.length > 20) {
    const hasWrite = events.some(e =>
      e.type === 'tool_call' && e.tool_name &&
      (e.tool_name === 'Write' || e.tool_name === 'Edit' ||
       e.tool_name.toLowerCase().includes('write') ||
       e.tool_name.toLowerCase().includes('edit'))
    );
    if (!hasWrite) {
      signals.push({
        type: 'session_bail',
        tool_calls: toolCalls.length
      });
    }
  }

  // 3. high_error_rate: >30% of tool calls returned errors
  const toolResults = events.filter(e => e.type === 'tool_result');
  if (toolResults.length > 0) {
    const errorResults = toolResults.filter(e => {
      const c = (e.content || e.tool_result || '').toLowerCase();
      return c.includes('error') || c.includes('Error') || c.includes('ERROR') ||
             c.includes('failed') || c.includes('exception');
    });
    const errorRate = errorResults.length / toolResults.length;
    if (errorRate > 0.3) {
      signals.push({
        type: 'high_error_rate',
        error_count: errorResults.length,
        total: toolResults.length,
        rate: Math.round(errorRate * 100)
      });
    }
  }

  // 4. long_prompt_short_session: Initial prompt <15 words but >30 tool calls
  if (session.initial_prompt && toolCalls.length > 30) {
    const wordCount = session.initial_prompt.trim().split(/\s+/).length;
    if (wordCount < 15) {
      signals.push({
        type: 'long_prompt_short_session',
        prompt_words: wordCount,
        tool_calls: toolCalls.length
      });
    }
  }

  // 5. no_completion: Last event is a tool call, not an assistant message
  if (events.length > 0) {
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'tool_call' || lastEvent.type === 'tool_result') {
      signals.push({
        type: 'no_completion',
        last_event_type: lastEvent.type,
        last_tool: lastEvent.tool_name || null
      });
    }
  }

  // Compute confusion_score
  const seenTypes = new Set();
  let confusionScore = 0;
  for (const sig of signals) {
    if (!seenTypes.has(sig.type)) {
      confusionScore += SIGNAL_WEIGHTS[sig.type] || 0;
      seenTypes.add(sig.type);
    }
  }
  confusionScore = Math.min(confusionScore, 100);

  const flagged = confusionScore >= 30;

  return {
    session_id: sessionId,
    signals,
    confusion_score: confusionScore,
    flagged,
    computed_at: new Date().toISOString()
  };
}

function analyzeAll(db) {
  const sessions = db.prepare('SELECT id FROM sessions').all();
  const results = [];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO session_insights
    (session_id, signals, confusion_score, flagged, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const runAll = db.transaction(() => {
    for (const s of sessions) {
      const result = analyzeSession(db, s.id);
      if (!result) continue;
      upsert.run(
        result.session_id,
        JSON.stringify(result.signals),
        result.confusion_score,
        result.flagged ? 1 : 0,
        result.computed_at
      );
      results.push(result);
    }
  });

  runAll();
  return results;
}

function getInsightsSummary(db) {
  const rows = db.prepare(
    'SELECT si.*, s.summary, s.model, s.agent, s.start_time, s.tool_count, s.message_count FROM session_insights si JOIN sessions s ON s.id = si.session_id'
  ).all();

  if (!rows.length) {
    return {
      total_sessions: 0,
      flagged_count: 0,
      flagged_percentage: 0,
      avg_confusion_score: 0,
      signal_counts: {},
      by_agent: {},
      top_flagged: []
    };
  }

  let totalScore = 0;
  let flaggedCount = 0;
  const signalCounts = {};
  const byAgent = {};

  for (const row of rows) {
    totalScore += row.confusion_score;
    if (row.flagged) flaggedCount++;

    const signals = JSON.parse(row.signals || '[]');
    const seenTypes = new Set();
    for (const sig of signals) {
      if (!seenTypes.has(sig.type)) {
        signalCounts[sig.type] = (signalCounts[sig.type] || 0) + 1;
        seenTypes.add(sig.type);
      }
    }

    const agent = row.agent || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { count: 0, flagged: 0, total_score: 0 };
    byAgent[agent].count++;
    if (row.flagged) byAgent[agent].flagged++;
    byAgent[agent].total_score += row.confusion_score;
  }

  for (const agent of Object.keys(byAgent)) {
    byAgent[agent].avg_score = Math.round(byAgent[agent].total_score / byAgent[agent].count);
  }

  const topFlagged = rows
    .filter(r => r.flagged)
    .sort((a, b) => b.confusion_score - a.confusion_score)
    .slice(0, 20)
    .map(r => ({
      session_id: r.session_id,
      summary: r.summary,
      model: r.model,
      agent: r.agent,
      start_time: r.start_time,
      tool_count: r.tool_count,
      message_count: r.message_count,
      confusion_score: r.confusion_score,
      signals: JSON.parse(r.signals || '[]')
    }));

  return {
    total_sessions: rows.length,
    flagged_count: flaggedCount,
    flagged_percentage: rows.length ? Math.round((flaggedCount / rows.length) * 100) : 0,
    avg_confusion_score: Math.round(totalScore / rows.length),
    signal_counts: signalCounts,
    by_agent: byAgent,
    top_flagged: topFlagged
  };
}

module.exports = { analyzeSession, analyzeAll, getInsightsSummary };

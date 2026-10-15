// load.mjs — send the benchmark dataset to Langfuse as OpenTelemetry traces.
//
// Usage: node bench/langfuse/load.mjs [batchSessions=50]
// One trace per session (root span = the session), one child span per event,
// with the original timestamps; session id on every span so Langfuse's session
// view groups them. Posts OTLP/HTTP JSON to /api/public/otel/v1/traces with the
// project keys created by compose.langfuse.yml, then reports send time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const BENCH_HOME = process.env.BENCH_HOME || path.join(os.homedir(), 'agentacta-bench-env');
const URL = process.env.LANGFUSE_URL || 'http://127.0.0.1:13000';
const AUTH = 'Basic ' + Buffer.from('pk-lf-bench:sk-lf-bench').toString('base64');
const BATCH = Number(process.argv[2] || 50);

const hexId = (seed, bytes) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2);
const ns = iso => String(BigInt(Date.parse(iso)) * 1000000n);
const attr = (key, value) => ({ key, value: { stringValue: String(value) } });

function sessionSpans(s) {
  const traceId = hexId(s.id, 16);
  const rootId = hexId(s.id + ':root', 8);
  const last = s.events[s.events.length - 1].ts;
  const common = [attr('langfuse.session.id', s.id)];
  const spans = [{
    traceId, spanId: rootId, name: s.title.slice(0, 80), kind: 1,
    startTimeUnixNano: ns(s.events[0].ts), endTimeUnixNano: ns(last),
    attributes: [...common, attr('langfuse.trace.name', s.title.slice(0, 80)), attr('langfuse.trace.input', s.events[0].text || ''),
      attr('langfuse.trace.metadata.source', s.source), attr('langfuse.trace.metadata.project', s.project)],
  }];
  s.events.forEach((e, i) => {
    const next = s.events[i + 1] ? s.events[i + 1].ts : e.ts;
    const isTool = e.type !== 'message';
    spans.push({
      traceId, spanId: hexId(`${s.id}:${i}`, 8), parentSpanId: rootId,
      name: isTool ? `${e.type === 'tool_call' ? 'call' : 'result'} ${e.tool}` : `${e.role} message`,
      kind: 1, startTimeUnixNano: ns(e.ts), endTimeUnixNano: ns(next),
      attributes: [...common,
        attr('langfuse.observation.type', isTool ? 'tool' : 'span'),
        ...(e.type === 'message' ? [attr('langfuse.observation.input', e.text)] : []),
        ...(e.type === 'tool_call' ? [attr('langfuse.observation.input', JSON.stringify(e.args))] : []),
        ...(e.type === 'tool_result' ? [attr('langfuse.observation.output', e.output)] : [])],
    });
  });
  return spans;
}

async function post(spans) {
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [attr('service.name', 'bench-agents')] }, scopeSpans: [{ scope: { name: 'bench' }, spans }] }] });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${URL}/api/public/otel/v1/traces`, { method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body });
    if (res.ok) return body.length;
    if (attempt >= 5) throw new Error(`POST failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
}

const t0 = performance.now();
let sessions = 0, spansSent = 0, bytes = 0, batch = [];
const rl = readline.createInterface({ input: fs.createReadStream(path.join(BENCH_HOME, 'data', 'normalized.jsonl')) });
for await (const line of rl) {
  if (!line) continue;
  const s = JSON.parse(line);
  // Long sessions go in slices so one request stays a few MB.
  const spans = sessionSpans(s);
  for (let i = 0; i < spans.length; i += 2000) {
    const slice = spans.slice(i, i + 2000);
    if (spans.length > 2000) { bytes += await post(slice); spansSent += slice.length; }
    else batch.push(...slice);
  }
  sessions++;
  if (sessions % BATCH === 0 && batch.length) { bytes += await post(batch); spansSent += batch.length; batch = []; }
}
if (batch.length) { bytes += await post(batch); spansSent += batch.length; }
console.log(JSON.stringify({ sessions, spans: spansSent, mb: Math.round(bytes / 1e6), send_ms: Math.round(performance.now() - t0) }));

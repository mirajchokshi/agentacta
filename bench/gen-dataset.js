#!/usr/bin/env node
// gen-dataset.js — deterministic synthetic agent history for benchmarks.
//
// Usage: node bench/gen-dataset.js <outDir> [--sessions 4400] [--seed 42]
//
// Writes a fake home directory with the logs agent runtimes keep:
//   <out>/home/.claude/projects/<project>/<uuid>.jsonl   Claude Code
//   <out>/home/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl Codex CLI
//   <out>/home/.openclaw/agents/<agent>/sessions/*.jsonl  OpenClaw
// and <out>/normalized.jsonl: the same sessions as plain records (one per
// session, events in order), which importers for other tools convert into
// their own trace formats so every tool gets identical content.
//
// Shape follows a real ~4,400-session history: most sessions are short, a
// few are very long (one with 7,500 events, one with 30,000). Search needles
// (unique words) are planted in known sessions so results can be checked.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const OUT = path.resolve(args[0] || 'bench-data');
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : dflt; };
const N_SESSIONS = opt('sessions', 4400);
const SEED = opt('seed', 42);

// mulberry32: small, fast, deterministic
let state = SEED >>> 0;
function rand() { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = a => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const hex = n => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;

const WORDS = ('the a to of and in for with on is it this that be by from as at or we can will should not but if then add fix update test build run check read write file function error value request response config server client data model cache index query table route handler session event agent tool result output input user message token cost schedule memory note email calendar weather forecast deploy docker build release version branch commit review merge refactor rename migrate parse render chart list view page button layout style theme mobile desktop latency retry timeout queue worker thread stream socket api endpoint json yaml sql sqlite postgres redis log trace span metric alert dashboard summary report plan task step done next later today tomorrow morning evening reminder contact invoice payment travel flight hotel booking recipe grocery workout').split(' ');
const PROJECTS = ['weather-app', 'billing-service', 'notes-sync', 'home-dashboard', 'trip-planner', 'invoice-tool', 'recipe-box', 'fitness-log', 'chat-bridge', 'photo-sorter', 'budget-tracker', 'reading-list'];
const FILES = ['src/index.ts', 'src/server.ts', 'src/db.ts', 'src/routes/api.ts', 'src/lib/cache.ts', 'public/app.js', 'public/style.css', 'README.md', 'package.json', 'tests/api.test.ts', 'src/worker.ts', 'docker-compose.yml', 'src/components/Chart.tsx', 'src/utils/date.ts'];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob', 'WebFetch'];
const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'gpt-5-codex', 'claude-haiku-4-5'];
const OPENCLAW_AGENTS = ['main', 'assistant', 'scheduler'];

function sentence(min, max) {
  const n = int(min, max);
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
}
function paragraph(sentences) { return Array.from({ length: sentences }, () => sentence(6, 18)).join(' '); }
function codeBlock(lines) {
  return Array.from({ length: lines }, (_, i) => `${' '.repeat(int(0, 3) * 2)}const ${pick(WORDS)}${i} = ${pick(WORDS)}(${pick(WORDS)}, ${int(0, 999)});`).join('\n');
}

// Session length: heavy-tailed like real use; two fixed long sessions.
function sessionLength(i) {
  if (i === 7) return 7500;
  if (i === 11) return 30000;
  const r = rand();
  if (r < 0.55) return int(4, 30);
  if (r < 0.85) return int(30, 80);
  if (r < 0.97) return int(80, 300);
  return int(300, 1500);
}

// Needles: unique words planted once (event text) or in a title, for search checks.
const needles = [];
function needle(kind, sessionIndex) {
  const word = `needle${kind}${sessionIndex}x${hex(4)}`;
  needles.push({ word, kind, sessionIndex });
  return word;
}

const END = Date.parse('2026-10-01T00:00:00Z');
const SPAN_DAYS = 240;
fs.mkdirSync(OUT, { recursive: true });
const normalized = fs.createWriteStream(path.join(OUT, 'normalized.jsonl'));
let totalEvents = 0;
const counts = { 'claude-code': 0, 'codex-cli': 0, openclaw: 0 };

function buildEvents(i, n, startMs, project) {
  // Returns normalized events: {type:'message'|'tool_call'|'tool_result', role, text, tool, args, output, ts, callId}
  const ev = [];
  let t = startMs;
  const step = () => { t += int(2, 90) * 1000; return new Date(t).toISOString(); };
  const titleNeedle = i % 400 === 3 ? ` ${needle('title', i)}` : '';
  ev.push({ type: 'message', role: 'user', text: `${sentence(8, 30)}${titleNeedle} Work in ${project}.`, ts: new Date(t).toISOString() });
  const textNeedleAt = i % 97 === 5 ? int(1, Math.max(1, n - 2)) : -1;
  while (ev.length < n) {
    const r = rand();
    if (r < 0.45 && ev.length + 2 <= n) {
      const tool = pick(TOOLS);
      const file = `/home/dev/Developer/${project}/${pick(FILES)}`;
      const toolArgs = tool === 'Bash' ? { command: `${pick(['npm test', 'npm run build', 'git status', 'ls -la', 'grep -rn ' + pick(WORDS) + ' src'])}` }
        : tool === 'Grep' ? { pattern: pick(WORDS), path: `/home/dev/Developer/${project}` }
        : tool === 'Glob' ? { pattern: `**/*.${pick(['ts', 'js', 'md'])}` }
        : tool === 'WebFetch' ? { url: `https://example.com/${pick(WORDS)}` }
        : tool === 'Edit' ? { file_path: file, old_string: sentence(3, 8), new_string: sentence(3, 8) }
        : { file_path: file };
      const callId = `call_${hex(16)}`;
      ev.push({ type: 'tool_call', role: 'assistant', tool, args: toolArgs, callId, ts: step() });
      const big = rand() < 0.04;
      let output = big ? codeBlock(int(150, 600)) : (rand() < 0.5 ? codeBlock(int(3, 40)) : paragraph(int(1, 4)));
      if (ev.length === textNeedleAt) output += ` ${needle('text', i)}`;
      ev.push({ type: 'tool_result', role: 'tool', tool, callId, output, ts: step() });
    } else {
      const role = rand() < 0.7 ? 'assistant' : 'user';
      let text = paragraph(int(1, role === 'assistant' ? 5 : 2));
      if (ev.length === textNeedleAt) text += ` ${needle('text', i)}`;
      ev.push({ type: 'message', role, text, ts: step() });
    }
  }
  return ev;
}

function writeClaude(i, id, project, model, ev) {
  const dir = path.join(OUT, 'home/.claude/projects', `-home-dev-Developer-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let parent = null;
  for (const e of ev) {
    const u = uuid();
    const base = { parentUuid: parent, isSidechain: false, sessionId: id, uuid: u, timestamp: e.ts, cwd: `/home/dev/Developer/${project}`, version: '2.0.0' };
    if (e.type === 'message' && e.role === 'user') lines.push({ ...base, type: 'user', message: { role: 'user', content: e.text } });
    else if (e.type === 'message') lines.push({ ...base, type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: e.text }], usage: { input_tokens: int(500, 5000), output_tokens: int(50, 900), cache_read_input_tokens: int(0, 20000) } } });
    else if (e.type === 'tool_call') lines.push({ ...base, type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: e.callId, name: e.tool, input: e.args }], usage: { input_tokens: int(500, 5000), output_tokens: int(20, 300) } } });
    else lines.push({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.callId, content: e.output }] } });
    parent = u;
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeCodex(i, id, project, model, ev) {
  const d = new Date(ev[0].ts);
  const dir = path.join(OUT, 'home/.codex/sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: 'session_meta', timestamp: ev[0].ts, payload: { id, timestamp: ev[0].ts, cwd: `/home/dev/Developer/${project}`, originator: 'codex_cli_rs', model_provider: 'openai', source: 'cli' } },
    { type: 'turn_context', timestamp: ev[0].ts, payload: { model } }];
  for (const e of ev) {
    if (e.type === 'message') lines.push({ type: 'response_item', timestamp: e.ts, payload: { type: 'message', role: e.role, content: [{ type: e.role === 'user' ? 'input_text' : 'output_text', text: e.text }] } });
    else if (e.type === 'tool_call') lines.push({ type: 'response_item', timestamp: e.ts, payload: { type: 'function_call', name: e.tool === 'Bash' ? 'shell' : e.tool, arguments: JSON.stringify(e.args), call_id: e.callId } });
    else lines.push({ type: 'response_item', timestamp: e.ts, payload: { type: 'function_call_output', call_id: e.callId, output: e.output } });
  }
  fs.writeFileSync(path.join(dir, `rollout-${ev[0].ts.replace(/[:.]/g, '-')}-${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeOpenClaw(i, id, project, model, ev) {
  const agent = OPENCLAW_AGENTS[i % OPENCLAW_AGENTS.length];
  const dir = path.join(OUT, 'home/.openclaw/agents', agent, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: 'session', version: 3, id, timestamp: ev[0].ts, cwd: `/home/dev/Developer/${project}`, agent }];
  let parentId = null;
  for (const e of ev) {
    const mid = hex(8);
    if (e.type === 'message') lines.push({ type: 'message', id: mid, parentId, timestamp: e.ts, message: { role: e.role, content: [{ type: 'text', text: e.text }], ...(e.role === 'assistant' ? { model, usage: { input: int(500, 5000), output: int(50, 900), totalTokens: int(1000, 9000) } } : {}) } });
    else if (e.type === 'tool_call') lines.push({ type: 'message', id: mid, parentId, timestamp: e.ts, message: { role: 'assistant', model, content: [{ type: 'toolCall', id: e.callId, name: e.tool, arguments: e.args }] } });
    else lines.push({ type: 'message', id: mid, parentId, timestamp: e.ts, message: { role: 'toolResult', toolCallId: e.callId, toolName: e.tool, content: [{ type: 'text', text: e.output }] } });
    parentId = mid;
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

for (let i = 0; i < N_SESSIONS; i++) {
  const n = sessionLength(i);
  // Spread over SPAN_DAYS, newest last; the two long sessions are recent.
  const startMs = END - Math.floor(((N_SESSIONS - i) / N_SESSIONS) * SPAN_DAYS * 86400000) + int(0, 3600000);
  const project = pick(PROJECTS);
  const source = i === 7 || i === 11 ? 'claude-code' : (rand() < 0.6 ? 'claude-code' : (rand() < 0.6 ? 'codex-cli' : 'openclaw'));
  const model = source === 'codex-cli' ? 'gpt-5-codex' : pick(MODELS.filter(m => m.startsWith('claude')));
  const id = source === 'codex-cli' ? `019${hex(5)}-${hex(4)}-7${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}` : uuid();
  const ev = buildEvents(i, n, startMs, project);
  if (source === 'claude-code') writeClaude(i, id, project, model, ev);
  else if (source === 'codex-cli') writeCodex(i, id, project, model, ev);
  else writeOpenClaw(i, id, project, model, ev);
  counts[source]++;
  totalEvents += ev.length;
  normalized.write(JSON.stringify({ id, source, project, model, title: ev[0].text.slice(0, 120), events: ev }) + '\n');
}
normalized.end();
fs.writeFileSync(path.join(OUT, 'needles.json'), JSON.stringify(needles, null, 1));
const manifest = { seed: SEED, sessions: N_SESSIONS, events: totalEvents, bySource: counts, longSessions: { 7: 7500, 11: 30000 } };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest));

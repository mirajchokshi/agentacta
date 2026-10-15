// ui-bench.mjs — drive each tool's own web UI in headless Chrome, the same way.
//
// Usage: node bench/ui-bench.mjs <tool> [runs=5] [cpuSlowdown=1]
//   tool: agentacta | agentsview
//
// Per run, in a fresh browser profile (no cache):
//   landing         open the app; time until its network requests settle (no
//                   request in flight for 700 ms; streams excluded) and LCP
//   session_7500    open the 7,500-event session by URL, same measure
//   session_30000   open the 30,000-event session by URL, same measure
//   scroll_7500     scroll that session 300 frames x 400 px; frame-time stats
//   search_text     Ctrl+K, type a word that appears once in one tool output,
//                   time from the last keystroke until it shows on the page
//   search_title    same for a word in one session's first prompt
// Prints medians as JSON. Nothing here depends on either app's markup except
// the URL patterns and how search opens (Ctrl+K in both).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const [tool, runsArg = '5', cpu = '1'] = process.argv.slice(2);
const BENCH_HOME = process.env.BENCH_HOME || path.join(os.homedir(), 'agentacta-bench-env');
const dataDir = path.join(BENCH_HOME, 'data');
const lines = fs.readFileSync(path.join(dataDir, 'normalized.jsonl'), 'utf8').split('\n');
const S7500 = JSON.parse(lines[7]).id;
const S30000 = JSON.parse(lines[11]).id;
// Search targets: a word planted in one message's text, one in a session's
// first prompt (both tools index these), and one inside a tool's output (a
// capability check: not every tool indexes tool output).
const needles = JSON.parse(fs.readFileSync(path.join(dataDir, 'needles.json'), 'utf8'));
// Only sessions from the last 90 days of the dataset: Langfuse's widest
// preset range is 90 days, and every tool searches the same words.
const target = (kind, eventType) => {
  for (const n of needles.filter(x => x.kind === kind && x.sessionIndex >= 3100)) {
    const sess = JSON.parse(lines[n.sessionIndex]);
    const types = sess.events.filter(e => ((e.text || '') + (e.output || '')).includes(n.word)).map(e => e.type);
    if (types.length === 1 && types[0] === eventType) return { word: n.word, id8: sess.id.slice(0, 8) };
  }
  throw new Error(`no ${kind} needle in a ${eventType}`);
};
const MESSAGE_NEEDLE = target('text', 'message');
const TITLE_NEEDLE = target('title', 'message');
const TOOL_OUTPUT_NEEDLE = target('text', 'tool_result');

// Langfuse: one trace per session (bench/langfuse/load.mjs derives the trace id).
const lfTrace = id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
const TOOLS = {
  agentacta: { base: 'http://127.0.0.1:14003', landing: '/#overview', session: id => `/#session/${id}`, search: 'ctrlk' },
  agentsview: { base: 'http://127.0.0.1:18080', landing: '/', session: id => `/sessions/${id}`, search: 'ctrlk' },
  langfuse: { base: 'http://127.0.0.1:13000', landing: '/project/bench-project/traces?dateRange=90d', session: id => `/project/bench-project/traces/${lfTrace(id)}`, search: 'langfuse', login: true },
};
const T = TOOLS[tool];
if (!T) { console.error(`unknown tool ${tool}`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sign in to the local Langfuse with the test account compose.langfuse.yml creates.
async function langfuseCookie() {
  const jar = {};
  const keep = res => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let res = await fetch(`${T.base}/api/auth/csrf`); keep(res);
  const { csrfToken } = await res.json();
  res = await fetch(`${T.base}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie() },
    body: new URLSearchParams({ csrfToken, email: 'bench@example.com', password: 'bench-password-1', callbackUrl: `${T.base}/` }) });
  keep(res);
  return { name: 'next-auth.session-token', value: jar['next-auth.session-token'], domain: '127.0.0.1', path: '/', httpOnly: true };
}

async function browser() {
  const port = 9700 + Math.floor(Math.random() * 250);
  try { await fetch(`http://127.0.0.1:${port}/json`); throw new Error(`port ${port} busy`); } catch (e) { if (e.message.includes('busy')) throw e; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uibench-'));
  const proc = spawn('/usr/bin/google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-proxy-server', `--user-data-dir=${dir}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(150); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const listeners = new Set();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method) for (const l of listeners) l(m); });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // Both apps load Google Fonts; block them so results don't depend on the internet.
  await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setCPUThrottlingRate', { rate: Number(cpu) });
  // Network accounting for "settled": requests in flight, excluding streams.
  // Anything open longer than 5 s is a stream or long poll, not page loading.
  const inflight = new Map(); let lastActivity = 0;
  listeners.add(m => {
    if (m.method === 'Network.requestWillBeSent' && m.params.type !== 'EventSource' && !/\/(events|stream|watch)(\?|$)/.test(m.params.request.url)) { inflight.set(m.params.requestId, { url: m.params.request.url, at: performance.now() }); lastActivity = performance.now(); }
    if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && inflight.has(m.params.requestId)) {
      const r = inflight.get(m.params.requestId); inflight.delete(m.params.requestId);
      if (performance.now() - r.at < 5000) lastActivity = performance.now();
    }
  });
  const pruneStreams = () => { for (const [k, r] of inflight) if (performance.now() - r.at > 5000) inflight.delete(k); };
  // A fresh Chrome profile stalls its first network navigation (~25 s here,
  // whatever the target). Absorb it on a closed local port before measuring.
  await new Promise(async res => { const t = setTimeout(res, 40000); const l = m => { if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading') { clearTimeout(t); listeners.delete(l); res(); } }; listeners.add(l); await send('Page.navigate', { url: 'http://127.0.0.1:9/' }); });
  if (T.login) await send('Network.setCookies', { cookies: [await langfuseCookie()] });
  const close = () => { ws.close(); proc.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); };
  return { send, ev, inflight, pruneStreams, lastAct: () => lastActivity, close };
}

// Navigate and wait until no request has been in flight for 700 ms.
async function openAndSettle(b, url) {
  await b.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  b.inflight.clear();
  const t0 = performance.now();
  await b.send('Page.navigate', { url });
  await sleep(100);
  while (performance.now() - t0 < 60000) {
    b.pruneStreams();
    if (b.inflight.size === 0 && performance.now() - b.lastAct() > 700) break;
    await sleep(25);
  }
  if (process.env.DEBUG_NET) console.error('settle', url, Math.round(performance.now() - t0), 'still in flight:', JSON.stringify([...b.inflight.values()].map(r => r.url).slice(0, 5)), 'last activity at', Math.round(b.lastAct() - t0));
  const settled = Math.max(0, b.lastAct() - t0);
  const lcp = await b.ev(`new Promise(r => { let v = 0; try { new PerformanceObserver(l => { for (const e of l.getEntries()) v = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {} setTimeout(() => r(v), 50); })`);
  return { settled: Math.round(settled), lcp: Math.round(lcp) };
}

// Scroll whatever actually scrolls: the document, or the largest scrollable element.
const SCROLL = `(steps, dy) => new Promise(res => {
  const els = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  const doc = document.scrollingElement;
  const target = doc.scrollHeight > innerHeight + 200 ? doc : els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!target) return res(null);
  const frames = []; let last = performance.now(); let i = 0; let moved = 0;
  const step = t => {
    frames.push(t - last); last = t;
    if (i++ >= steps) { frames.sort((a, b) => a - b); const q = p => frames[Math.min(frames.length - 1, Math.floor(p * frames.length))];
      return res({ p50: q(0.5), p95: q(0.95), max: frames[frames.length - 1], jank: frames.filter(f => f > 50).length, moved }); }
    const before = target.scrollTop; target.scrollTop += dy; moved += target.scrollTop - before;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})`;

// Open search with Ctrl+K, enter the word (pasted at once, or typed 110 ms per
// key), and time until the search dialog shows the word or the target
// session's short id (tools show one or the other in results).
async function search(b, target, mode) {
  return T.search === 'langfuse' ? searchLangfuse(b, target, mode) : searchPalette(b, target, mode);
}

// Langfuse searches on Enter from the box above the traces table (query in
// the URL); success is a table row containing the word.
async function searchLangfuse(b, { word }, mode) {
  await openAndSettle(b, T.base + T.landing);
  const xy = await b.ev(`(()=>{const el=[...document.querySelectorAll('body *')].filter(e=>e.children.length===0 && e.textContent.trim().startsWith('Search — e.g.')).pop(); if(!el) return null; const r=el.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  if (!xy) return -2;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
  await sleep(400);
  if (mode === 'paste') await b.send('Input.insertText', { text: word });
  else for (const ch of word) { await b.send('Input.insertText', { text: ch }); await sleep(110); }
  for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  return Math.round(await b.ev(`new Promise(r => { const t0 = performance.now(); const tick = () => {
    const hit = [...document.querySelectorAll('table tbody tr')].some(tr => tr.textContent.includes(${JSON.stringify(word)}));
    if (hit) return r(performance.now() - t0);
    if (performance.now() - t0 > ${Number(process.env.SEARCH_TIMEOUT) || 5000}) return r(-1);
    requestAnimationFrame(tick); }; tick(); })`));
}

async function searchPalette(b, { word, id8 }, mode) {
  await openAndSettle(b, T.base + T.landing);
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  for (let i = 0; i < 40; i++) { if (await b.ev(`document.activeElement && document.activeElement.tagName === 'INPUT'`)) break; await sleep(50); }
  if (!(await b.ev(`document.activeElement && document.activeElement.tagName === 'INPUT'`))) return -2;
  await sleep(Number(process.env.SEARCH_DELAY) || 400); // let the dialog finish opening (and any home list load)
  if (mode === 'paste') await b.send('Input.insertText', { text: word });
  else for (const ch of word) { await b.send('Input.insertText', { text: ch }); await sleep(110); }
  const found = await b.ev(`new Promise(r => {
    const t0 = performance.now(); const input = document.activeElement;
    const scope = (input && input.closest('[role=dialog]')) || document.body;
    const tick = () => {
      const hit = [...scope.querySelectorAll('*')].some(e => e.children.length === 0 && !(e instanceof HTMLInputElement) && (e.textContent.includes(${JSON.stringify(word)}) || e.textContent.includes(${JSON.stringify(id8)})));
      if (hit) return r(performance.now() - t0);
      if (performance.now() - t0 > ${Number(process.env.SEARCH_TIMEOUT) || 5000}) return r(-1);
      requestAnimationFrame(tick);
    };
    tick();
  })`);
  if (found < 0 && process.env.DEBUG_NET) console.error('search miss', mode, word, await b.ev(`JSON.stringify({ active: document.activeElement && (document.activeElement.placeholder || document.activeElement.tagName), value: document.activeElement && document.activeElement.value, dialog: ((document.activeElement && document.activeElement.closest('[role=dialog]')) || document.body).innerText.slice(0, 300) })`));
  return Math.round(found);
}

const runs = Number(runsArg);
const acc = {};
const add = (k, v) => { if (v !== null && v !== undefined) (acc[k] ||= []).push(v); };
for (let r = 0; r < runs; r++) {
  const b = await browser();
  try {
    const land = await openAndSettle(b, T.base + T.landing); add('landing_settled_ms', land.settled); add('landing_lcp_ms', land.lcp);
    const s1 = await openAndSettle(b, T.base + T.session(S7500)); add('session7500_settled_ms', s1.settled); add('session7500_lcp_ms', s1.lcp);
    const sc = await b.ev(`(${SCROLL})(300, 400)`);
    if (sc) { add('scroll7500_p95_ms', sc.p95); add('scroll7500_jank_frames', sc.jank); add('scroll7500_max_ms', sc.max); add('scroll7500_moved_px', sc.moved); }
    const s2 = await openAndSettle(b, T.base + T.session(S30000)); add('session30000_settled_ms', s2.settled); add('session30000_lcp_ms', s2.lcp);
    if (process.env.WARM_SEARCH) console.error('warm search', await search(b, TITLE_NEEDLE, 'paste'));
    add('search_message_paste_ms', await search(b, MESSAGE_NEEDLE, 'paste'));
    add('search_message_typed_ms', await search(b, MESSAGE_NEEDLE, 'typed'));
    add('search_title_paste_ms', await search(b, TITLE_NEEDLE, 'paste'));
    add('search_tool_output_paste_ms', await search(b, TOOL_OUTPUT_NEEDLE, 'paste'));
  } finally { b.close(); }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const out = { tool, runs, cpu: Number(cpu) };
for (const [k, v] of Object.entries(acc)) out[k] = Math.round(med(v) * 10) / 10;
console.log(JSON.stringify(out));

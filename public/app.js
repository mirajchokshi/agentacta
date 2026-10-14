const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const content = $('#content');
const API = '/api';

const THEME_KEY = 'agentacta-theme'; // legacy
const THEME_MODE_KEY = 'agentacta-theme-mode'; // system | light | dark
const THEME_DARK_VARIANT_KEY = 'agentacta-dark-variant'; // default | trueblack

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function resolveTheme(mode, darkVariant) {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return darkVariant === 'trueblack' ? 'oled' : 'dark';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? (darkVariant === 'trueblack' ? 'oled' : 'dark') : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const color = theme === 'light' ? '#f7f7f8' : (theme === 'oled' ? '#000000' : '#0d0e10');
    meta.setAttribute('content', color);
  }
}

function applyThemeFromPrefs() {
  const mode = lsGet(THEME_MODE_KEY) || 'light';
  const darkVariant = lsGet(THEME_DARK_VARIANT_KEY) || 'default';
  window._themeMode = mode;
  window._themeDarkVariant = darkVariant;
  applyTheme(resolveTheme(mode, darkVariant));
}

function initTheme() {
  // Migrate legacy key if present.
  const legacy = lsGet(THEME_KEY);
  if (!lsGet(THEME_MODE_KEY) && (legacy === 'light' || legacy === 'dark')) {
    lsSet(THEME_MODE_KEY, legacy);
  }
  if (!lsGet(THEME_DARK_VARIANT_KEY)) {
    lsSet(THEME_DARK_VARIANT_KEY, 'default');
  }
  applyThemeFromPrefs();

  if (!window._themeMediaBound) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', () => {
      if ((lsGet(THEME_MODE_KEY) || 'light') === 'system') applyThemeFromPrefs();
    });
    window._themeMediaBound = true;
  }
}

function toggleTheme() {
  const currentApplied = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const nextMode = currentApplied === 'light' ? 'dark' : 'light';
  lsSet(THEME_MODE_KEY, nextMode);
  window._themeMode = nextMode;
  applyThemeFromPrefs();
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch (err) {
    // Network error (server down, offline, etc.)
    return { _error: true, error: 'Network error' };
  }
  if (!res.ok) {
    try {
      const body = await res.json();
      return { _error: true, error: body.error || `HTTP ${res.status}`, status: res.status };
    } catch {
      return { _error: true, error: `HTTP ${res.status}`, status: res.status };
    }
  }
  try {
    return await res.json();
  } catch {
    return { _error: true, error: 'Invalid JSON response' };
  }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtTimeShort(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function dlExport(url, filename) {
  fetch(url).then(r => r.blob()).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

// Compact for scanning (55.4K, 6.28B); callers put the exact value in a title.
function fmtCompact(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 1 : 2).replace(/\.0+$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function renderMetrics(items) {
  return `<dl class="metrics">${items.map(m => `<div class="metric"><dt>${escHtml(m.label)}</dt><dd title="${escHtml(m.title || String(m.value))}">${escHtml(String(m.value))}</dd>${m.note ? `<p class="metric-note">${escHtml(m.note)}</p>` : ''}</div>`).join('')}</dl>`;
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCost(c) {
  if (!c || c === 0) return '';
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtToolName(name) {
  if (!name) return '';
  // MCP tools: mcp__provider__action → mcp_provider_action
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const provider = mcp[1].replace(/__/g, '_');
    const action = mcp[2].replace(/__/g, '_');
    return `mcp_${provider}_${action}`;
  }
  return name;
}

function fmtToolGroup(name) {
  if (!name) return '';
  // MCP tools: collapse to mcp_provider (no action)
  const mcp = name.match(/^mcp__(.+?)__/);
  if (mcp) return 'mcp_' + mcp[1].replace(/__/g, '_');
  return name;
}

function truncate(s, n = 200) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

function shortSessionId(id) {
  if (!id) return '';
  return id.length > 24 ? `${id.slice(0, 8)}\u2026${id.slice(-8)}` : id;
}

// One short fade per navigation: the skeleton fades in, the real content
// that replaces it a moment later does not fade again.
function transitionView() {
  const now = performance.now();
  if (now - (window._lastViewFade || 0) < 700) return;
  window._lastViewFade = now;
  content.classList.remove('view-enter');
  void content.offsetWidth;
  content.classList.add('view-enter');
}

// Lists the user returns to (Back from a session) are restored instantly
// from the last render, at the same scroll position, then refreshed in place.
const viewCache = {};
const VIEW_CACHE_MS = 5 * 60 * 1000;
function rememberCurrentView() {
  const v = (location.hash || '').slice(1) || 'overview';
  if (v === 'sessions' || v === 'overview') viewCache[v] = { html: content.innerHTML, y: window.scrollY, at: Date.now() };
}
function restoreView(name) {
  const c = viewCache[name];
  if (!c || Date.now() - c.at > VIEW_CACHE_MS) return false;
  content.innerHTML = c.html;
  window.scrollTo(0, c.y);
  return true;
}
function stillOn(name) {
  const v = (location.hash || '').slice(1) || 'overview';
  return v === name;
}
function renderInPlace(html) {
  const y = window.scrollY;
  content.innerHTML = html;
  window.scrollTo(0, y);
}

function skeletonLine(width = '100%', height = '12px') {
  return `<div class="skeleton-line" style="width:${width};height:${height}"></div>`;
}

function skeletonRows(count = 6, kind = 'event') {
  if (kind === 'session' || kind === 'file') {
    return `<div class="skeleton-list">${Array.from({ length: count }).map(() => `
      <div class="skeleton-row">
        <div class="skeleton-line" style="width:56%;height:13px"></div>
        <div class="skeleton-line" style="width:32%;height:11px;margin-top:7px"></div>
      </div>`).join('')}</div>`;
  }
  if (kind === 'stats') {
    return `<div class="metrics">${Array.from({ length: count }).map(() => `
      <div class="metric"><div class="skeleton-line" style="width:60px;height:10px"></div><div class="skeleton-line" style="width:84px;height:22px;margin-top:8px"></div></div>`).join('')}</div>`;
  }
  return Array.from({ length: count }).map(() => `
    <div class="event-item skeleton-row">
      <div class="skeleton-line" style="width:64px;height:10px"></div>
      <div class="skeleton-line" style="width:44px;height:10px"></div>
      <div class="event-body">
        <div class="skeleton-line" style="width:82%;height:12px"></div>
        <div class="skeleton-line" style="width:66%;height:12px;margin-top:8px"></div>
      </div>
    </div>
  `).join('');
}

// --- Hash routing ---
window._navDepth = 0;

function setHash(hash, replace) {
  const target = '#' + hash;
  if (window.location.hash === target) return;
  if (replace) {
    history.replaceState(null, '', target);
  } else {
    history.pushState(null, '', target);
    window._navDepth++;
  }
}

function updateNavActive(view) {
  $$('.nav-item').forEach(i => i.classList.remove('active'));
  const navItem = $(`.nav-item[data-view="${view}"]`);
  if (navItem) navItem.classList.add('active');
  // Settings gear buttons
  const isSettings = view === 'stats';
  document.getElementById('settings-btn')?.classList.toggle('active', isSettings);
  document.getElementById('settings-btn-mobile')?.classList.toggle('active', isSettings);
}

function updateMobileNavActive(view) {
  $$('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  const btn = $(`.mobile-nav-btn[data-view="${view}"]`);
  if (btn) btn.classList.add('active');
}

function handleRoute() {
  clearJumpUi();
  const raw = (window.location.hash || '').slice(1) || 'overview';
  if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
  if (window._timelineScrollHandler) { window.removeEventListener('scroll', window._timelineScrollHandler); window._timelineScrollHandler = null; }

  if (raw.startsWith('session/')) {
    const id = decodeURIComponent(raw.slice('session/'.length));
    if (id) { viewSession(id); return; }
  }

  const normalized = raw === 'search' ? 'overview' : raw;
  const view = normalized === 'overview' || normalized === 'sessions' || normalized === 'timeline' || normalized === 'files' || normalized === 'stats' || normalized === 'insights' ? normalized : 'overview';
  window._lastView = view;
  updateNavActive(view);
  updateMobileNavActive(view);
  if (view === 'overview') viewOverview();
  else if (view === 'sessions') viewSessions();
  else if (view === 'files') viewFiles();
  else if (view === 'timeline') viewTimeline();
  else if (view === 'insights') viewInsights();
  else viewStats();
}

window.addEventListener('popstate', () => {
  if (window._navDepth > 0) window._navDepth--;
  handleRoute();
});

const EVENT_ROLE_LABELS = { tool: 'Tool', result: 'Result', user: 'User', assistant: 'Assistant' };
const TOOL_SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'query', 'q', 'url', 'description', 'prompt', 'name'];

function eventKind(ev) {
  if (ev.type === 'tool_call') return 'tool';
  if (ev.type === 'tool_result') return 'result';
  if (ev.role === 'user') return 'user';
  if (ev.role === 'assistant') return 'assistant';
  return 'other';
}

// The one argument a reader needs to know what a call did: the shell command,
// the file, the pattern, the URL. Falls back to the first string argument.
function summarizeToolArgs(raw) {
  if (!raw) return { summary: '', pretty: '' };
  let args;
  try { args = JSON.parse(raw); } catch { return { summary: raw.split('\n')[0], pretty: raw }; }
  const pretty = JSON.stringify(args, null, 2);
  if (!args || typeof args !== 'object') return { summary: String(args), pretty };
  const key = TOOL_SUMMARY_KEYS.find(k => typeof args[k] === 'string' && args[k].trim());
  const value = key ? args[key] : Object.values(args).find(v => typeof v === 'string' && v.trim());
  return { summary: value ? value.replace(/\s+/g, ' ').trim() : '', pretty };
}

function renderEvent(ev) {
  const kind = eventKind(ev);
  const role = EVENT_ROLE_LABELS[kind] || escHtml(ev.role || ev.type || '');
  let body = '';

  if (kind === 'tool') {
    const { summary, pretty } = summarizeToolArgs(ev.tool_args);
    body = `<div class="tool-line"><span class="tool-name">${escHtml(fmtToolName(ev.tool_name))}</span>${summary ? `<code class="tool-summary">${escHtml(truncate(summary, 220))}</code>` : ''}</div>
      ${pretty ? `<details class="tool-detail"><summary>Arguments</summary><pre>${escHtml(pretty)}</pre></details>` : ''}`;
  } else if (kind === 'result') {
    const out = ev.content || '';
    const first = out.split('\n').find(l => l.trim()) || '';
    const lines = out ? out.split('\n').length : 0;
    body = `<div class="tool-line"><span class="tool-name">${escHtml(fmtToolName(ev.tool_name) || 'Output')}</span>${first ? `<code class="tool-summary">${escHtml(truncate(first.trim(), 220))}</code>` : '<span class="tool-empty">no output</span>'}</div>
      ${out && (lines > 1 || out.length > 220) ? `<details class="tool-detail"><summary>Output \u00b7 ${lines} line${lines === 1 ? '' : 's'}</summary><pre>${escHtml(truncate(out, 4000))}</pre></details>` : ''}`;
  } else {
    body = `<div class="event-content">${escHtml(ev.content || '')}</div>`;
  }

  return `<div class="event-item ev-${kind}" data-event-id="${escHtml(ev.id)}">
    <time class="event-time" datetime="${escHtml(ev.timestamp || '')}">${fmtTimeShort(ev.timestamp)}</time>
    <span class="event-role">${role}</span>
    <div class="event-body">${body}</div>
  </div>`;
}

// Timeline interleaves sessions; a session line marks each change of session so
// every event has context, and opens that session on click.
function renderTimelineEvents(events, prevSessionId = null) {
  let prev = prevSessionId;
  return events.map(ev => {
    let head = '';
    if (ev.session_id && ev.session_id !== prev) {
      const title = cleanSessionSummary(ev.session_summary || '', '');
      head = `<button class="tl-session" data-open-session="${escHtml(ev.session_id)}"><span class="tl-session-title">${escHtml(truncate(title, 110))}</span><span class="tl-session-id">${escHtml(shortSessionId(ev.session_id))}</span><span class="tl-open">Open${icon('chevron', 12)}</span></button>`;
      prev = ev.session_id;
    }
    return head + renderEvent(ev);
  }).join('');
}

function renderTimelineEvent(ev) {
  return renderEvent(ev);
}

function fmtDuration(start, end) {
  if (!start) return '';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function fmtTimeOnly(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function normalizeAgentLabel(a) {
  if (!a) return a;
  if (a === 'main') return 'openclaw-main';
  if (a.startsWith('claude-') || a.startsWith('claude--')) return 'claude-code';
  return a;
}

function clearJumpUi() {
  const indicator = document.getElementById('jumpIndicator');
  if (indicator) indicator.remove();
  const returnBtn = document.getElementById('returnJumpBtn');
  if (returnBtn) returnBtn.remove();
}

function cleanSessionSummary(text, fallbackText = '') {
  const pick = (input) => {
    const raw = (input || '').trim();
    if (!raw) return '';

    const jsonFence = /```json[\s\S]*?```/gi;
    const fences = [...raw.matchAll(jsonFence)];
    if (fences.length >= 2) {
      const second = fences[1];
      const after = raw.slice(second.index + second[0].length).trim();
      if (after) {
        const line = after.split(/\r?\n/).map(l => l.trim()).find(Boolean);
        if (line) return line;
      }
    }

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const skip = [
      /^conversation info/i,
      /^sender/i,
      /^```/,
      /^\{/, /^\}/,
      /^"(message_id|sender_id|sender|timestamp|label|id|name)"/i,
      /^untrusted metadata/i
    ];

    let candidate = lines.find(l => !skip.some(rx => rx.test(l)));
    if (candidate) {
      candidate = candidate
        .replace(/^\[cron:[^\]]+\]\s*/i, '')
        .replace(/^\[heartbeat:[^\]]+\]\s*/i, '')
        .trim();
    }
    if (!candidate || skip.some(rx => rx.test(candidate))) {
      if (/heartbeat session/i.test(raw)) return 'Heartbeat session';
      return '';
    }
    return candidate;
  };

  return pick(text) || pick(fallbackText) || 'Session activity';
}

function isInternalProjectTag(tag) {
  if (!tag) return true;
  if (tag.startsWith('agent:')) return true;
  if (tag.startsWith('claude:')) return true;
  return false;
}

const expandedSessionGroups = new Set();

const ICON_PATHS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor" stroke="none"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  toStart: '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
  download: '<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  up: '<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>',
};

function icon(name, size = 14) {
  return `<svg class="i i-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

// A status glyph in a fixed leading column, readable at a glance: a pulsing
// dot while live, a dashed ring when stale, a check when it finished, a stop
// square when someone ended it, an x when the source says it failed.
function statusIcon(s) {
  let kind = 'done';
  let label = 'Finished';
  if (s.status === 'live') { kind = 'live'; label = 'Live: activity in the last 15 minutes'; }
  else if (s.status === 'stale') { kind = 'stale'; label = 'Stale: never recorded an end'; }
  else if (s.ended_reason === 'manual') { kind = 'done'; label = 'Marked done in AgentActa'; }
  else if (s.ended_reason === 'source' && s.source_status && !/^(done|completed?)$/i.test(s.source_status)) { kind = 'failed'; label = s.source_status; }
  const g = {
    live: '<circle class="ring" cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none"/>',
    stale: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2.2"/>',
    done: '<circle cx="8" cy="8" r="5.5"/><path d="M5.7 8.2l1.6 1.6 3.1-3.3"/>',
    stopped: '<circle cx="8" cy="8" r="5.5"/><rect x="6" y="6" width="4" height="4" rx="0.6" fill="currentColor" stroke="none"/>',
    failed: '<circle cx="8" cy="8" r="6" fill="currentColor" stroke="none"/><path d="M6 6l4 4M10 6l-4 4" stroke="var(--bg-surface)"/>',
  }[kind];
  return `<span class="sicon sicon-${kind}" title="${escHtml(label)}" role="img" aria-label="${escHtml(label)}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${g}</svg></span>`;
}

// Bottom-center confirmation with an optional action (Undo). Replaces the
// previous auto-dismissing error pill so every mutation gives feedback.
function showToast(message, { actionLabel, onAction, tone = 'default', timeout = 6000 } = {}) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${tone}`;
  t.innerHTML = `<span class="toast-msg">${escHtml(message)}</span>${actionLabel ? `<button class="toast-action">${icon('undo', 13)}${escHtml(actionLabel)}</button>` : ''}<kbd class="toast-dismiss" aria-hidden="true">Esc</kbd>`;
  const dismiss = () => {
    if (!t.isConnected) return;
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 180);
  };
  if (actionLabel) {
    t.querySelector('.toast-action').addEventListener('click', async () => {
      dismiss();
      if (onAction) await onAction();
    });
  }
  host.appendChild(t);
  setTimeout(dismiss, timeout);
  t._dismiss = dismiss;
  return t;
}

// Status is plain colored text; only exceptions get ink (a quietly finished
// session renders nothing). Live alone gets a dot because it changes as you watch.
function renderSessionStatus(s) {
  if (s.status === 'live') return '<span class="st st-live" title="Activity in the last 15 minutes">Live</span>';
  if (s.status === 'stale') return '<span class="st st-stale" title="No end was recorded and it has been quiet for over 15 minutes">Stale</span>';
  if (s.ended_reason === 'manual') return '<span class="st st-ended" title="Marked done in AgentActa">Marked done</span>';
  if (s.ended_reason === 'source' && s.source_status && !/^(done|completed?)$/i.test(s.source_status)) {
    return `<span class="st st-failed">${escHtml(s.source_status)}</span>`;
  }
  return '';
}

// AgentActa can't stop an agent, so the only honest action is filing away a
// session that is over but never recorded an end. Live sessions get none.
function canEndSession(s) {
  return s.status === 'stale';
}

function sessionProjects(s) {
  let projects = [];
  if (s.projects) { try { projects = JSON.parse(s.projects); } catch {} }
  return [...new Set(projects)].filter(p => !isInternalProjectTag(p));
}

function sessionModels(s) {
  let models = [];
  if (s.models) { try { models = JSON.parse(s.models); } catch {} }
  if (!models.length && s.model) models = [s.model];
  return models;
}

// Who/where/what as one quiet line: agent, type, project, model. Plain text in
// a fixed order reads faster than a row of colored chips.
function renderSessionMeta(s) {
  const agent = normalizeAgentLabel(s.agent || '');
  const parts = [];
  if (agent) parts.push(`<span class="m-agent">${escHtml(agent)}</span>`);
  if (s.session_type && s.session_type !== agent) parts.push(escHtml(s.session_type));
  const projects = sessionProjects(s);
  if (projects.length) parts.push(`<span class="m-project">${escHtml(projects.slice(0, 2).join(', '))}${projects.length > 2 ? ` +${projects.length - 2}` : ''}</span>`);
  const models = sessionModels(s);
  if (models.length) parts.push(`<span class="m-model">${escHtml(models[0])}${models.length > 1 ? ` +${models.length - 1}` : ''}</span>`);
  return parts.join('<span class="sep" aria-hidden="true"> \u00b7 </span>');
}

function renderSessionItem(s) {
  const isStale = s.status === 'stale';
  const duration = isStale ? 'never closed' : fmtDuration(s.start_time, s.end_time || s.start_time);
  const headline = s.label || cleanSessionSummary(s.summary, s.initial_prompt);
  return `
    <div class="session-item" data-id="${escHtml(s.id)}" role="link" tabindex="0">
      ${statusIcon(s)}
      <div class="si-main">
        <div class="si-title">${renderSessionStatus(s)}<span class="si-headline">${escHtml(truncate(headline, 160))}</span></div>
        <div class="si-meta">${renderSessionMeta(s)}</div>
      </div>
      <div class="si-when"><span>${fmtTime(s.start_time)}</span><span class="si-dur">${duration}</span></div>
      <div class="si-counts"><span title="${s.message_count} messages">${fmtCompact(s.message_count)} msg</span><span title="${s.tool_count} tool calls">${fmtCompact(s.tool_count)} tools</span></div>
      <div class="si-action">${canEndSession(s) ? renderEndButton(s) : ''}</div>
      <span class="si-go" aria-hidden="true">${icon('chevron', 16)}</span>
    </div>
  `;
}

function renderSessionList(sessions, { tree = false } = {}) {
  if (!sessions.length) return '';
  return `<div class="session-list">${sessions.map(s => tree ? renderSessionTree(s) : renderSessionItem(s)).join('')}</div>`;
}

function renderEndButton(s) {
  return `<button class="row-btn" data-end-session="${escHtml(s.id)}" title="This session went quiet without recording an end. Mark it done so it stops showing as open.">${icon('check', 11)}Mark done</button>`;
}

function renderChildrenToggle(s, expanded) {
  const n = s.child_count || 0;
  const extra = (s.descendant_count || 0) > n ? ` (${s.descendant_count} total)` : '';
  const live = s.live_descendant_count ? `, <span class="st-live">${s.live_descendant_count} live</span>` : '';
  return `<button class="subagent-toggle" data-toggle-children="${escHtml(s.id)}" aria-expanded="${expanded}">${n} subagent${n === 1 ? '' : 's'}${extra}${live}</button>`;
}

function isGroupExpanded(s) {
  if (expandedSessionGroups.has(s.id)) return true;
  if (expandedSessionGroups.has('!' + s.id)) return false;
  return s.live_descendant_count > 0;
}

// One line per subagent: status, title, when, how much. Columns line up so a
// long list can be scanned; the parent card already carries tags and models.
function renderSubagentRow(s) {
  const when = s.status === 'stale' ? `${fmtTime(s.start_time)} \u00b7 never closed` : `${fmtTime(s.start_time)} \u00b7 ${fmtDuration(s.start_time, s.end_time || s.start_time)}`;
  const title = s.label || cleanSessionSummary(s.summary, s.initial_prompt);
  return `<div class="subagent-row" data-open-session="${escHtml(s.id)}" role="link" tabindex="0">
    <span class="subagent-status">${statusIcon(s)}${renderSessionStatus(s)}</span>
    <span class="subagent-title" title="${escHtml(title)}">${escHtml(truncate(title, 140))}</span>
    <span class="subagent-meta">${when} \u00b7 ${s.message_count} msg \u00b7 ${s.tool_count} tools</span>
    <span class="subagent-action">${canEndSession(s) ? renderEndButton(s) : ''}</span>
    <span class="si-go" aria-hidden="true">${icon('chevron', 14)}</span>
  </div>`;
}

function renderSubagentList(kids, hidden) {
  return `<div class="subagent-list"${hidden ? ' hidden' : ''}>${kids.map(renderSubagentNode).join('')}</div>`;
}

function renderSubagentNode(s) {
  const kids = Array.isArray(s.children) ? s.children : [];
  if (!kids.length) return renderSubagentRow(s);
  const open = isGroupExpanded(s);
  return renderSubagentRow(s) + renderChildrenToggle(s, open) + renderSubagentList(kids, !open);
}

// A top-level session card with its subagents listed beneath it. Groups with
// a live descendant start expanded so running work is visible at a glance.
function renderSessionTree(s) {
  const kids = Array.isArray(s.children) ? s.children : [];
  if (!kids.length) return renderSessionItem(s);
  const open = isGroupExpanded(s);
  return `<div class="session-group">${renderSessionItem(s)}${renderChildrenToggle(s, open)}${renderSubagentList(kids, !open)}</div>`;
}

async function endSession(id, action = 'end') {
  const res = await api(`/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  if (res._error) {
    alertInline(res.error || 'Unable to update session');
    return null;
  }
  return res.session;
}

function alertInline(msg) {
  showToast(msg, { tone: 'error' });
}

// Delegated in the capture phase so these controls never also trigger the
// card's own "open session" click handler.
content.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle-children]');
  const endBtn = e.target.closest('[data-end-session]');
  const staleBtn = e.target.closest('#endStaleBtn');
  const row = e.target.closest('[data-open-session]') || e.target.closest('.session-item[data-id]');
  if (!toggle && !endBtn && !staleBtn && !row) return;
  e.stopPropagation();
  e.preventDefault();

  if (staleBtn) { if (!staleBtn.disabled) endAllStale(staleBtn); return; }

  if (toggle) {
    const id = toggle.dataset.toggleChildren;
    const list = toggle.nextElementSibling;
    if (!list || !list.classList.contains('subagent-list')) return;
    const open = list.hasAttribute('hidden');
    list.toggleAttribute('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) { expandedSessionGroups.add(id); expandedSessionGroups.delete('!' + id); }
    else { expandedSessionGroups.delete(id); expandedSessionGroups.add('!' + id); }
    return;
  }

  if (endBtn) {
    endBtn.disabled = true;
    const id = endBtn.dataset.endSession;
    let target = endBtn.closest('.subagent-row') || endBtn.closest('.session-item');
    const swap = (session) => {
      if (!target || !target.isConnected) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = target.classList.contains('subagent-row') ? renderSubagentRow(session) : renderSessionItem(session);
      const fresh = tmp.firstElementChild;
      fresh.classList.add('row-flash');
      target.replaceWith(fresh);
      if (fresh.classList.contains('session-item')) fresh.addEventListener('click', () => viewSession(session.id));
      target = fresh;
    };
    const updated = await endSession(id, 'end');
    if (!updated) { endBtn.disabled = false; return; }
    swap(updated);
    showToast('Marked done', {
      actionLabel: 'Undo',
      onAction: async () => { const back = await endSession(id, 'reopen'); if (back) swap(back); },
    });
    return;
  }

  if (row.closest('#results')) {
    window._lastView = 'search';
    window._lastSearchQuery = $('#searchInput')?.value || '';
  }
  viewSession(row.dataset.openSession || row.dataset.id);
}, true);

content.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest && e.target.closest('[data-open-session], .session-item[data-id]');
  if (!row || e.target !== row) return;
  e.preventDefault();
  viewSession(row.dataset.openSession || row.dataset.id);
});

async function viewSearch(query = '') {
  clearJumpUi();
  const typeFilter = window._searchType || '';
  const roleFilter = window._searchRole || '';

  const seg = (filter, val, label, active) => `<button class="filter-chip${active ? ' active' : ''}" data-filter="${filter}" data-val="${val}" aria-pressed="${active}">${label}</button>`;
  let html = `<h1 class="page-title">Search</h1>
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="searchInput" placeholder="Search messages, tool calls, files\u2026" value="${escHtml(query)}">
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Event type">
        ${seg('type', '', 'All', typeFilter === '')}${seg('type', 'message', 'Messages', typeFilter === 'message')}${seg('type', 'tool_call', 'Tool calls', typeFilter === 'tool_call')}${seg('type', 'tool_result', 'Results', typeFilter === 'tool_result')}
      </div>
      <div class="seg" role="group" aria-label="Role">
        ${seg('role', '', 'Any role', roleFilter === '')}${seg('role', 'user', 'User', roleFilter === 'user')}${seg('role', 'assistant', 'Assistant', roleFilter === 'assistant')}
      </div>
    </div>
    <div id="results">
      ${skeletonRows(4, 'session')}
    </div>`;

  content.innerHTML = html;
  transitionView();

  const input = $('#searchInput');
  input.focus();
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => doSearch(input.value), 250);
  });

  $$('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      const v = chip.dataset.val;
      if (f === 'type') window._searchType = v;
      if (f === 'role') window._searchRole = v;
      viewSearch(input.value);
    });
  });

  if (query) doSearch(query);
  else showSearchHome();
}

async function showSearchHome() {
  const el = $('#results');
  const reqId = (window._searchReqSeq = (window._searchReqSeq || 0) + 1);
  el.innerHTML = `${skeletonRows(4, 'session')}`;

  const sessions = await api('/sessions?limit=8');
  if (reqId !== window._searchReqSeq) return;
  if (sessions._error) {
    el.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let suggestions = [];
  try { const r = await fetch('/api/suggestions'); const d = await r.json(); suggestions = d.suggestions || []; } catch(e) { suggestions = []; }
  if (reqId !== window._searchReqSeq) return;

  let html = `
    ${suggestions.length ? `<p class="suggestions">Try ${suggestions.map(q => `<button class="suggestion-chip text-btn" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('<span class="sep" aria-hidden="true">, </span>')}</p>` : ''}
    <h2 class="section-label">Recent sessions</h2>
    ${renderSessionList(sessions.sessions)}
  `;

  el.innerHTML = html;

  $$('.suggestion-chip', el).forEach(chip => {
    chip.addEventListener('click', () => {
      $('#searchInput').value = chip.dataset.q;
      doSearch(chip.dataset.q);
    });
  });

  $$('.session-item', el).forEach(item => {
    item.addEventListener('click', () => {
      window._lastView = 'search';
      window._lastSearchQuery = $('#searchInput')?.value || '';
      viewSession(item.dataset.id);
    });
  });
}

async function doSearch(q) {
  const el = $('#results');
  const reqId = (window._searchReqSeq = (window._searchReqSeq || 0) + 1);
  if (!q.trim()) { el.innerHTML = '<div class="empty"><h2>Type to search</h2><p>Search across all sessions, messages, and tool calls</p></div>'; return; }

  el.innerHTML = `${skeletonRows(6, 'event')}`;

  const type = window._searchType || '';
  const role = window._searchRole || '';
  let url = `/search?q=${encodeURIComponent(q)}&limit=100`;
  if (type) url += `&type=${type}`;
  if (role) url += `&role=${role}`;

  const data = await api(url);
  if (reqId !== window._searchReqSeq) return;

  if (data._error || data.error) { el.innerHTML = `<div class="empty"><p>${escHtml(data.error || 'Server error')}</p></div>`; return; }
  if (!data.results.length) { el.innerHTML = '<div class="empty"><h2>No results</h2><p>Try a different search term or adjust filters</p></div>'; return; }

  el.innerHTML = `<div class="results-head">
      <span class="page-count">${data.results.length}${data.results.length === 100 ? '+' : ''} results</span>
      <span class="export-links">Export
        <a href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=md','search.md');return false">Markdown</a>
        <a href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=json','search.json');return false">JSON</a>
      </span>
    </div>
    <div class="result-list">${data.results.map(r => {
      const kind = eventKind(r);
      return `<div class="result-item" data-open-session="${escHtml(r.session_id)}" role="link" tabindex="0">
        <div class="result-meta"><span class="event-role ev-${kind}">${EVENT_ROLE_LABELS[kind] || escHtml(r.role || r.type)}</span>${r.tool_name ? `<span class="tool-name">${escHtml(fmtToolName(r.tool_name))}</span>` : ''}<time>${fmtTime(r.timestamp)}</time></div>
        <div class="result-content">${escHtml(truncate(r.content || r.tool_args || r.tool_result || '', 400))}</div>
      </div>`;
    }).join('')}</div>`;
}

async function viewSessions() {
  clearJumpUi();
  window._currentSessionId = null;
  const restored = restoreView('sessions');
  if (!restored) {
    content.innerHTML = `<div class="page-title">Sessions</div>${skeletonRows(4, 'session')}`;
    transitionView();
  }
  const data = await api('/sessions?limit=200&roots=1');
  if (!stillOn('sessions')) return;
  if (data._error) {
    if (restored) return;
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let html = `<header class="page-head"><h1 class="page-title">Sessions</h1><span class="page-count">${data.total.toLocaleString()} top-level</span></header>`;
  if (data.staleCount > 0) {
    html += `<p class="stale-note">${data.staleCount} session${data.staleCount === 1 ? '' : 's'} never recorded an end and ${data.staleCount === 1 ? 'has' : 'have'} been quiet for over 15 minutes. <button class="row-btn row-btn-warn" id="endStaleBtn">${icon('check', 11)}Mark ${data.staleCount === 1 ? 'it' : 'all'} done</button></p>`;
  }
  html += renderSessionList(data.sessions, { tree: true });
  if (restored) renderInPlace(html);
  else { content.innerHTML = html; transitionView(); }
}

async function endAllStale(btn) {
  btn.disabled = true;
  const res = await api('/sessions/end-stale', { method: 'POST' });
  if (res._error) { btn.disabled = false; alertInline(res.error || 'Unable to update sessions'); return; }
  const ids = res.ids || [];
  delete viewCache.sessions;
  await viewSessions();
  showToast(`Marked ${ids.length} stale session${ids.length === 1 ? '' : 's'} done`, {
    actionLabel: 'Undo',
    timeout: 10000,
    onAction: async () => {
      await Promise.all(ids.map(sid => api(`/sessions/${encodeURIComponent(sid)}/reopen`, { method: 'POST' })));
      delete viewCache.sessions;
      if (stillOn('sessions')) viewSessions();
      showToast(`Reopened ${ids.length} session${ids.length === 1 ? '' : 's'}`);
    },
  });
}

async function viewSession(id) {
  rememberCurrentView();
  clearJumpUi();
  window._recentSessionIds = [id, ...(window._recentSessionIds || []).filter(x => x !== id)].slice(0, 5);
  if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
  window._currentSessionId = id;
  setHash('session/' + encodeURIComponent(id));
  window.scrollTo(0, 0);
  content.innerHTML = `
    <div class="back-btn">← Back</div>
    <div class="page-title">Session</div>
    ${skeletonRows(8, 'event')}
  `;
  transitionView();
  const data = await api(`/sessions/${id}`);

  if (data._error || data.error) { content.innerHTML = `<div class="empty"><h2>${escHtml(data.error || 'Unable to load')}</h2></div>`; return; }

  const s = data.session;
  const projectFilters = Array.isArray(data.projectFilters)
    ? data.projectFilters.filter(p => p && p.project && Number.isFinite(Number(p.eventCount)))
    : [];
  const parent = data.parent || null;
  const children = Array.isArray(data.children) ? data.children : [];
  const childTotal = children.reduce((n, c) => n + 1 + (c.descendant_count || 0), 0);
  const childrenCollapsed = children.length > 10 && !children.some(c => c.status === 'live');
  const headline = s.label || cleanSessionSummary(s.summary, s.initial_prompt);
  const endText = s.end_time ? fmtTimeShort(s.end_time) : (s.status === 'live' ? 'now' : 'no end recorded');
  const spanText = s.end_time ? ` (${fmtDuration(s.start_time, s.end_time)})` : '';
  const tokenStats = s.output_tokens
    ? [`<span title="${(s.output_tokens).toLocaleString()} output tokens">${fmtCompact(s.output_tokens)} output</span>`, `<span title="${(s.input_tokens + s.cache_read_tokens).toLocaleString()} input tokens incl. cache reads">${fmtCompact(s.input_tokens + s.cache_read_tokens)} input tokens</span>`]
    : (s.total_tokens ? [`<span>${fmtCompact(s.total_tokens)} tokens</span>`] : []);
  let html = `
    <button class="back-btn" id="backBtn">\u2190 Back</button>
    ${parent ? `<button class="session-parent-link" id="parentSessionLink" title="Open parent session">${icon('up', 13)}Subagent of <span>${escHtml(truncate(parent.label || cleanSessionSummary(parent.summary, parent.initial_prompt), 90))}</span></button>` : ''}
    <header class="detail-head">
      <h1 class="page-title detail-title">${escHtml(truncate(headline, 240))}</h1>
      <p class="detail-meta">${renderSessionMeta(s)}<span class="sep" aria-hidden="true"> \u00b7 </span>${fmtDate(s.start_time)}, ${fmtTimeShort(s.start_time)} \u2013 ${endText}${spanText}</p>
      <p class="detail-stats"><span>${s.message_count.toLocaleString()} messages</span><span>${s.tool_count.toLocaleString()} tool calls</span>${tokenStats.join('')}</p>
      <div class="detail-actions">
        <span id="sessionStatusSlot" class="detail-status"></span>
        ${s.first_message_id ? `<button class="btn" id="jumpToStartBtn" title="Scroll to the first user prompt">${icon('toStart', 12)}Initial prompt</button>` : ''}
        <span class="btn-group" role="group" aria-label="Export">
          <button class="btn" onclick="dlExport('/api/export/session/${id}?format=md','session.md')" title="Download as Markdown">${icon('download', 12)}Markdown</button>
          <button class="btn" onclick="dlExport('/api/export/session/${id}?format=json','session.json')" title="Download as JSON">JSON</button>
          ${data.hasArchive ? `<button class="btn" onclick="dlExport('/api/archive/export/${id}','session.jsonl')" title="Download raw JSONL">JSONL</button>` : ''}
        </span>
        <span class="session-id-row">
          <code class="session-id-value" title="${escHtml(id)}">${escHtml(id)}</code>
          <button class="session-id-copy" id="copySessionId" title="Copy session ID" aria-label="Copy session ID">${icon('copy', 13)}</button>
          <span class="session-id-copied" id="copyConfirm" role="status">Copied</span>
        </span>
      </div>
    </header>
    ${projectFilters.length ? `
      <div class="seg" id="sessionProjectFilters" role="group" aria-label="Filter events by project">
        <button class="filter-chip active" data-project-filter="all">All projects</button>
        ${projectFilters.map(p => `<button class="filter-chip" data-project-filter="${escHtml(p.project)}">${escHtml(p.project)} <span class="count">${p.eventCount}</span></button>`).join('')}
      </div>
    ` : ''}
    ${children.length ? `
      <section class="detail-subagents">
        <button class="section-label subagent-heading" data-toggle-children="${escHtml(id)}" aria-expanded="${!childrenCollapsed}">Subagents (${children.length}${childTotal > children.length ? `, ${childTotal} total` : ''})</button>
        ${renderSubagentList(children, childrenCollapsed)}
      </section>
    ` : ''}
    <h2 class="section-label" id="sessionEventsLabel">Events</h2>
    <div id="eventsContainer" class="event-list"></div>
    <div class="empty" id="sessionEventsEmpty" style="display:none"><h2>No events</h2><p>This session has no events to display.</p></div>
    <div id="sessionInsightsPanel" class="loading" style="margin-top:var(--space-xl)">Loading insights...</div>
  `;

  const PAGE_SIZE = 50;
  const allEvents = Array.isArray(data.events) ? [...data.events] : [];
  let activeProjectFilter = 'all';
  let rendered = 0;
  let onScroll = null;
  let pendingNewCount = 0;

  const getFilteredEvents = () => {
    if (activeProjectFilter === 'all') return allEvents;
    return allEvents.filter(ev => ev.project === activeProjectFilter);
  };

  const updateEventsLabel = () => {
    const el = $('#sessionEventsLabel');
    if (!el) return;
    const count = getFilteredEvents().length;
    if (activeProjectFilter === 'all') {
      el.textContent = `Events (${count})`;
      return;
    }
    el.textContent = `Events (${count}) · ${activeProjectFilter}`;
  };

  const updateEventsEmptyState = () => {
    const empty = $('#sessionEventsEmpty');
    if (!empty) return;
    empty.style.display = getFilteredEvents().length ? 'none' : 'block';
  };

  const setProjectFilter = (nextFilter) => {
    if (nextFilter === activeProjectFilter) return;
    activeProjectFilter = nextFilter;
    const chips = $$('#sessionProjectFilters .filter-chip');
    chips.forEach(node => node.classList.toggle('active', node.dataset.projectFilter === activeProjectFilter));
    pendingNewCount = 0;
    const indicator = document.getElementById('newEventsIndicator');
    if (indicator) indicator.remove();
    resetRenderedEvents();
  };

  function renderBatch() {
    const filtered = getFilteredEvents();
    const batch = filtered.slice(rendered, rendered + PAGE_SIZE);
    if (!batch.length) return;
    const frag = document.createElement('div');
    frag.innerHTML = batch.map(renderEvent).join('');
    const container = document.getElementById('eventsContainer');
    if (container) {
      while (frag.firstChild) container.appendChild(frag.firstChild);
    }
    rendered += batch.length;
  }

  content.innerHTML = html;
  transitionView();

  const syncScrollHandler = () => {
    const total = getFilteredEvents().length;
    if (total <= rendered) {
      if (onScroll) {
        window.removeEventListener('scroll', onScroll);
        onScroll = null;
      }
      return;
    }

    if (onScroll) return;

    let loading = false;
    onScroll = () => {
      if (loading || rendered >= getFilteredEvents().length) return;
      const scrollBottom = window.innerHeight + window.scrollY;
      const threshold = document.body.offsetHeight - 300;
      if (scrollBottom >= threshold) {
        loading = true;
        renderBatch();
        loading = false;
        if (rendered >= getFilteredEvents().length) {
          window.removeEventListener('scroll', onScroll);
          onScroll = null;
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  };

  const resetRenderedEvents = () => {
    const container = document.getElementById('eventsContainer');
    if (!container) return;
    container.innerHTML = '';
    rendered = 0;
    renderBatch();
    syncScrollHandler();
    updateEventsLabel();
    updateEventsEmptyState();
  };

  resetRenderedEvents();

  const filterChips = $$('#sessionProjectFilters .filter-chip');
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const nextFilter = chip.dataset.projectFilter || 'all';
      setProjectFilter(nextFilter);
    });
  });

  $('#backBtn').addEventListener('click', () => {
    clearJumpUi();
    if (window._navDepth > 0) {
      history.back();
    } else {
      const view = window._lastView || 'sessions';
      setHash(view, true);
      handleRoute();
    }
  });

  const parentLink = $('#parentSessionLink');
  if (parentLink) parentLink.addEventListener('click', () => viewSession(parent.id));

  $('#copySessionId').addEventListener('click', async () => {
    const conf = $('#copyConfirm');
    const showCopied = () => {
      conf.textContent = 'Copied!';
      conf.classList.add('show');
      setTimeout(() => conf.classList.remove('show'), 1500);
    };

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(id);
        showCopied();
        return;
      }

      const ta = document.createElement('textarea');
      ta.value = id;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);

      if (ok) showCopied();
      else throw new Error('Copy failed');
    } catch {
      conf.textContent = 'Press Ctrl/Cmd+C';
      conf.classList.add('show');
      setTimeout(() => {
        conf.classList.remove('show');
        conf.textContent = 'Copied!';
      }, 1800);
    }
  });

  const jumpBtn = $('#jumpToStartBtn');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', async () => {
      const fromY = window.scrollY || window.pageYOffset || 0;
      const firstMessageId = s.first_message_id;

      jumpBtn.classList.add('jumping');
      jumpBtn.disabled = true;

      if (!firstMessageId) {
        jumpBtn.classList.remove('jumping');
        jumpBtn.disabled = false;
        return;
      }

      // Resolve from full session context, not just project-filtered events.
      const inCurrentFilter = getFilteredEvents().some(ev => ev.id === firstMessageId);
      if (!inCurrentFilter && activeProjectFilter !== 'all') {
        setProjectFilter('all');
      }

      // Let button state paint before heavy DOM work.
      await new Promise(requestAnimationFrame);

      // Load remaining events in chunks so UI stays responsive.
      let loops = 0;
      while (rendered < getFilteredEvents().length) {
        renderBatch();
        loops += 1;
        if (loops % 2 === 0) await new Promise(requestAnimationFrame);
      }

      const firstMessage = document.querySelector(`[data-event-id="${firstMessageId}"]`);
      if (!firstMessage) {
        jumpBtn.classList.remove('jumping');
        jumpBtn.disabled = false;
        return;
      }

      const targetY = Math.max(0, firstMessage.getBoundingClientRect().top + fromY - (window.innerHeight * 0.35));
      const distance = Math.abs(targetY - fromY);
      const useSmooth = distance < 1800;

      window.scrollTo({ top: targetY, behavior: useSmooth ? 'smooth' : 'auto' });

      const doneDelay = useSmooth ? 500 : 120;
      setTimeout(() => {
        firstMessage.classList.add('event-highlight');
        setTimeout(() => firstMessage.classList.remove('event-highlight'), 2000);

        jumpBtn.classList.remove('jumping');
        jumpBtn.disabled = false;

        let returnBtn = document.getElementById('returnJumpBtn');
        if (!returnBtn) {
          returnBtn = document.createElement('button');
          returnBtn.id = 'returnJumpBtn';
          returnBtn.className = 'return-jump-btn';
          returnBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"></path><polyline points="5 12 12 5 19 12"></polyline></svg>`;
          returnBtn.setAttribute('aria-label', 'Back to previous spot');
          returnBtn.title = 'Back to previous spot';
          document.body.appendChild(returnBtn);
        }
        returnBtn.classList.add('show');

        returnBtn.onclick = () => {
          window.scrollTo({ top: fromY, behavior: 'smooth' });
          returnBtn.classList.remove('show');
        };

        setTimeout(() => {
          if (returnBtn) returnBtn.classList.remove('show');
        }, 9000);
      }, doneDelay);
    });
  }

  // --- Lightweight realtime updates (polling fallback first) ---
  const knownIds = new Set(allEvents.map(e => e.id));

  const applyIncomingEvents = (incoming) => {
    const container = document.getElementById('eventsContainer');
    if (!container || !incoming?.length) return;

    const fresh = incoming.filter(e => !knownIds.has(e.id));
    if (!fresh.length) return;
    fresh.forEach(e => knownIds.add(e.id));

    // Delta endpoint returns oldest -> newest, and view is newest-first.
    for (const ev of fresh) allEvents.unshift(ev);

    const visibleFresh = activeProjectFilter === 'all'
      ? fresh
      : fresh.filter(ev => ev.project === activeProjectFilter);

    if (!visibleFresh.length) {
      updateEventsLabel();
      updateEventsEmptyState();
      syncScrollHandler();
      return;
    }

    const isAtTop = window.scrollY < 100;
    for (const ev of visibleFresh) {
      const div = document.createElement('div');
      div.innerHTML = renderEvent(ev);
      const el = div.firstElementChild;
      el.classList.add('event-highlight');
      container.insertBefore(el, container.firstChild);
      setTimeout(() => el.classList.remove('event-highlight'), 2000);
    }
    rendered += visibleFresh.length;
    updateEventsLabel();
    updateEventsEmptyState();
    syncScrollHandler();

    if (!isAtTop) {
      pendingNewCount += visibleFresh.length;
      let indicator = document.getElementById('newEventsIndicator');
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'newEventsIndicator';
        indicator.className = 'new-events-indicator';
        document.body.appendChild(indicator);
        indicator.addEventListener('click', () => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          indicator.remove();
          pendingNewCount = 0;
        });
      }
      indicator.textContent = `${pendingNewCount} new event${pendingNewCount !== 1 ? 's' : ''} ↑`;
    }
  };

  // Subscribe to real-time updates via SSE, with polling as a fallback.
  // "Following" is the client side of a live session: it can be paused, and it
  // stops on its own when the session is marked done.
  let lastSeenTs = allEvents.length ? allEvents[0].timestamp : new Date(0).toISOString();
  let lastSeenId = allEvents.length ? allEvents[0].id : '';
  let sessionState = { status: s.status, ended_reason: s.ended_reason, ended_at: s.ended_at, source_status: s.source_status };
  const pollNewEvents = async () => {
    try {
      const latest = await api(`/sessions/${id}/events?after=${encodeURIComponent(lastSeenTs)}&afterId=${encodeURIComponent(lastSeenId)}&limit=50`);
      const incoming = latest.events || [];
      if (incoming.length) {
        const tail = incoming[incoming.length - 1];
        lastSeenTs = tail.timestamp || lastSeenTs;
        lastSeenId = tail.id || lastSeenId;
        applyIncomingEvents(incoming);
      }
    } catch (err) {
      // silent; next tick will retry
    }
  };

  let pollInterval = null;
  let eventSource = null;
  let following = false;

  const startPolling = () => {
    if (pollInterval || !following) return;
    pollInterval = setInterval(pollNewEvents, 3000);
  };

  const stopFollowing = () => {
    following = false;
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    renderStatusControls();
  };

  const startFollowing = () => {
    if (following) return;
    following = true;
    if ('EventSource' in window) {
      eventSource = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream?after=${encodeURIComponent(lastSeenTs)}&afterId=${encodeURIComponent(lastSeenId)}`);
      eventSource.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data) || [];
          if (incoming.length) {
            const tail = incoming[incoming.length - 1];
            lastSeenTs = tail.timestamp || lastSeenTs;
            lastSeenId = tail.id || lastSeenId;
            applyIncomingEvents(incoming);
            // New activity always means the session is live again.
            if (sessionState.status !== 'live') { sessionState = { ...sessionState, status: 'live', ended_reason: null }; renderStatusControls(); }
          }
        } catch (err) {
          // malformed SSE payload; fallback polling can recover on the next tick
          startPolling();
        }
      };
      eventSource.addEventListener('status', (event) => {
        try {
          const next = JSON.parse(event.data);
          sessionState = { ...sessionState, ...next };
          if (next.status === 'ended' && next.ended_reason === 'manual') stopFollowing();
          else renderStatusControls();
        } catch { /* ignore */ }
      });
      eventSource.onerror = () => startPolling();
    } else {
      startPolling();
    }
    renderStatusControls();
  };

  function renderStatusControls() {
    const slot = document.getElementById('sessionStatusSlot');
    if (!slot) return;
    const st = { ...s, ...sessionState };
    slot.innerHTML = `
      <span class="detail-state">${statusIcon(st)}${renderSessionStatus(st) || '<span class="st st-ended">Finished</span>'}</span>
      ${canEndSession(st) ? `<button class="btn" id="endSessionBtn" title="This session went quiet without recording an end. Mark it done so it stops showing as open.">${icon('check', 12)}Mark done</button>` : ''}
      ${st.ended_reason === 'manual' ? `<button class="btn" id="reopenSessionBtn" title="Clear the ended mark">${icon('undo', 12)}Reopen</button>` : ''}
      <button class="btn" id="followToggleBtn" title="${following ? 'New events stream into this page as they are indexed' : 'New events are not being streamed into this page'}">${following ? `${icon('pause', 12)}Pause updates` : `${icon('play', 12)}Resume updates`}</button>
    `;
    const reopen = async () => {
      const updated = await endSession(id, 'reopen');
      if (!updated) return false;
      sessionState = { ...sessionState, status: updated.status, ended_reason: updated.ended_reason, ended_at: updated.ended_at };
      startFollowing();
      renderStatusControls();
      return true;
    };
    const endBtn = document.getElementById('endSessionBtn');
    if (endBtn) endBtn.onclick = async () => {
      endBtn.disabled = true;
      const updated = await endSession(id, 'end');
      if (!updated) { endBtn.disabled = false; return; }
      sessionState = { ...sessionState, status: updated.status, ended_reason: updated.ended_reason, ended_at: updated.ended_at };
      stopFollowing();
      showToast('Marked done', { actionLabel: 'Undo', onAction: reopen });
    };
    const reopenBtn = document.getElementById('reopenSessionBtn');
    if (reopenBtn) reopenBtn.onclick = async () => {
      reopenBtn.disabled = true;
      if (!(await reopen())) reopenBtn.disabled = false;
    };
    const followBtn = document.getElementById('followToggleBtn');
    if (followBtn) followBtn.onclick = () => (following ? stopFollowing() : startFollowing());
  }

  // Sessions that were explicitly ended (by the user or their source) open
  // without a live stream; everything else follows as before.
  if (s.status === 'ended' && (s.ended_reason === 'manual' || s.ended_reason === 'source')) renderStatusControls();
  else startFollowing();

  const sseScrollHandler = () => {
    if (window.scrollY < 100) {
      const ind = document.getElementById('newEventsIndicator');
      if (ind) { ind.remove(); pendingNewCount = 0; }
    }
  };
  window.addEventListener('scroll', sseScrollHandler, { passive: true });

  window._sseCleanup = () => {
    if (onScroll) { window.removeEventListener('scroll', onScroll); onScroll = null; }
    following = false;
    if (eventSource) eventSource.close();
    if (pollInterval) clearInterval(pollInterval);
    window.removeEventListener('scroll', sseScrollHandler);
    const ind = document.getElementById('newEventsIndicator');
    if (ind) ind.remove();
  };

  // Load insights panel
  api(`/insights/session/${id}`).then(insights => {
    const panel = document.getElementById('sessionInsightsPanel');
    if (panel) panel.outerHTML = renderInsightsPanel(insights._error ? null : insights);
  });
}

async function viewTimeline(date) {
  clearJumpUi();
  if (!date) {
    const now = new Date();
    date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }
  window._lastView = 'timeline';
  window._timelineState = { date, limit: 100, offset: 0, hasMore: true, loading: false, seenEventIds: new Set() };

  content.innerHTML = `<header class="page-head"><h1 class="page-title">Timeline</h1>
    <input type="date" class="date-input" id="dateInput" value="${date}" aria-label="Day"></header>
    <div id="timelineContent">${skeletonRows(8, 'event')}</div>
    <div id="timelineLoadMore" class="loading-more" style="display:none">Loading more…</div>`;
  transitionView();

  const el = $('#timelineContent');
  const state = window._timelineState;

  async function loadTimelinePage(append = false) {
    if (state.loading || (!state.hasMore && append)) return;
    state.loading = true;
    if (append) $('#timelineLoadMore').style.display = 'block';

    const data = await api(`/timeline?date=${state.date}&limit=${state.limit}&offset=${state.offset}`);
    state.loading = false;
    $('#timelineLoadMore').style.display = 'none';

    if (data._error) {
      if (!append) el.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
      return;
    }

    state.hasMore = !!data.hasMore;
    state.offset += (data.events || []).length;
    (data.events || []).forEach(ev => state.seenEventIds.add(ev.id));

    if (!append) {
      if (!data.events.length) {
        el.innerHTML = `<div class="timeline-events-wrap" id="timelineWrap"><div class="empty" id="timelineEmpty"><h2>No activity</h2><p>Nothing recorded on this day</p></div></div>`;
        return;
      }
      el.innerHTML = `<div class="timeline-events-wrap" id="timelineWrap">${renderTimelineEvents(data.events)}</div>`;
      state.lastSessionId = data.events[data.events.length - 1].session_id;
      return;
    }

    const wrap = $('#timelineWrap');
    if (wrap) {
      wrap.insertAdjacentHTML('beforeend', renderTimelineEvents(data.events, state.lastSessionId));
      if (data.events.length) state.lastSessionId = data.events[data.events.length - 1].session_id;
    }
  }

  await loadTimelinePage(false);

  if (window._timelineScrollHandler) window.removeEventListener('scroll', window._timelineScrollHandler);
  window._timelineScrollHandler = () => {
    const st = window._timelineState;
    if (!st || st.loading || !st.hasMore) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 300;
    if (nearBottom) loadTimelinePage(true);
  };
  window.addEventListener('scroll', window._timelineScrollHandler, { passive: true });

  // Live updates via SSE (only for today)
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  if (window._timelineSse) { window._timelineSse.close(); window._timelineSse = null; }
  if (date === todayStr) {
    const sse = new EventSource(`/api/timeline/stream?after=${encodeURIComponent(new Date().toISOString())}&afterId=`);
    window._timelineSse = sse;
    sse.onmessage = (evt) => {
      try {
        const rows = JSON.parse(evt.data);
        if (!rows.length) return;

        const fresh = rows.filter(r => !state.seenEventIds.has(r.id));
        if (!fresh.length) return;
        fresh.forEach(r => state.seenEventIds.add(r.id));

        let wrap = $('#timelineWrap');
        if (!wrap) {
          el.innerHTML = `<div class="timeline-events-wrap" id="timelineWrap"></div>`;
          wrap = $('#timelineWrap');
        }

        const empty = $('#timelineEmpty');
        if (empty) empty.remove();

        const html = renderTimelineEvents(fresh);
        wrap.insertAdjacentHTML('afterbegin', html);
        state.offset += fresh.length;

        // Flash new events
        fresh.forEach(r => {
          const rowEl = wrap.querySelector(`[data-event-id="${r.id}"]`);
          if (rowEl) { rowEl.classList.add('event-highlight'); setTimeout(() => rowEl.classList.remove('event-highlight'), 2000); }
        });
      } catch {}
    };
  }

  $('#dateInput').addEventListener('change', e => {
    if (window._timelineSse) { window._timelineSse.close(); window._timelineSse = null; }
    viewTimeline(e.target.value);
  });
}

async function viewOverview() {
  clearJumpUi();
  const restored = restoreView('overview');
  if (!restored) {
    content.innerHTML = `<h1 class="page-title">Overview</h1>${skeletonRows(4, 'stats')}${skeletonRows(4, 'session')}`;
    transitionView();
  }
  const [data, sessionsRes] = await Promise.all([api('/stats'), api('/sessions?limit=30&roots=1')]);
  if (!stillOn('overview')) return;
  if (data._error || sessionsRes._error) {
    if (restored) return;
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  const sessions = sessionsRes.sessions || [];
  const activeNow = sessions
    .filter(s => s.status === 'live' || s.live_descendant_count > 0)
    .slice(0, 4);
  const activeIds = new Set(activeNow.map(s => s.id));
  const recentSessions = sessions.filter(s => !activeIds.has(s.id)).slice(0, 6);
  const uniqueTools = new Set((data.tools || []).filter(t => t).map(t => fmtToolGroup(t)));

  let html = `<h1 class="page-title">Overview</h1>
    ${renderMetrics([
      { label: 'Sessions', value: fmtCompact(data.sessions), title: data.sessions.toLocaleString() },
      { label: 'Messages', value: fmtCompact(data.messages), title: data.messages.toLocaleString() },
      { label: 'Tool calls', value: fmtCompact(data.toolCalls), title: data.toolCalls.toLocaleString() },
      { label: 'Tokens', value: fmtCompact(data.totalTokens || 0), title: (data.totalTokens || 0).toLocaleString() },
    ])}

    <h2 class="section-label">Active now${activeNow.length ? ` <span class="count">${activeNow.length}</span>` : ''}</h2>
    ${activeNow.length ? renderSessionList(activeNow, { tree: true }) : `<p class="quiet-note">Nothing has written in the last 15 minutes.</p>`}

    <h2 class="section-label">Recent</h2>
    ${renderSessionList(recentSessions, { tree: true })}
  `;

  if (restored) renderInPlace(html);
  else { content.innerHTML = html; transitionView(); }
}

async function viewStats() {
  clearJumpUi();
  content.innerHTML = `<h1 class="page-title">Settings</h1>${skeletonRows(4, 'session')}`;
  transitionView();
  const data = await api('/stats');
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  const uniqueTools = new Set((data.tools||[]).filter(t=>t).map(t=>fmtToolGroup(t)));
  const themeMode = lsGet(THEME_MODE_KEY) || 'light';
  const darkVariant = lsGet(THEME_DARK_VARIANT_KEY) || 'default';

  const dirs = data.sessionDirs || [];
  const isClaude = d => d.agent === 'claude-code' || /^claude-/.test(d.agent || '');
  const claudeDirs = dirs.filter(isClaude);
  const pathRows = [];
  if (claudeDirs.length) pathRows.push(['~/.claude/projects/*', `claude-code, ${claudeDirs.length} workspace${claudeDirs.length === 1 ? '' : 's'}`]);
  for (const d of dirs.filter(d => !isClaude(d))) {
    pathRows.push([(d.path || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~'), normalizeAgentLabel(d.agent)]);
  }
  const tools = [...uniqueTools].sort((a, b) => a.localeCompare(b));

  let html = `<div class="settings-page">
    <h1 class="page-title">Settings</h1>

    <h2 class="section-label">Appearance</h2>
    <div class="form-row">
      <label>Theme <select id="themeModeSelect" class="select">
        <option value="system" ${themeMode==='system'?'selected':''}>System</option>
        <option value="light" ${themeMode==='light'?'selected':''}>Light</option>
        <option value="dark" ${themeMode==='dark'?'selected':''}>Dark</option>
      </select></label>
      <label>Dark variant <select id="darkVariantSelect" class="select">
        <option value="default" ${darkVariant==='default'?'selected':''}>Default</option>
        <option value="trueblack" ${darkVariant==='trueblack'?'selected':''}>True black</option>
      </select></label>
    </div>

    <h2 class="section-label">Database</h2>
    <dl class="facts">
      <dt>Storage mode</dt><dd>${escHtml(data.storageMode || 'reference')}</dd>
      <dt>Size</dt><dd id="dbSizeValue">${escHtml(data.dbSize?.display || 'N/A')}</dd>
      <dt>Date range</dt><dd>${fmtDate(data.dateRange?.earliest)} to ${fmtDate(data.dateRange?.latest)}</dd>
      <dt>Indexed sessions</dt><dd id="sysSessions">\u2026</dd>
    </dl>
    <div class="settings-maintenance">
      <button class="btn" id="optimizeDbBtn">Optimize database</button>
      <span id="optimizeDbStatus" class="settings-maintenance-status" role="status"></span>
    </div>
    <p class="settings-help">Reclaims unused space and merges pending writes. Safe to run anytime; it doesn't delete data.</p>

    ${pathRows.length ? `<h2 class="section-label">Session sources</h2>
    <dl class="facts facts-paths">${pathRows.map(([p, a]) => `<dt class="mono">${escHtml(p)}</dt><dd>${escHtml(a)}</dd>`).join('')}</dl>` : ''}

    <h2 class="section-label">Server</h2>
    <dl class="facts">
      <dt>Version</dt><dd id="sysVersion">\u2026</dd>
      <dt>Uptime</dt><dd id="sysUptime">\u2026</dd>
      <dt>Node.js</dt><dd id="sysNode">\u2026</dd>
      ${data.agents && data.agents.length ? `<dt>Agents</dt><dd>${data.agents.map(escHtml).join(', ')}</dd>` : ''}
    </dl>

    <details class="tools-used">
      <summary class="section-label">Tools seen <span class="count">${tools.length}</span></summary>
      <ul class="tools-grid">${tools.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul>
    </details>
  </div>`;

  content.innerHTML = html;
  transitionView();

  const themeModeSelect = $('#themeModeSelect');
  const darkVariantSelect = $('#darkVariantSelect');
  if (themeModeSelect) {
    themeModeSelect.addEventListener('change', () => {
      lsSet(THEME_MODE_KEY, themeModeSelect.value);
      window._themeMode = themeModeSelect.value;
      applyThemeFromPrefs();
    });
  }
  if (darkVariantSelect) {
    darkVariantSelect.addEventListener('change', () => {
      lsSet(THEME_DARK_VARIANT_KEY, darkVariantSelect.value);
      window._themeDarkVariant = darkVariantSelect.value;
      applyThemeFromPrefs();
    });
  }

  const optimizeBtn = $('#optimizeDbBtn');
  const optimizeStatus = $('#optimizeDbStatus');
  if (optimizeBtn) {
    optimizeBtn.addEventListener('click', async () => {
      optimizeBtn.disabled = true;
      optimizeStatus.textContent = 'Optimizing…';
      const result = await api('/maintenance', { method: 'POST' });
      if (result._error || !result.ok) {
        optimizeStatus.textContent = `Failed: ${result.error || 'Unknown error'}`;
      } else {
        optimizeStatus.textContent = `${result.sizeBefore?.display || 'N/A'} → ${result.sizeAfter?.display || 'N/A'}`;
        const dbSizeValue = $('#dbSizeValue');
        if (dbSizeValue) dbSizeValue.textContent = result.sizeAfter?.display || 'N/A';
      }
      optimizeBtn.disabled = false;
    });
  }

  // Fetch system info
  api('/health').then(h => {
    if (h._error) return;
    const fmtUptime = (s) => {
      const d = Math.floor(s / 86400);
      const hr = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d > 0) return `${d}d ${hr}h`;
      if (hr > 0) return `${hr}h ${m}m`;
      return `${m}m`;
    };
    const fmtBytes = (b) => {
      if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
      return `${(b / 1024).toFixed(1)} KB`;
    };
    const v = $('#sysVersion');
    const u = $('#sysUptime');
    const sc = $('#sysSessions');
    const n = $('#sysNode');
    if (v) v.textContent = `v${h.version}`;
    if (u) u.textContent = fmtUptime(h.uptime);
    if (sc) sc.textContent = String(h.sessions);
    if (n) n.textContent = h.node;
  });
}

async function viewFiles() {
  clearJumpUi();
  window._lastView = 'files';
  content.innerHTML = `<h1 class="page-title">Files</h1>${skeletonRows(6, 'file')}`;
  transitionView();
  const data = await api('/files?limit=500');
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }
  window._allFiles = data.files || [];
  window._fileSort = window._fileSort || 'touches';
  window._fileFilter = window._fileFilter || '';
  window._fileSearch = window._fileSearch || '';
  window._fileGrouped = window._fileGrouped !== false;
  renderFiles();
}

function getFileExt(p) {
  const m = p.match(/\.([a-zA-Z0-9]+)$/);
  return m ? '.' + m[1] : 'other';
}

function getFileDir(p) {
  let rel = p.replace(/^\/home\/[^/]+\//, '~/').replace(/^\/Users\/[^/]+\//, '~/');
  if (rel.startsWith('~/')) rel = rel.slice(2);
  const parts = rel.split('/');
  if (parts.length <= 2) return parts[0] || '/';
  return parts.slice(0, 2).join('/');
}

function renderFiles() {
  let files = [...window._allFiles];

  const q = window._fileSearch.toLowerCase();
  if (q) files = files.filter(f => f.file_path.toLowerCase().includes(q));

  if (window._fileFilter) {
    files = files.filter(f => getFileExt(f.file_path) === window._fileFilter);
  }

  const sort = window._fileSort;
  if (sort === 'touches') files.sort((a, b) => b.touch_count - a.touch_count);
  else if (sort === 'recent') files.sort((a, b) => new Date(b.last_touched) - new Date(a.last_touched));
  else if (sort === 'name') files.sort((a, b) => a.file_path.localeCompare(b.file_path));
  else if (sort === 'sessions') files.sort((a, b) => b.session_count - a.session_count);

  const exts = [...new Set(window._allFiles.map(f => getFileExt(f.file_path)))].sort();

  const sortBtn = (val, label) => `<button class="filter-chip${sort === val ? ' active' : ''}" data-sort="${val}" aria-pressed="${sort === val}">${label}</button>`;
  let html = `<header class="page-head"><h1 class="page-title">Files</h1><span class="page-count">${files.length.toLocaleString()} of ${window._allFiles.length.toLocaleString()}</span></header>
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="fileSearchInput" placeholder="Filter by filename or path\u2026" value="${escHtml(window._fileSearch)}">
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Sort">${sortBtn('touches', 'Most touched')}${sortBtn('recent', 'Recent')}${sortBtn('sessions', 'Most sessions')}${sortBtn('name', 'A\u2013Z')}</div>
      <select id="extSelect" class="select" aria-label="File type">
        <option value="">All types</option>
        ${exts.map(e => `<option value="${escHtml(e)}"${window._fileFilter === e ? ' selected' : ''}>${escHtml(e)}</option>`).join('')}
      </select>
      <button class="btn${window._fileGrouped ? ' active' : ''}" id="groupToggle" aria-pressed="${window._fileGrouped}">Group by directory</button>
    </div>
    <div id="filesList"></div>`;

  content.innerHTML = html;
  transitionView();

  const listEl = $('#filesList');

  if (window._fileGrouped && !q) {
    const groups = {};
    files.forEach(f => {
      const dir = getFileDir(f.file_path);
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f);
    });

    const groupMetric = (files) => {
      if (sort === 'touches') return files.reduce((s, f) => s + f.touch_count, 0);
      if (sort === 'sessions') return files.reduce((s, f) => s + f.session_count, 0);
      if (sort === 'recent') return Math.max(...files.map(f => new Date(f.last_touched).getTime()));
      return 0;
    };
    const sortedGroups = Object.entries(groups).sort((a, b) => {
      if (sort === 'name') return a[0].localeCompare(b[0]);
      return groupMetric(b[1]) - groupMetric(a[1]);
    });

    listEl.className = 'file-list';
    listEl.innerHTML = sortedGroups.map(([dir, dirFiles]) => {
      const totalTouches = dirFiles.reduce((s, f) => s + f.touch_count, 0);
      const totalSessions = dirFiles.reduce((s, f) => s + f.session_count, 0);
      const groupStat = sort === 'sessions' ? `${totalSessions} sessions` : `${totalTouches} touches`;
      return `
        <div class="file-group">
          <button class="file-group-header" data-dir="${escHtml(dir)}" aria-expanded="false">
            <span class="file-group-name">~/${escHtml(dir)}</span>
            <span class="file-group-stat">${dirFiles.length} files</span>
            <span class="file-group-stat">${groupStat}</span>
          </button>
          <div class="file-group-items" hidden>
            ${dirFiles.map(f => renderFileItem(f)).join('')}
          </div>
        </div>`;
    }).join('');

    $$('.file-group-header').forEach(h => {
      h.addEventListener('click', () => {
        const items = h.nextElementSibling;
        const open = items.hasAttribute('hidden');
        items.toggleAttribute('hidden', !open);
        h.setAttribute('aria-expanded', String(open));
      });
    });
  } else {
    listEl.className = 'file-list';
    listEl.innerHTML = files.map(f => renderFileItem(f)).join('');
  }

  let debounce;
  const searchInput = $('#fileSearchInput');
  searchInput.addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { window._fileSearch = e.target.value; renderFiles(); }, 200);
  });

  const cursorPos = window._fileCursorPos || 0;
  searchInput.setSelectionRange(cursorPos, cursorPos);
  if (window._fileSearch) searchInput.focus();

  $$('[data-sort]').forEach(chip => {
    chip.onclick = () => { window._fileSort = chip.dataset.sort; renderFiles(); };
  });

  $('#extSelect').addEventListener('change', e => { window._fileFilter = e.target.value; renderFiles(); });

  $('#groupToggle').addEventListener('click', () => { window._fileGrouped = !window._fileGrouped; renderFiles(); });

  $$('.file-item').forEach(item => {
    item.addEventListener('click', () => viewFileDetail(item.dataset.path));
    item.addEventListener('keydown', e => { if (e.key === 'Enter') viewFileDetail(item.dataset.path); });
  });

  searchInput.addEventListener('keyup', () => { window._fileCursorPos = searchInput.selectionStart; });
}

function renderFileItem(f) {
  const fname = f.file_path.split('/').pop();
  const dir = f.file_path.split('/').slice(0, -1).join('/').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
  return `
    <div class="file-item" data-path="${escHtml(f.file_path)}" role="link" tabindex="0">
      <div class="file-path"><span class="file-name">${escHtml(fname)}</span><span class="file-dir">${escHtml(dir)}/</span></div>
      <span class="file-stat" title="${f.touch_count} touches">${fmtCompact(f.touch_count)}</span>
      <span class="file-stat" title="${f.session_count} sessions">${fmtCompact(f.session_count)} sess</span>
      <span class="file-ops">${escHtml(f.operations)}</span>
      <time class="file-when">${fmtTime(f.last_touched)}</time>
    </div>
  `;
}

async function viewFileDetail(filePath) {
  clearJumpUi();
  content.innerHTML = '<div class="loading">Loading</div>';
  const data = await api(`/files/sessions?path=${encodeURIComponent(filePath)}`);
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let html = `
    <div class="back-btn" id="backBtn">\u2190 Back</div>
    <h1 class="page-title file-title">${escHtml(filePath.split('/').pop())}</h1>
    <p class="page-sub mono">${escHtml(filePath)}</p>
    <h2 class="section-label">${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'} touched this file</h2>
  `;

  html += renderSessionList(data.sessions);
  content.innerHTML = html;
  transitionView();

  $('#backBtn').addEventListener('click', () => viewFiles());
  $$('.session-item').forEach(item => {
    item.addEventListener('click', () => viewSession(item.dataset.id));
  });
}

// --- Insights helpers ---
const SIGNAL_LABELS = {
  tool_retry_loop: 'Repeated Actions',
  session_bail: 'No Output Produced',
  high_error_rate: 'Frequent Errors',
  long_prompt_short_session: 'Vague Instructions',
  no_completion: 'Incomplete Session'
};

const SIGNAL_DESCRIPTIONS = {
  tool_retry_loop: 'The agent called the same tool many times in a row, suggesting it was stuck in a retry loop',
  session_bail: 'The agent ran many actions but never wrote or edited any files',
  high_error_rate: 'More than 30% of tool calls returned errors',
  long_prompt_short_session: 'A very short prompt led to a long session, suggesting the agent lacked sufficient context',
  no_completion: 'The session ended mid-action instead of finishing with a response'
};

const SIGNAL_COLORS = {
  tool_retry_loop: 'amber',
  high_error_rate: 'red',
  no_completion: 'purple',
  session_bail: 'teal',
  long_prompt_short_session: 'accent'
};

function renderSignalTag(sig, count = 1) {
  const label = SIGNAL_LABELS[sig.type] || sig.type;
  const color = SIGNAL_COLORS[sig.type] || 'muted';
  const desc = SIGNAL_DESCRIPTIONS[sig.type] || '';
  return `<span class="signal-tag signal-${color}"${desc ? ` title="${escHtml(desc)}"` : ''}>${escHtml(label)}${count > 1 ? `<span class="signal-count"> \u00d7${count}</span>` : ''}</span>`;
}

// One entry per signal type with a count, most frequent first.
function renderSignalSummary(signals) {
  const counts = new Map();
  for (const sig of signals || []) counts.set(sig.type, (counts.get(sig.type) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, n]) => renderSignalTag({ type }, n)).join('<span class="sep" aria-hidden="true">, </span>');
}

function renderInsightsPanel(insights) {
  if (!insights || !insights.signals || !insights.signals.length) {
    return `<section class="insights-panel insights-clean"><h2 class="section-label">Health</h2><p class="quiet-note">No issues detected.</p></section>`;
  }
  return `<section class="insights-panel">
    <h2 class="section-label">Health <span class="count">reliability ${100 - insights.confusion_score}/100</span></h2>
    <ul class="insights-signals">
      ${insights.signals.map(sig => {
        let detail = '';
        if (sig.type === 'tool_retry_loop') detail = `${escHtml(sig.tool)} called ${sig.count}\u00d7 in a row`;
        else if (sig.type === 'session_bail') detail = `${sig.tool_calls} tool calls with no file writes`;
        else if (sig.type === 'high_error_rate') detail = `${sig.rate}% error rate (${sig.error_count}/${sig.total})`;
        else if (sig.type === 'long_prompt_short_session') detail = `${sig.prompt_words}-word prompt, ${sig.tool_calls} tool calls`;
        else if (sig.type === 'no_completion') detail = `Ended on ${escHtml(sig.last_event_type)}${sig.last_tool ? ': ' + escHtml(sig.last_tool) : ''}`;
        return `<li class="insight-callout">${renderSignalTag(sig)}<span class="insight-detail">${detail}</span></li>`;
      }).join('')}
    </ul>
  </section>`;
}

async function viewInsights() {
  clearJumpUi();
  window._lastView = 'insights';
  content.innerHTML = `<h1 class="page-title">Insights</h1>${skeletonRows(2, 'stats')}${skeletonRows(5, 'session')}`;
  transitionView();

  const data = await api('/insights');
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  // Signal breakdown data — sorted by count descending
  const signalTypes = Object.keys(SIGNAL_LABELS).sort((a, b) => (data.signal_counts[b] || 0) - (data.signal_counts[a] || 0));
  const maxSignalCount = Math.max(1, ...signalTypes.map(t => data.signal_counts[t] || 0));

  // Issue rate
  const issueRate = data.total_sessions > 0 ? Math.round((data.flagged_count / data.total_sessions) * 100) : 0;

  // Reliability score (inverted struggle score)
  const reliabilityScore = 100 - (data.avg_confusion_score || 0);

  let html = `<h1 class="page-title">Insights</h1>
    ${renderMetrics([
      { label: 'Sessions with an issue', value: `${issueRate}%`, note: `${data.flagged_count.toLocaleString()} of ${data.total_sessions.toLocaleString()}` },
      { label: 'Reliability', value: `${reliabilityScore}/100`, note: 'Average; higher means cleaner runs' },
    ])}

    <h2 class="section-label">Issue types</h2>
    <div class="signal-chart">
      ${signalTypes.map(type => {
        const count = data.signal_counts[type] || 0;
        const pct = Math.round((count / maxSignalCount) * 100);
        const color = SIGNAL_COLORS[type] || 'muted';
        const desc = SIGNAL_DESCRIPTIONS[type] || '';
        const barColor = color === 'muted' ? 'var(--text-tertiary)' : `var(--${color})`;
        return `<div class="signal-lollipop-row${desc ? ' signal-lollipop-expandable' : ''}" data-desc="${escHtml(desc)}">
          <div class="signal-lollipop-main">
            <span class="signal-bar-label">${SIGNAL_LABELS[type]}</span>
            <div class="signal-lollipop-track">
              <svg width="100%" height="20" class="signal-lollipop-svg">
                <line x1="0" y1="10" x2="${pct}%" y2="10" stroke="${barColor}" stroke-width="2"/>
                <circle cx="${pct}%" cy="10" r="5" fill="${barColor}"/>
              </svg>
            </div>
            <span class="signal-bar-count">${count}</span>
          </div>
          ${desc ? `<div class="signal-lollipop-desc">${escHtml(desc)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>

    <h2 class="section-label">Sessions with issues <span class="count">${data.flagged_count.toLocaleString()}</span></h2>
    <div id="insightsList" class="session-list insight-list">
      ${data.top_flagged.length ? [...data.top_flagged].sort((a, b) => {
        const aRate = new Set((a.signals||[]).map(s=>s.type)).size;
        const bRate = new Set((b.signals||[]).map(s=>s.type)).size;
        return bRate - aRate || b.confusion_score - a.confusion_score;
      }).map(s => {
        const summary = cleanSessionSummary(s.summary, '');
        return `<div class="session-item insight-row" data-id="${escHtml(s.session_id)}" role="link" tabindex="0">
          <div class="si-main">
            <div class="si-title"><span class="si-headline">${escHtml(truncate(summary, 160))}</span></div>
            <div class="si-meta">${renderSignalSummary(s.signals)}</div>
          </div>
          <div class="si-when"><span>${fmtTime(s.start_time)}</span><span class="si-dur">${escHtml(normalizeAgentLabel(s.agent || ''))}</span></div>
          <div class="si-counts" title="Reliability score: higher means fewer errors"><span>${100 - s.confusion_score}<span class="unit">/100</span></span><span>reliability</span></div>
          <div class="si-action"></div>
        </div>`;
      }).join('') : '<div class="empty"><p>No flagged sessions found</p></div>'}
    </div>
  `;

  content.innerHTML = html;
  transitionView();

  $$('.session-item', content).forEach(item => {
    item.addEventListener('click', () => viewSession(item.dataset.id));
  });

  $$('.signal-lollipop-expandable', content).forEach(row => {
    row.addEventListener('click', () => {
      row.classList.toggle('signal-lollipop-open');
    });
  });
}

// --- Navigation ---
window._searchType = '';
window._searchRole = '';
window._lastView = 'overview';

$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
    if (window._timelineScrollHandler) { window.removeEventListener('scroll', window._timelineScrollHandler); window._timelineScrollHandler = null; }
    if (window._timelineSse) { window._timelineSse.close(); window._timelineSse = null; }
    const view = item.dataset.view;
    window._lastView = view;
    updateNavActive(view);
    setHash(view);
    if (view === 'overview') viewOverview();
    else if (view === 'sessions') viewSessions();
    else if (view === 'files') viewFiles();
    else if (view === 'timeline') viewTimeline();
    else if (view === 'insights') viewInsights();
    else if (view === 'stats') viewStats();
  });
});

// --- Command Palette (Cmd+K) ---
window._cmdk = { open: false, index: 0, items: [], scrollY: 0 };

function closeCmdk() {
  const el = $('#cmdkOverlay');
  if (el) el.remove();

  document.documentElement.classList.remove('cmdk-open');
  document.body.classList.remove('cmdk-open');

  window._cmdk.open = false;
}

function execCmdkItem(i) {
  const item = window._cmdk.items[i];
  if (!item) return;
  closeCmdk();
  item.action();
}

function renderCmdkList() {
  const list = $('#cmdkList');
  if (!list) return;
  const { items, index } = window._cmdk;
  if (!items.length) {
    list.innerHTML = '<div class="cmdk-empty"><h4>No results</h4>Try a different search term</div>';
    return;
  }

  let html = '';
  let lastGroup = '';
  items.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      html += `<div class="cmdk-group-label">${escHtml(lastGroup)}</div>`;
    }
    html += `<button type="button" class="cmdk-item ${i === index ? 'active' : ''}" data-i="${i}">
      <div class="cmdk-item-body">
        <div class="cmdk-item-title">${escHtml(item.title)}</div>
        ${item.sub ? `<div class="cmdk-item-sub">${escHtml(item.sub)}</div>` : ''}
      </div>
      ${item.meta ? `<span class="cmdk-item-meta">${escHtml(item.meta)}</span>` : ''}
    </button>`;
  });
  list.innerHTML = html;

  if (!list.dataset.bound) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.cmdk-item');
      if (!btn) return;
      e.preventDefault();
      const idx = Number(btn.dataset.i || -1);
      if (idx >= 0) execCmdkItem(idx);
    });

    list.addEventListener('pointermove', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const btn = e.target.closest('.cmdk-item');
      if (!btn) return;
      const idx = Number(btn.dataset.i || -1);
      if (idx >= 0 && idx !== window._cmdk.index) {
        window._cmdk.index = idx;
        renderCmdkList();
      }
    });

    list.dataset.bound = '1';
  }

  // scroll active into view
  const active = list.querySelector('.cmdk-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

async function loadCmdkResults(query) {
  const list = $('#cmdkList');
  if (!list) return;
  const q = (query || '').trim();
  if (!q) { loadCmdkHome(); return; }

  list.innerHTML = '<div class="cmdk-loading">Searching\u2026</div>';

  const [searchRes, sessionsRes, filesRes] = await Promise.all([
    api(`/search?q=${encodeURIComponent(q)}&limit=6`),
    api('/sessions?limit=20'),
    api('/files?limit=20')
  ]);

  const items = [];

  (sessionsRes.sessions || [])
    .filter(s => cleanSessionSummary(s.summary, s.initial_prompt).toLowerCase().includes(q.toLowerCase()))
    .slice(0, 3)
    .forEach(s => items.push({
      group: 'Sessions',
      title: truncate(cleanSessionSummary(s.summary, s.initial_prompt), 64),
      sub: shortSessionId(s.id),
      meta: fmtTime(s.start_time),
      action: () => viewSession(s.id)
    }));

  (filesRes.files || [])
    .filter(f => f.file_path.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 2)
    .forEach(f => items.push({
      group: 'Files',
      title: f.file_path.split('/').pop(),
      sub: f.file_path,
      meta: `${f.touch_count} touches`,
      action: () => viewFileDetail(f.file_path)
    }));

  (searchRes.results || []).slice(0, 4).forEach(r => items.push({
    group: 'Search Results',
    title: truncate(r.content || r.tool_args || r.tool_result || '', 66),
    sub: shortSessionId(r.session_id),
    meta: fmtTime(r.timestamp),
    action: () => viewSession(r.session_id)
  }));

  window._cmdk.items = items;
  window._cmdk.index = 0;
  renderCmdkList();
}

async function loadCmdkHome() {
  const list = $('#cmdkList');
  if (!list) return;
  list.innerHTML = '<div class="cmdk-loading">Loading\u2026</div>';

  const items = [
    { group: 'Go to', title: 'Sessions', sub: 'Browse all sessions', action: () => { setHash('sessions'); handleRoute(); } },
    { group: 'Go to', title: 'Timeline', sub: 'Today and historical events', action: () => { setHash('timeline'); handleRoute(); } },
    { group: 'Go to', title: 'Overview', sub: 'Dashboard summary', action: () => { setHash('overview'); handleRoute(); } },
    { group: 'Go to', title: 'Files', sub: 'Touched files explorer', action: () => { setHash('files'); handleRoute(); } },
    { group: 'Go to', title: 'Settings', sub: 'Configuration and maintenance', action: () => { setHash('stats'); handleRoute(); } },
  ];

  const sessionsRes = await api('/sessions?limit=20');

  const sessionList = sessionsRes.sessions || [];
  const sessionMap = new Map(sessionList.map(s => [s.id, s]));

  const recentIds = window._recentSessionIds || [];
  const missingIds = recentIds.filter(id => !sessionMap.has(id));
  if (missingIds.length) {
    const fetched = await Promise.all(missingIds.map(id => api(`/sessions/${id}`)));
    fetched.forEach(r => {
      if (r && !r._error && r.session) sessionMap.set(r.session.id, r.session);
    });
  }

  recentIds.forEach(id => {
    const s = sessionMap.get(id);
    if (!s) return;
    items.push({
      group: 'Recently Opened',
      title: truncate(cleanSessionSummary(s.summary, s.initial_prompt), 64),
      sub: shortSessionId(s.id),
      meta: fmtTime(s.start_time),
      action: () => viewSession(s.id)
    });
  });

  sessionList.forEach(s => items.push({
    group: 'Recent Sessions',
    title: truncate(cleanSessionSummary(s.summary, s.initial_prompt), 64),
    sub: shortSessionId(s.id),
    meta: fmtTime(s.start_time),
    action: () => viewSession(s.id)
  }));

  window._cmdk.items = items;
  window._cmdk.index = 0;
  renderCmdkList();
}

function openCmdk() {
  if ($('#cmdkOverlay')) { $('#cmdkInput')?.focus(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'cmdk-overlay';
  overlay.id = 'cmdkOverlay';
  overlay.innerHTML = `<div class="cmdk-dialog" role="dialog" aria-modal="true">
    <div class="cmdk-input-wrap">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input id="cmdkInput" type="text" placeholder="Search sessions, files, or jump to a view" />
      <kbd>ESC</kbd>
    </div>
    <div class="cmdk-list" id="cmdkList"></div>
  </div>`;
  document.body.appendChild(overlay);
  window._cmdk.open = true;

  const input = $('#cmdkInput');
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  document.documentElement.classList.add('cmdk-open');
  document.body.classList.add('cmdk-open');

  if (isMobile) {
    // iOS keyboard requires focus in the same user gesture call stack.
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    input.setSelectionRange(input.value.length, input.value.length);
  } else {
    input.focus();
  }

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadCmdkResults(input.value), 150);
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) closeCmdk(); });

  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      window._cmdk.index = Math.min(window._cmdk.index + 1, window._cmdk.items.length - 1);
      renderCmdkList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      window._cmdk.index = Math.max(window._cmdk.index - 1, 0);
      renderCmdkList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execCmdkItem(window._cmdk.index);
    }
  });

  loadCmdkHome();
}

initTheme();
document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
document.getElementById('theme-toggle-mobile')?.addEventListener('click', toggleTheme);
document.getElementById('mobile-search-btn')?.addEventListener('click', () => openCmdk());
document.getElementById('settings-btn')?.addEventListener('click', () => { window._lastView = 'stats'; updateNavActive('stats'); setHash('stats'); viewStats(); });
document.getElementById('settings-btn-mobile')?.addEventListener('click', () => { window._lastView = 'stats'; updateNavActive('stats'); setHash('stats'); viewStats(); });
document.getElementById('cmdkBtn')?.addEventListener('click', () => openCmdk());




document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (window._cmdk.open) closeCmdk();
    else openCmdk();
    return;
  }
  if (e.key === 'Escape' && window._cmdk.open) { e.preventDefault(); closeCmdk(); return; }
  handleListKeys(e);
});

// Touch press feedback. Mobile browsers delay or skip :active on touch so
// rows don't flash while scrolling, which leaves taps feeling dead. Show the
// pressed state 40ms after the finger lands, drop it if the finger moves
// (a scroll), and make a quick tap flash briefly so it always registers.
(function initTouchPress() {
  const PRESSABLE = '.toast-action, .row-btn, .btn, .filter-chip, .session-id-copy, .subagent-toggle, .subagent-heading, .back-btn, .session-parent-link, .tool-detail > summary, .session-item, .subagent-row, .file-item, .file-group-header, .result-item, .tl-session, .nav-item, .cmdk-item';
  let el = null, timer = null, x0 = 0, y0 = 0;
  const release = (flash) => {
    clearTimeout(timer);
    if (!el) return;
    const target = el;
    el = null;
    if (flash) {
      target.classList.add('is-pressed');
      setTimeout(() => target.classList.remove('is-pressed'), 140);
    } else {
      target.classList.remove('is-pressed');
    }
  };
  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const hit = e.target.closest && e.target.closest(PRESSABLE);
    if (!hit || hit.disabled) return;
    el = hit; x0 = e.clientX; y0 = e.clientY;
    timer = setTimeout(() => { if (el === hit) hit.classList.add('is-pressed'); }, 40);
  }, { passive: true });
  document.addEventListener('pointermove', e => {
    if (el && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) release(false);
  }, { passive: true });
  document.addEventListener('pointerup', () => release(true), { passive: true });
  document.addEventListener('pointercancel', () => release(false), { passive: true });
})();

// Keyboard-first navigation: J/K (or arrows once a row has focus) move
// between rows, Enter opens, Esc dismisses a toast or goes back, / searches.
const NAV_ROWS = '.session-item[data-id], .subagent-row, .result-item, .file-group-header, .file-item, .tl-session';
function handleListKeys(e) {
  if (window._cmdk && window._cmdk.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

  if (e.key === '/') { e.preventDefault(); openCmdk(); return; }
  if (e.key === 'Escape') {
    const toasts = document.querySelectorAll('.toast:not(.leaving)');
    if (toasts.length) { toasts[toasts.length - 1]._dismiss?.(); return; }
    const back = document.getElementById('backBtn');
    if (back) { e.preventDefault(); back.click(); }
    return;
  }

  const onRow = t && t.matches && t.matches(NAV_ROWS);
  const down = e.key === 'j' || (onRow && e.key === 'ArrowDown');
  const up = e.key === 'k' || (onRow && e.key === 'ArrowUp');
  if (!down && !up) return;
  const rows = $$(NAV_ROWS, content).filter(r => r.offsetParent !== null);
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.indexOf(document.activeElement);
  const next = i === -1 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
handleRoute();

// Swipe right from left edge to go back
(function initSwipeBack() {
  let startX = 0, startY = 0, swiping = false;
  const edgeWidth = 30;
  const threshold = 80;

  document.addEventListener('touchstart', e => {
    const x = e.touches[0].clientX;
    if (x <= edgeWidth) {
      startX = x;
      startY = e.touches[0].clientY;
      swiping = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!swiping) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dy > dx) { swiping = false; }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!swiping) return;
    swiping = false;
    const dx = e.changedTouches[0].clientX - startX;
    if (dx > threshold) {
      const backBtn = $('#backBtn');
      if (backBtn) backBtn.click();
    }
  });
})();

// Pull to refresh
(function initPTR() {
  let startY = 0;
  let pulling = false;
  let refreshing = false;
  const threshold = 80;

  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.id = 'ptr';
  indicator.textContent = '\u2193 Pull to refresh';
  document.body.appendChild(indicator);

  document.addEventListener('touchstart', e => {
    if (window.scrollY <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY;
    if (diff > 20 && window.scrollY <= 0) {
      indicator.classList.add('visible');
      indicator.textContent = diff > threshold ? '\u2191 Release to refresh' : '\u2193 Pull to refresh';
    } else {
      indicator.classList.remove('visible');
    }
  }, { passive: true });

  document.addEventListener('touchend', async e => {
    if (!pulling) return;
    pulling = false;
    if (refreshing) { indicator.classList.remove('visible'); return; }
    const diff = e.changedTouches[0].clientY - startY;
    if (diff > threshold && indicator.classList.contains('visible')) {
      refreshing = true;
      indicator.textContent = 'Refreshing\u2026';
      indicator.classList.add('refreshing');
      try {
        await api('/reindex', { method: 'POST' });
        // Just reindex data without re-rendering the view
        // The next manual navigation will pick up new data
      } catch(err) {}
      setTimeout(() => {
        indicator.classList.remove('visible', 'refreshing');
        refreshing = false;
      }, 500);
    } else {
      indicator.classList.remove('visible');
    }
  });
})();

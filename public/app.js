const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const content = $('#content');
const API = '/api';

async function api(path) {
  let res;
  try {
    res = await fetch(API + path);
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
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
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

function truncate(s, n = 200) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

function shortSessionId(id) {
  if (!id) return '';
  return id.length > 24 ? `${id.slice(0, 8)}\u2026${id.slice(-8)}` : id;
}

function badgeClass(type, role) {
  if (type === 'tool_call') return 'badge-tool_call';
  if (type === 'tool_result') return 'badge-tool_result';
  if (role === 'user') return 'badge-user';
  if (role === 'assistant') return 'badge-assistant';
  return 'badge-message';
}

function transitionView() {
  content.classList.remove('view-enter');
  void content.offsetWidth;
  content.classList.add('view-enter');
}

function renderEvent(ev) {
  const badge = `<span class="event-badge ${badgeClass(ev.type, ev.role)}">${ev.type === 'tool_call' ? 'tool' : ev.role || ev.type}</span>`;
  let body = '';

  if (ev.type === 'tool_call') {
    body = `<span class="tool-name">${escHtml(ev.tool_name)}</span>`;
    if (ev.tool_args) {
      try {
        const args = JSON.parse(ev.tool_args);
        body += `<div class="tool-args">${escHtml(JSON.stringify(args, null, 2))}</div>`;
      } catch {
        body += `<div class="tool-args">${escHtml(ev.tool_args)}</div>`;
      }
    }
  } else if (ev.type === 'tool_result') {
    body = `<span class="tool-name">\u2192 ${escHtml(ev.tool_name)}</span>`;
    if (ev.content) {
      body += `<div class="tool-args">${escHtml(truncate(ev.content, 500))}</div>`;
    }
  } else {
    body = `<div class="event-content">${escHtml(ev.content || '')}</div>`;
  }

  return `<div class="event-item" data-event-id="${ev.id}">
    <div class="event-time">${fmtTimeShort(ev.timestamp)}</div>
    ${badge}
    <div class="event-body">${body}</div>
  </div>`;
}

function renderTimelineEvent(ev) {
  const typeClass = ev.type === 'tool_call' || ev.type === 'tool_result' ? 'type-tool' :
                    ev.role === 'user' ? 'type-user' :
                    ev.role === 'assistant' ? 'type-assistant' : '';

  const badge = `<span class="event-badge ${badgeClass(ev.type, ev.role)}">${ev.type === 'tool_call' ? 'tool' : ev.role || ev.type}</span>`;
  let body = '';

  if (ev.type === 'tool_call') {
    body = `<span class="tool-name">${escHtml(ev.tool_name)}</span>`;
    if (ev.tool_args) {
      try {
        const args = JSON.parse(ev.tool_args);
        body += `<div class="tool-args">${escHtml(JSON.stringify(args, null, 2))}</div>`;
      } catch {
        body += `<div class="tool-args">${escHtml(ev.tool_args)}</div>`;
      }
    }
  } else if (ev.type === 'tool_result') {
    body = `<span class="tool-name">\u2192 ${escHtml(ev.tool_name)}</span>`;
    if (ev.content) {
      body += `<div class="tool-args">${escHtml(truncate(ev.content, 500))}</div>`;
    }
  } else {
    body = `<div class="event-content">${escHtml(ev.content || '')}</div>`;
  }

  return `<div class="timeline-event ${typeClass}" data-event-id="${ev.id}">
    <div class="event-time">${fmtTimeShort(ev.timestamp)}</div>
    ${badge}
    <div class="event-body">${body}</div>
  </div>`;
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

function renderProjectTags(s) {
  let projects = [];
  if (s.projects) {
    try { projects = JSON.parse(s.projects); } catch {}
  }
  return projects.map(p => `<span class="session-project">${escHtml(p)}</span>`).join('');
}

function renderModelTags(s) {
  let models = [];
  if (s.models) {
    try { models = JSON.parse(s.models); } catch {}
  }
  if (!models.length && s.model) models = [s.model];
  return models.map(m => `<span class="session-model">${escHtml(m)}</span>`).join('');
}

function renderSessionItem(s) {
  const duration = fmtDuration(s.start_time, s.end_time);
  const timeRange = `${fmtTime(s.start_time)} \u2192 ${s.end_time ? fmtTimeOnly(s.end_time) : 'now'}`;

  return `
    <div class="session-item" data-id="${s.id}">
      <div class="session-header">
        <span class="session-time">${timeRange} \u00b7 ${duration}</span>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${renderProjectTags(s)}
          ${s.agent && s.agent !== 'main' ? `<span class="session-agent">${escHtml(normalizeAgentLabel(s.agent))}</span>` : ''}
          ${s.session_type ? `<span class="session-type">${escHtml(s.session_type)}</span>` : ''}
          ${renderModelTags(s)}
        </span>
      </div>
      <div class="session-summary">${escHtml(truncate(s.summary || 'No summary', 120))}</div>
      <div class="session-meta">
        <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ${s.message_count}</span>
        <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> ${s.tool_count}</span>
      </div>
    </div>
  `;
}

// --- Views ---

async function viewSearch(query = '') {
  const typeFilter = window._searchType || '';
  const roleFilter = window._searchRole || '';

  let html = `<div class="page-title">Search</div>
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="searchInput" placeholder="Search messages, tool calls, files\u2026" value="${escHtml(query)}">
    </div>
    <div class="filters">
      <span class="filter-chip ${typeFilter===''?'active':''}" data-filter="type" data-val="">All</span>
      <span class="filter-chip ${typeFilter==='message'?'active':''}" data-filter="type" data-val="message">Messages</span>
      <span class="filter-chip ${typeFilter==='tool_call'?'active':''}" data-filter="type" data-val="tool_call">Tool Calls</span>
      <span class="filter-chip ${typeFilter==='tool_result'?'active':''}" data-filter="type" data-val="tool_result">Results</span>
      <span class="filter-chip ${roleFilter==='user'?'active':''}" data-filter="role" data-val="user">User</span>
      <span class="filter-chip ${roleFilter==='assistant'?'active':''}" data-filter="role" data-val="assistant">Assistant</span>
    </div>
    <div id="results"></div>`;

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
      if (f === 'type') window._searchType = v === window._searchType ? '' : v;
      if (f === 'role') window._searchRole = v === window._searchRole ? '' : v;
      viewSearch(input.value);
    });
  });

  if (query) doSearch(query);
  else showSearchHome();
}

async function showSearchHome() {
  const el = $('#results');
  el.innerHTML = '<div class="loading">Loading</div>';

  const stats = await api('/stats');
  const sessions = await api('/sessions?limit=5');
  if (stats._error || sessions._error) {
    el.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let suggestions = [];
  try { const r = await fetch('/api/suggestions'); const d = await r.json(); suggestions = d.suggestions || []; } catch(e) { suggestions = []; }

  let html = `
    <div class="search-stats" style="margin-top:8px">
      <div class="search-stat"><div class="num">${stats.sessions}</div><div class="lbl">Sessions</div></div>
      <div class="search-stat"><div class="num">${stats.messages.toLocaleString()}</div><div class="lbl">Messages</div></div>
      <div class="search-stat"><div class="num">${stats.toolCalls.toLocaleString()}</div><div class="lbl">Tool Calls</div></div>
      <div class="search-stat"><div class="num">${fmtTokens(stats.totalTokens || 0)}</div><div class="lbl">Tokens</div></div>
    </div>

    ${suggestions.length ? `<div class="section-label">Quick Search</div>
    <div class="filters" id="suggestions">
      ${suggestions.map(s => `<span class="suggestion-chip" data-q="${s}">${s}</span>`).join('')}
    </div>` : ''}

    <div class="section-label">Recent Sessions</div>
    ${sessions.sessions.map(renderSessionItem).join('')}
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
  if (!q.trim()) { el.innerHTML = '<div class="empty"><h2>Type to search</h2><p>Search across all sessions, messages, and tool calls</p></div>'; return; }

  el.innerHTML = '<div class="loading">Searching</div>';

  const type = window._searchType || '';
  const role = window._searchRole || '';
  let url = `/search?q=${encodeURIComponent(q)}&limit=100`;
  if (type) url += `&type=${type}`;
  if (role) url += `&role=${role}`;

  const data = await api(url);

  if (data._error || data.error) { el.innerHTML = `<div class="empty"><p>${escHtml(data.error || 'Server error')}</p></div>`; return; }
  if (!data.results.length) { el.innerHTML = '<div class="empty"><h2>No results</h2><p>Try a different search term or adjust filters</p></div>'; return; }

  let header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-md)">
    <span class="section-label" style="margin:0">${data.results.length} results</span>
    <div style="display:flex;gap:8px">
      <a class="export-btn" href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=md','search.md');return false">MD</a>
      <a class="export-btn" href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=json','search.json');return false">JSON</a>
    </div>
  </div>`;

  el.innerHTML = header + data.results.map(r => `
    <div class="result-item">
      <div class="result-meta">
        <span class="event-badge ${badgeClass(r.type, r.role)}">${r.type === 'tool_call' ? 'tool' : r.role || r.type}</span>
        <span class="session-time">${fmtTime(r.timestamp)}</span>
        ${r.tool_name ? `<span class="tool-name">${escHtml(r.tool_name)}</span>` : ''}
        <span class="session-link" data-session="${r.session_id}">view session \u2192</span>
      </div>
      <div class="result-content">${escHtml(truncate(r.content || r.tool_args || r.tool_result || '', 400))}</div>
    </div>
  `).join('');

  $$('.session-link', el).forEach(link => {
    link.addEventListener('click', () => {
      window._lastView = 'search';
      window._lastSearchQuery = q;
      viewSession(link.dataset.session);
    });
  });
}

async function viewSessions() {
  window._currentSessionId = null;
  content.innerHTML = '<div class="loading">Loading</div>';
  const data = await api('/sessions?limit=200');
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let html = `<div class="page-title">Sessions</div>`;
  html += data.sessions.map(renderSessionItem).join('');
  content.innerHTML = html;
  transitionView();

  $$('.session-item').forEach(item => {
    item.addEventListener('click', () => viewSession(item.dataset.id));
  });
}

async function viewSession(id) {
  if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
  window._currentSessionId = id;
  window.scrollTo(0, 0);
  const data = await api(`/sessions/${id}`);

  if (data._error || data.error) { content.innerHTML = `<div class="empty"><h2>${escHtml(data.error || 'Unable to load')}</h2></div>`; return; }

  const s = data.session;
  const cost = fmtCost(s.total_cost);
  let html = `
    <div class="back-btn" id="backBtn">\u2190 Back</div>
    <div class="page-title">Session</div>
    <div class="session-id-row">
      <span class="session-id-label">ID</span>
      <span class="session-id-value" title="${escHtml(id)}">${escHtml(id)}</span>
      <button class="session-id-copy" id="copySessionId" title="Copy session ID">\u29c9</button>
      <span class="session-id-copied" id="copyConfirm">Copied!</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      ${s.first_message_id ? `<button class="jump-to-start-btn" id="jumpToStartBtn" title="Jump to initial prompt">Initial Prompt</button>` : ''}
      ${data.hasArchive ? `<a class="export-btn" href="#" onclick="dlExport('/api/archive/export/${id}','session.jsonl');return false">JSONL</a>` : ''}
      <a class="export-btn" href="#" onclick="dlExport('/api/export/session/${id}?format=md','session.md');return false">MD</a>
      <a class="export-btn" href="#" onclick="dlExport('/api/export/session/${id}?format=json','session.json');return false">JSON</a>
    </div>
    <div class="session-detail-card">
      <div class="session-header" style="margin-bottom:12px">
        <span class="session-time">${fmtDate(s.start_time)} \u00b7 ${fmtTimeShort(s.start_time)} \u2013 ${fmtTimeShort(s.end_time)}</span>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${renderProjectTags(s)}
          ${s.agent && s.agent !== 'main' ? `<span class="session-agent">${escHtml(normalizeAgentLabel(s.agent))}</span>` : ''}
          ${s.session_type ? `<span class="session-type">${escHtml(s.session_type)}</span>` : ''}
          ${renderModelTags(s)}
        </span>
      </div>
      <div class="session-detail-grid">
        <span><span class="detail-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span> ${s.message_count} messages</span>
        <span><span class="detail-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span> ${s.tool_count} tools</span>
        ${s.output_tokens ? `<span><span class="detail-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/></svg></span> ${fmtTokens(s.output_tokens)} output</span><span><span class="detail-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span> ${fmtTokens(s.input_tokens + s.cache_read_tokens)} input</span>` : s.total_tokens ? `<span><span class="detail-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg></span> ${fmtTokens(s.total_tokens)} tokens</span><span></span>` : '<span></span><span></span>'}
      </div>
    </div>
    <div class="section-label">Events</div>
  `;

  const PAGE_SIZE = 50;
  const allEvents = data.events;
  let rendered = 0;

  function renderBatch() {
    const batch = allEvents.slice(rendered, rendered + PAGE_SIZE);
    if (!batch.length) return;
    const frag = document.createElement('div');
    frag.innerHTML = batch.map(renderEvent).join('');
    const container = document.getElementById('eventsContainer');
    if (container) {
      while (frag.firstChild) container.appendChild(frag.firstChild);
    }
    rendered += batch.length;

  }

  html += '<div id="eventsContainer">' + allEvents.slice(0, PAGE_SIZE).map(renderEvent).join('') + '</div>';
  rendered = Math.min(PAGE_SIZE, allEvents.length);
  content.innerHTML = html;
  transitionView();

  let onScroll = null;
  if (allEvents.length > PAGE_SIZE) {
    let loading = false;
    onScroll = () => {
      if (loading || rendered >= allEvents.length) return;
      const scrollBottom = window.innerHeight + window.scrollY;
      const threshold = document.body.offsetHeight - 300;
      if (scrollBottom >= threshold) {
        loading = true;
        renderBatch();
        loading = false;
        if (rendered >= allEvents.length) {
          window.removeEventListener('scroll', onScroll);
          onScroll = null;
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  $('#backBtn').addEventListener('click', () => {
    if (onScroll) { window.removeEventListener('scroll', onScroll); onScroll = null; }
    if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
    if (window._lastView === 'timeline') viewTimeline();
    else if (window._lastView === 'files') viewFiles();
    else if (window._lastView === 'search') viewSearch(window._lastSearchQuery || '');
    else viewSessions();
  });

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
    jumpBtn.addEventListener('click', () => {
      // Load all remaining events to find the first message
      while (rendered < allEvents.length) {
        renderBatch();
      }
      const firstMessage = document.querySelector(`[data-event-id="${s.first_message_id}"]`);
      if (firstMessage) {
        firstMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstMessage.classList.add('event-highlight');
        setTimeout(() => {
          firstMessage.classList.remove('event-highlight');
        }, 2000);
      }
    });
  }

    // --- Lightweight realtime updates (polling fallback first) ---
  const knownIds = new Set(allEvents.map(e => e.id));
  let pendingNewCount = 0;

  const applyIncomingEvents = (incoming) => {
    const container = document.getElementById('eventsContainer');
    if (!container || !incoming?.length) return;

    const fresh = incoming.filter(e => !knownIds.has(e.id));
    if (!fresh.length) return;
    fresh.forEach(e => knownIds.add(e.id));

    const isAtTop = window.scrollY < 100;
    for (const ev of fresh) {
      const div = document.createElement('div');
      div.innerHTML = renderEvent(ev);
      const el = div.firstElementChild;
      el.classList.add('event-highlight');
      container.insertBefore(el, container.firstChild);
      setTimeout(() => el.classList.remove('event-highlight'), 2000);
    }

    if (!isAtTop) {
      pendingNewCount += fresh.length;
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

  // Poll every 3s for new events using delta endpoint
  let lastSeenTs = allEvents.length ? allEvents[0].timestamp : new Date(0).toISOString();
  const pollNewEvents = async () => {
    try {
      const latest = await api(`/sessions/${id}/events?after=${encodeURIComponent(lastSeenTs)}&limit=50`);
      const incoming = latest.events || [];
      if (incoming.length) {
        lastSeenTs = incoming[incoming.length - 1].timestamp || lastSeenTs;
        applyIncomingEvents(incoming);
      }
    } catch (err) {
      // silent; next tick will retry
    }
  };

  const pollInterval = setInterval(pollNewEvents, 3000);

  const sseScrollHandler = () => {
    if (window.scrollY < 100) {
      const ind = document.getElementById('newEventsIndicator');
      if (ind) { ind.remove(); pendingNewCount = 0; }
    }
  };
  window.addEventListener('scroll', sseScrollHandler, { passive: true });

  window._sseCleanup = () => {
    clearInterval(pollInterval);
    window.removeEventListener('scroll', sseScrollHandler);
    const ind = document.getElementById('newEventsIndicator');
    if (ind) ind.remove();
  };
}

async function viewTimeline(date) {
  if (!date) {
    const now = new Date();
    date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }
  window._lastView = 'timeline';

  let html = `<div class="page-title">Timeline</div>
    <input type="date" class="date-input" id="dateInput" value="${date}">
    <div id="timelineContent"><div class="loading">Loading</div></div>`;
  content.innerHTML = html;
  transitionView();

  const data = await api(`/timeline?date=${date}`);
  if (data._error) {
    $('#timelineContent').innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }
  const el = $('#timelineContent');

  if (!data.events.length) {
    el.innerHTML = '<div class="empty"><h2>No activity</h2><p>Nothing recorded on this day</p></div>';
  } else {
    el.innerHTML = `<div class="timeline-events-wrap">
      <div class="timeline-line"></div>
      ${data.events.map(renderTimelineEvent).join('')}
    </div>`;
  }

  $('#dateInput').addEventListener('change', e => viewTimeline(e.target.value));
}

async function viewStats() {
  content.innerHTML = '<div class="loading">Loading</div>';
  const data = await api('/stats');
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let html = `<div class="page-title">Stats</div>
    <div class="stat-grid">
      <div class="stat-card accent-blue"><div class="label">Sessions</div><div class="value">${data.sessions}</div></div>
      <div class="stat-card accent-green"><div class="label">Messages</div><div class="value">${data.messages.toLocaleString()}</div></div>
      <div class="stat-card accent-amber"><div class="label">Tool Calls</div><div class="value">${data.toolCalls.toLocaleString()}</div></div>
      <div class="stat-card accent-purple"><div class="label">Unique Tools</div><div class="value">${data.uniqueTools}</div></div>
      <div class="stat-card accent-teal"><div class="label">Total Tokens</div><div class="value">${(data.totalTokens || 0).toLocaleString()}</div></div>
    </div>

    <div class="section-label">Configuration</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:var(--space-md);margin-bottom:var(--space-xl)">
      <div class="config-card"><div class="config-label">Storage Mode</div><div class="config-value">${escHtml(data.storageMode || 'reference')}</div></div>
      <div class="config-card"><div class="config-label">DB Size</div><div class="config-value">${escHtml(data.dbSize?.display || 'N/A')}</div></div>
    </div>

    ${data.sessionDirs && data.sessionDirs.length ? (() => {
      const dirs = data.sessionDirs || [];
      const claudeDirs = dirs.filter(d => d.agent === 'claude-code' || /^claude-/.test(d.agent || ''));
      const otherDirs = dirs.filter(d => !(d.agent === 'claude-code' || /^claude-/.test(d.agent || '')));

      const lines = [];

      if (claudeDirs.length) {
        const projects = new Set();
        for (const d of claudeDirs) {
          const m = (d.path || '').match(/[\\/]\\.claude[\\/]projects[\\/]([^\\/]+)$/);
          if (m && m[1]) projects.add(m[1]);
        }
        const projectCount = projects.size || claudeDirs.length;
        lines.push(`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-subtle)"><span style="color:var(--text-tertiary)">~/.claude/projects/*</span> <span style="color:var(--accent);font-size:12px">claude-code \u00b7 ${projectCount} workspace${projectCount === 1 ? '' : 's'}</span></div>`);
      }

      for (const d of otherDirs) {
        const display = (d.path || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
        lines.push(`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-subtle)"><span style="color:var(--text-tertiary)">${escHtml(display)}</span> <span style="color:var(--accent);font-size:12px">${escHtml(normalizeAgentLabel(d.agent))}</span></div>`);
      }

      return `<div class="section-label">Session Paths</div>
      <div class="config-card" style="margin-bottom:var(--space-xl)">
        <div style="font-size:12.5px;font-family:var(--font-mono)">${lines.join('')}</div>
      </div>`;
    })() : ''}

    ${data.agents && data.agents.length > 1 ? `<div class="section-label">Agents</div><div class="filters" style="margin-bottom:var(--space-xl)">${data.agents.map(a => `<span class="filter-chip">${escHtml(a)}</span>`).join('')}</div>` : ''}
    <div class="section-label">Date Range</div>
    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:var(--space-xl)">${fmtDate(data.dateRange?.earliest)} \u2014 ${fmtDate(data.dateRange?.latest)}</p>
    <div class="section-label">Tools Used</div>
    <div class="tools-grid">${(data.tools||[]).filter(t => t).sort().map(t => `<span class="tool-chip">${escHtml(t)}</span>`).join('')}</div>
  `;

  content.innerHTML = html;
  transitionView();
}

async function viewFiles() {
  window._lastView = 'files';
  content.innerHTML = '<div class="loading">Loading</div>';
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

  let html = `<div class="page-title">Files</div>
    <div class="search-bar" style="margin-bottom:12px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="fileSearchInput" placeholder="Filter by filename or path\u2026" value="${escHtml(window._fileSearch)}">
    </div>
    <div class="filters" style="margin-bottom:8px">
      <span class="filter-chip ${sort==='touches'?'active':''}" data-sort="touches">Most touched</span>
      <span class="filter-chip ${sort==='recent'?'active':''}" data-sort="recent">Recent</span>
      <span class="filter-chip ${sort==='sessions'?'active':''}" data-sort="sessions">Most sessions</span>
      <span class="filter-chip ${sort==='name'?'active':''}" data-sort="name">A\u2013Z</span>
    </div>
    <div class="filters" style="margin-bottom:12px">
      <span class="filter-chip ext-chip ${!window._fileFilter?'active':''}" data-ext="">All</span>
      ${exts.map(e => `<span class="filter-chip ext-chip ${window._fileFilter===e?'active':''}" data-ext="${e}">${e}</span>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="color:var(--text-tertiary);font-size:12px;font-weight:500">${files.length} files</span>
      <span class="filter-chip ${window._fileGrouped?'active':''}" id="groupToggle" style="cursor:pointer">Group by directory</span>
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

    listEl.innerHTML = sortedGroups.map(([dir, dirFiles]) => {
      const totalTouches = dirFiles.reduce((s, f) => s + f.touch_count, 0);
      const totalSessions = dirFiles.reduce((s, f) => s + f.session_count, 0);
      const groupStat = sort === 'sessions' ? `${totalSessions} sessions` : `${totalTouches} touches`;
      return `
        <div class="file-group">
          <div class="file-group-header" data-dir="${escHtml(dir)}">
            <span class="file-group-arrow">\u25b6</span>
            <span class="file-group-name">~/${escHtml(dir)}</span>
            <span style="color:var(--text-tertiary);font-size:12px;margin-left:auto">${dirFiles.length} files \u00b7 ${groupStat}</span>
          </div>
          <div class="file-group-items" style="display:none">
            ${dirFiles.map(f => renderFileItem(f)).join('')}
          </div>
        </div>`;
    }).join('');

    $$('.file-group-header').forEach(h => {
      h.addEventListener('click', () => {
        const items = h.nextElementSibling;
        const arrow = h.querySelector('.file-group-arrow');
        if (items.style.display === 'none') {
          items.style.display = 'block';
          arrow.textContent = '\u25bc';
        } else {
          items.style.display = 'none';
          arrow.textContent = '\u25b6';
        }
      });
    });
  } else {
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

  $$('.ext-chip').forEach(chip => {
    chip.onclick = () => { window._fileFilter = chip.dataset.ext; renderFiles(); };
  });

  $('#groupToggle').addEventListener('click', () => { window._fileGrouped = !window._fileGrouped; renderFiles(); });

  $$('.file-item').forEach(item => {
    item.addEventListener('click', () => viewFileDetail(item.dataset.path));
  });

  searchInput.addEventListener('keyup', () => { window._fileCursorPos = searchInput.selectionStart; });
}

function renderFileItem(f) {
  const fname = f.file_path.split('/').pop();
  const dir = f.file_path.split('/').slice(0, -1).join('/');
  return `
    <div class="file-item" data-path="${escHtml(f.file_path)}">
      <div class="file-path"><span style="color:var(--text-primary);font-weight:500">${escHtml(fname)}</span> <span style="color:var(--text-tertiary);font-size:12px">${escHtml(dir)}/</span></div>
      <div class="file-meta">
        <span>${f.touch_count} touches</span>
        <span>${f.session_count} sessions</span>
        <span style="color:var(--amber)">${escHtml(f.operations)}</span>
        <span class="session-time">${fmtTime(f.last_touched)}</span>
      </div>
    </div>
  `;
}

async function viewFileDetail(filePath) {
  content.innerHTML = '<div class="loading">Loading</div>';
  const data = await api(`/files/sessions?path=${encodeURIComponent(filePath)}`);
  if (data._error) {
    content.innerHTML = '<div class="empty"><h2>Unable to load</h2><p>Server unavailable. Pull to refresh or try again.</p></div>';
    return;
  }

  let html = `
    <div class="back-btn" id="backBtn">\u2190 Back</div>
    <div class="page-title" style="word-break:break-all;font-size:16px">${escHtml(filePath)}</div>
    <div class="section-label">${data.sessions.length} sessions touched this file</div>
  `;

  html += data.sessions.map(s => renderSessionItem(s)).join('');
  content.innerHTML = html;
  transitionView();

  $('#backBtn').addEventListener('click', () => viewFiles());
  $$('.session-item').forEach(item => {
    item.addEventListener('click', () => viewSession(item.dataset.id));
  });
}

// --- Navigation ---
window._searchType = '';
window._searchRole = '';
window._lastView = 'sessions';

$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    if (window._sseCleanup) { window._sseCleanup(); window._sseCleanup = null; }
    $$('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const view = item.dataset.view;
    window._lastView = view;
    if (view === 'search') viewSearch();
    else if (view === 'sessions') viewSessions();
    else if (view === 'files') viewFiles();
    else if (view === 'timeline') viewTimeline();
    else if (view === 'stats') viewStats();
  });
});

viewSearch();

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
        await api('/reindex');
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

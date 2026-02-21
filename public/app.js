const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const content = $('#content');
const API = '/api';

async function api(path) {
  const res = await fetch(API + path);
  return res.json();
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
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Removed jumpToInitialPrompt - now handled within session view

function badgeClass(type, role) {
  if (type === 'tool_call') return 'badge-tool_call';
  if (type === 'tool_result') return 'badge-tool_result';
  if (role === 'user') return 'badge-user';
  if (role === 'assistant') return 'badge-assistant';
  return 'badge-message';
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
    body = `<span class="tool-name">→ ${escHtml(ev.tool_name)}</span>`;
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

function renderProjectTags(s) {
  let projects = [];
  if (s.projects) {
    try { projects = JSON.parse(s.projects); } catch {}
  }
  return projects.map(p => `<span class="session-project">${escHtml(p)}</span>`).join('');
}

function renderModelTags(s) {
  // Prefer models array if present, fall back to single model
  let models = [];
  if (s.models) {
    try { models = JSON.parse(s.models); } catch {}
  }
  if (!models.length && s.model) models = [s.model];
  return models.map(m => `<span class="session-model">${escHtml(m)}</span>`).join('');
}

function renderSessionItem(s) {
  const duration = fmtDuration(s.start_time, s.end_time);
  const timeRange = `${fmtTime(s.start_time)} → ${s.end_time ? fmtTimeOnly(s.end_time) : 'now'}`;

  return `
    <div class="session-item" data-id="${s.id}">
      <div class="session-header">
        <span class="session-time">${timeRange} · ${duration}</span>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${renderProjectTags(s)}
          ${s.agent && s.agent !== 'main' ? `<span class="session-agent">${escHtml(s.agent)}</span>` : ''}
          ${s.session_type ? `<span class="session-type">${escHtml(s.session_type)}</span>` : ''}
          ${renderModelTags(s)}
        </span>
      </div>
      <div class="session-summary">${escHtml(truncate(s.summary || 'No summary', 120))}</div>
      <div class="session-meta">
        <span>💬 ${s.message_count}</span>
        <span>🔧 ${s.tool_count}</span>
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="searchInput" placeholder="Search messages, tool calls, files…" value="${escHtml(query)}">
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
  el.innerHTML = '<div class="loading">Loading…</div>';

  const stats = await api('/stats');
  const sessions = await api('/sessions?limit=5');

  let suggestions = [];
  try { const r = await fetch('/api/suggestions'); const d = await r.json(); suggestions = d.suggestions || []; } catch(e) { suggestions = []; }

  let html = `
    <div class="stat-grid" style="margin-top:8px">
      <div class="stat-card"><div class="label">Sessions</div><div class="value">${stats.sessions}</div></div>
      <div class="stat-card"><div class="label">Messages</div><div class="value">${stats.messages.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Tool Calls</div><div class="value">${stats.toolCalls.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Tokens</div><div class="value">${(stats.totalTokens || 0).toLocaleString()}</div></div>
    </div>

    <div class="section-label">Quick Search</div>
    <div class="filters" id="suggestions">
      ${suggestions.map(s => `<span class="filter-chip suggestion" data-q="${s}">${s}</span>`).join('')}
    </div>

    <div class="section-label">Recent Sessions</div>
    ${sessions.sessions.map(renderSessionItem).join('')}
  `;

  el.innerHTML = html;

  $$('.suggestion', el).forEach(chip => {
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

  el.innerHTML = '<div class="loading">Searching…</div>';

  const type = window._searchType || '';
  const role = window._searchRole || '';
  let url = `/search?q=${encodeURIComponent(q)}&limit=100`;
  if (type) url += `&type=${type}`;
  if (role) url += `&role=${role}`;

  const data = await api(url);

  if (data.error) { el.innerHTML = `<div class="empty"><p>${escHtml(data.error)}</p></div>`; return; }
  if (!data.results.length) { el.innerHTML = '<div class="empty"><h2>No results</h2></div>'; return; }

  let header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <span class="section-label" style="margin:0">${data.results.length} results</span>
    <div style="display:flex;gap:8px">
      <a class="export-btn" href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=md','search.md');return false">📄 MD</a>
      <a class="export-btn" href="#" onclick="dlExport('/api/export/search?q=${encodeURIComponent(q)}&format=json','search.json');return false">📋 JSON</a>
    </div>
  </div>`;

  el.innerHTML = header + data.results.map(r => `
    <div class="result-item">
      <div class="result-meta">
        <span class="event-badge ${badgeClass(r.type, r.role)}">${r.type === 'tool_call' ? 'tool' : r.role || r.type}</span>
        <span class="session-time">${fmtTime(r.timestamp)}</span>
        ${r.tool_name ? `<span class="tool-name">${escHtml(r.tool_name)}</span>` : ''}
        <span class="session-link" data-session="${r.session_id}">view session →</span>
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
  content.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api('/sessions?limit=200');

  let html = `<div class="page-title">Sessions</div>`;
  html += data.sessions.map(renderSessionItem).join('');
  content.innerHTML = html;

  $$('.session-item').forEach(item => {
    item.addEventListener('click', () => viewSession(item.dataset.id));
  });
}

async function viewSession(id) {
  window._currentSessionId = id;
  content.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api(`/sessions/${id}`);

  if (data.error) { content.innerHTML = `<div class="empty"><h2>${data.error}</h2></div>`; return; }

  const s = data.session;
  const cost = fmtCost(s.total_cost);
  let html = `
    <div class="back-btn" id="backBtn">← Back</div>
    <div class="page-title">Session</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      ${s.first_message_id ? `<button class="jump-to-start-btn" id="jumpToStartBtn" title="Jump to initial prompt">↗️ Initial Prompt</button>` : ''}
      ${data.hasArchive ? `<a class="export-btn" href="#" onclick="dlExport('/api/archive/export/${id}','session.jsonl');return false">📦 JSONL</a>` : ''}
      <a class="export-btn" href="#" onclick="dlExport('/api/export/session/${id}?format=md','session.md');return false">📄 MD</a>
      <a class="export-btn" href="#" onclick="dlExport('/api/export/session/${id}?format=json','session.json');return false">📋 JSON</a>
    </div>
    <div class="session-item" style="cursor:default">
      <div class="session-header">
        <span class="session-time">${fmtDate(s.start_time)} · ${fmtTimeShort(s.start_time)} – ${fmtTimeShort(s.end_time)}</span>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${renderProjectTags(s)}
          ${s.agent && s.agent !== 'main' ? `<span class="session-agent">${escHtml(s.agent)}</span>` : ''}
          ${s.session_type ? `<span class="session-type">${escHtml(s.session_type)}</span>` : ''}
          ${renderModelTags(s)}
        </span>
      </div>
      <div class="session-meta" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px 16px">
        <span>💬 ${s.message_count} messages</span>
        <span>🔧 ${s.tool_count} tools</span>
        ${s.output_tokens ? `<span>📤 ${fmtTokens(s.output_tokens)} output</span><span>📥 ${fmtTokens(s.input_tokens + s.cache_read_tokens)} input</span>` : s.total_tokens ? `<span>🔤 ${fmtTokens(s.total_tokens)} tokens</span><span></span>` : '<span></span><span></span>'}
      </div>
    </div>
    <div class="section-label">Events</div>
  `;

  html += data.events.map(renderEvent).join('');
  content.innerHTML = html;

  $('#backBtn').addEventListener('click', () => {
    if (window._lastView === 'timeline') viewTimeline();
    else if (window._lastView === 'files') viewFiles();
    else if (window._lastView === 'search') viewSearch(window._lastSearchQuery || '');
    else viewSessions();
  });

  const jumpBtn = $('#jumpToStartBtn');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', () => {
      const firstMessage = document.querySelector(`[data-event-id="${s.first_message_id}"]`);
      if (firstMessage) {
        firstMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstMessage.style.background = 'var(--accent-bg)';
        setTimeout(() => {
          firstMessage.style.background = '';
        }, 2000);
      }
    });
  }
}

async function viewTimeline(date) {
  if (!date) date = new Date().toISOString().slice(0, 10);
  window._lastView = 'timeline';

  let html = `<div class="page-title">Timeline</div>
    <input type="date" class="date-input" id="dateInput" value="${date}">
    <div id="timelineContent"><div class="loading">Loading…</div></div>`;
  content.innerHTML = html;

  const data = await api(`/timeline?date=${date}`);
  const el = $('#timelineContent');

  if (!data.events.length) {
    el.innerHTML = '<div class="empty"><h2>No activity</h2><p>Nothing recorded on this day</p></div>';
  } else {
    el.innerHTML = data.events.map(renderEvent).join('');
  }

  $('#dateInput').addEventListener('change', e => viewTimeline(e.target.value));
}

async function viewStats() {
  content.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api('/stats');

  let html = `<div class="page-title">Stats</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Sessions</div><div class="value">${data.sessions}</div></div>
      <div class="stat-card"><div class="label">Messages</div><div class="value">${data.messages.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Tool Calls</div><div class="value">${data.toolCalls.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Unique Tools</div><div class="value">${data.uniqueTools}</div></div>
      <div class="stat-card"><div class="label">Total Tokens</div><div class="value">${(data.totalTokens || 0).toLocaleString()}</div></div>
    </div>

    <div class="section-label">Configuration</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Storage Mode</div><div class="value" style="font-size:18px">${escHtml(data.storageMode || 'reference')}</div></div>
      <div class="stat-card"><div class="label">DB Size</div><div class="value" style="font-size:18px">${escHtml(data.dbSize?.display || 'N/A')}</div></div>
    </div>

    ${data.sessionDirs && data.sessionDirs.length ? `<div class="section-label">Sessions Paths</div>
    <div style="font-size:13px;color:var(--text2);font-family:var(--mono)">
      ${data.sessionDirs.map(d => {
        const display = d.path.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
        return `<div style="margin-bottom:4px">📂 ${escHtml(display)} <span style="color:var(--accent)">(${escHtml(d.agent)})</span></div>`;
      }).join('')}
    </div>` : ''}

    ${data.agents && data.agents.length > 1 ? `<div class="section-label">Agents</div><div class="filters">${data.agents.map(a => `<span class="filter-chip">${escHtml(a)}</span>`).join('')}</div>` : ''}
    <div class="section-label">Date Range</div>
    <p style="color:var(--text2);font-size:14px">${fmtDate(data.dateRange?.earliest)} — ${fmtDate(data.dateRange?.latest)}</p>
    <div class="section-label">Tools Used</div>
    <div class="filters">${(data.tools||[]).filter(t => t).sort().map(t => `<span class="filter-chip">${escHtml(t)}</span>`).join('')}</div>
  `;

  content.innerHTML = html;
}

async function viewFiles() {
  window._lastView = 'files';
  content.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api('/files?limit=500');
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
  // Group by project-level directory
  // Strip common home dir prefixes
  let rel = p.replace(/^\/home\/[^/]+\//, '~/').replace(/^\/Users\/[^/]+\//, '~/');
  if (rel.startsWith('~/')) rel = rel.slice(2);
  const parts = rel.split('/');
  if (parts.length <= 2) return parts[0] || '/';
  return parts.slice(0, 2).join('/');
}

function renderFiles() {
  let files = [...window._allFiles];

  // Search filter
  const q = window._fileSearch.toLowerCase();
  if (q) files = files.filter(f => f.file_path.toLowerCase().includes(q));

  // Extension filter
  if (window._fileFilter) {
    files = files.filter(f => getFileExt(f.file_path) === window._fileFilter);
  }

  // Sort
  const sort = window._fileSort;
  if (sort === 'touches') files.sort((a, b) => b.touch_count - a.touch_count);
  else if (sort === 'recent') files.sort((a, b) => new Date(b.last_touched) - new Date(a.last_touched));
  else if (sort === 'name') files.sort((a, b) => a.file_path.localeCompare(b.file_path));
  else if (sort === 'sessions') files.sort((a, b) => b.session_count - a.session_count);

  // Get unique extensions for filter chips
  const exts = [...new Set(window._allFiles.map(f => getFileExt(f.file_path)))].sort();

  let html = `<div class="page-title">Files</div>
    <div class="search-bar" style="margin-bottom:12px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="fileSearchInput" placeholder="Filter by filename or path…" value="${escHtml(window._fileSearch)}">
    </div>
    <div class="filters" style="margin-bottom:8px">
      <span class="filter-chip ${sort==='touches'?'active':''}" data-sort="touches">Most touched</span>
      <span class="filter-chip ${sort==='recent'?'active':''}" data-sort="recent">Recent</span>
      <span class="filter-chip ${sort==='sessions'?'active':''}" data-sort="sessions">Most sessions</span>
      <span class="filter-chip ${sort==='name'?'active':''}" data-sort="name">A-Z</span>
    </div>
    <div class="filters" style="margin-bottom:12px">
      <span class="filter-chip ext-chip ${!window._fileFilter?'active':''}" data-ext="">All</span>
      ${exts.map(e => `<span class="filter-chip ext-chip ${window._fileFilter===e?'active':''}" data-ext="${e}">${e}</span>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="color:var(--text2);font-size:13px">${files.length} files</span>
      <span class="filter-chip ${window._fileGrouped?'active':''}" id="groupToggle" style="cursor:pointer">📂 Group by directory</span>
    </div>
    <div id="filesList"></div>`;

  content.innerHTML = html;

  // Render file list
  const listEl = $('#filesList');

  if (window._fileGrouped && !q) {
    // Group by directory
    const groups = {};
    files.forEach(f => {
      const dir = getFileDir(f.file_path);
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f);
    });

    // Sort groups by active sort criteria
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
            <span class="file-group-arrow">▶</span>
            <span class="file-group-name">~/${escHtml(dir)}</span>
            <span style="color:var(--text2);font-size:12px;margin-left:auto">${dirFiles.length} files · ${groupStat}</span>
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
          arrow.textContent = '▼';
        } else {
          items.style.display = 'none';
          arrow.textContent = '▶';
        }
      });
    });
  } else {
    listEl.innerHTML = files.map(f => renderFileItem(f)).join('');
  }

  // Event listeners — must re-attach every render since innerHTML replaces DOM
  let debounce;
  const searchInput = $('#fileSearchInput');
  searchInput.addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { window._fileSearch = e.target.value; renderFiles(); }, 200);
  });

  // Preserve cursor position after re-render
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

  // Track cursor for re-renders
  searchInput.addEventListener('keyup', () => { window._fileCursorPos = searchInput.selectionStart; });
}

function renderFileItem(f) {
  const fname = f.file_path.split('/').pop();
  const dir = f.file_path.split('/').slice(0, -1).join('/');
  return `
    <div class="file-item" data-path="${escHtml(f.file_path)}">
      <div class="file-path"><span style="color:var(--text)">${escHtml(fname)}</span> <span style="color:var(--text2);font-size:12px">${escHtml(dir)}/</span></div>
      <div class="file-meta">
        <span>${f.touch_count} touches</span>
        <span>${f.session_count} sessions</span>
        <span style="color:var(--orange)">${escHtml(f.operations)}</span>
        <span class="session-time">${fmtTime(f.last_touched)}</span>
      </div>
    </div>
  `;
}

async function viewFileDetail(filePath) {
  content.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api(`/files/sessions?path=${encodeURIComponent(filePath)}`);

  let html = `
    <div class="back-btn" id="backBtn">← Back</div>
    <div class="page-title" style="word-break:break-all;font-size:16px">${escHtml(filePath)}</div>
    <div class="section-label">${data.sessions.length} sessions touched this file</div>
  `;

  html += data.sessions.map(s => renderSessionItem(s)).join('');
  content.innerHTML = html;

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
  const edgeWidth = 30; // px from left edge
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
    // Cancel if vertical movement exceeds horizontal (it's a scroll)
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
  const threshold = 80;

  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.id = 'ptr';
  indicator.textContent = '↓ Pull to refresh';
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
      indicator.textContent = diff > threshold ? '↑ Release to refresh' : '↓ Pull to refresh';
    } else {
      indicator.classList.remove('visible');
    }
  }, { passive: true });

  document.addEventListener('touchend', async e => {
    if (!pulling) return;
    pulling = false;
    const diff = e.changedTouches[0].clientY - startY;
    if (diff > threshold && indicator.classList.contains('visible')) {
      indicator.textContent = 'Refreshing…';
      indicator.classList.add('refreshing');
      try {
        await api('/reindex');
        // If viewing a session detail, refresh it in place
        const backBtn = $('#backBtn');
        if (backBtn && window._currentSessionId) {
          await viewSession(window._currentSessionId);
        } else {
          const active = $('.nav-item.active');
          if (active) active.click();
        }
      } catch(err) {}
      setTimeout(() => {
        indicator.classList.remove('visible', 'refreshing');
      }, 500);
    } else {
      indicator.classList.remove('visible');
    }
  });
})();

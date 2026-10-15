# AgentActa

[![CI](https://github.com/mirajchokshi/agentacta/actions/workflows/ci.yml/badge.svg)](https://github.com/mirajchokshi/agentacta/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentacta)](https://www.npmjs.com/package/agentacta)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Your agent did 1000s of things today. Can you find the 1 that broke prod?**

AgentActa is a local audit trail and search engine for AI agent sessions.

It indexes messages, tool calls, file edits, searches, and decisions into a fast UI you can query in seconds.

One command. Zero config. Full visibility.

```bash
npx agentacta
```

<p align="center">
  <img src="screenshots/demo.gif" alt="AgentActa demo: overview, nested subagent sessions, a live session, timeline, insights and search" width="800">
</p>

<p align="center"><a href="screenshots/demo.mp4">Watch the full-quality video</a> · recorded from the bundled demo data (<code>npm run record-demo</code>)</p>

## Why this exists

Agents move fast. Your memory of what happened doesn't.

When you need to answer "what changed, when, and why," you're usually scraping logs, scrolling transcripts, or asking the same assistant that forgot 20 minutes ago.

AgentActa gives you one place to inspect the full trail.

## What you get

- 🔍 Full-text search across messages, tool calls, and results (⌘K)
- 📋 Session browser with real titles, token breakdowns, and model info
- 🟢 Live / stale status for every session, and subagents nested under the session that spawned them
- 📈 Overview of today against your 14-day average, activity per day and per agent, and usage per week
- 🧩 Session pages that show when a session was busy and which tools it leaned on
- 🧭 Project-scoped session filtering with per-event attribution
- 🤖 Clear Codex run visibility for direct and Symphony-origin sessions
- 📅 Timeline of any day, grouped by session, with live updates for today
- 📁 File activity across all indexed sessions
- 🌗 Light and dark themes
- 📊 Stats for sessions, messages, tools, and tokens
- ⚡ Live indexing via file watching
- 📱 Mobile-optimized UI with floating navigation
- 🏥 Session health scoring - reliability scores, issue detection, and per-signal breakdowns
- ⌨️ Command palette (⌘K / Ctrl+K) and keyboard navigation (J/K, Enter, Esc)
- 🎨 Theme settings (system, light, dark, OLED)
- 🏥 Health endpoint for monitoring (`/api/health`)


## Quick start

```bash
# run directly
npx agentacta

# or install globally
npm install -g agentacta
agentacta
```

Open: `http://localhost:4003`

Auto-detected session sources:
- `~/.openclaw/agents/*/agent/openclaw-agent.sqlite` (OpenClaw 2026.8+), or `~/.openclaw/agents/*/sessions/` for older versions
- `~/.openclaw/cron/runs/` (OpenClaw cron runs without a transcript)
- `~/.claude/projects/*/`, including each session's `subagents/` transcripts (Claude Code)
- `~/.codex/sessions/` (Codex CLI)

Add more session folders (auto-detection still runs):

```bash
AGENTACTA_SESSIONS_PATH=/path/to/sessions agentacta
```

## Core features

### Search

Press ⌘K (Ctrl+K, or `/`) to search. Results cover matching events (SQLite FTS5 full-text search over messages, tool calls and results), sessions and files, and the palette also jumps between views.

The search API adds filters for event type (`message`, `tool_call`, `tool_result`) and role (`user`, `assistant`), and suggests queries from your own data (top tools, common topics, frequently touched files).

### Sessions

Browse indexed sessions with real titles (Claude Code's own session title or your `/rename`, otherwise the first request), agent, project and model, timing, and message and tool-call counts. Click into any session for its full event history, opened by its duration, messages, tool calls and tokens, a strip showing when it was busy, and the tools it used most. Tool calls show the argument that matters (the command, file, pattern or URL), with the full arguments one click away.

Session detail view supports project-scoped filtering, so mixed-project sessions can be narrowed down without losing the full underlying transcript. The Initial Prompt jump still resolves from full session context even when a project filter is active.

Subagent sessions nest under the session that spawned them (Claude Code `subagents/` transcripts, Codex spawned threads, OpenClaw spawned sessions), with a collapsible count on the parent and a link back to the parent from the child.

Sessions show as **Live** (activity in the last 15 minutes) or **Stale** (never recorded an end and has gone quiet). A live session's page shows new events as they arrive. AgentActa only reads transcripts, so it can't stop a running agent.

Session types get tagged so noisy categories are easier to spot (cron, sub-agent, heartbeat). Codex-backed work is also distinguished more clearly, including direct Codex runs and Symphony-origin Codex sessions.

### Timeline

Pick a date, see everything that happened, newest first, grouped under the session each event belongs to. Today's view updates live as new events come in.

### Insights

The Insights tab surfaces session health across your entire history.

It tracks five issue signals - repeated tool loops, sessions that produced no output, high error rates, vague instructions, and incomplete sessions. Each signal is severity-scaled so scores reflect how bad the problem actually was, not just whether it occurred.

The reliability score (0-100) is the inverse of the confusion score: higher means the agent completed work cleanly. The page shows what share of sessions had at least one issue, the average reliability, how often each signal fired, and the flagged sessions with their signals (repeats counted, e.g. "Repeated Actions ×3").

### File Activity

See what files were touched, how often, and by which sessions.

Sort by recency, frequency, or session count. Filter by extension. Group by directory. Click any file to see which sessions touched it.

### Export

Export a session as Markdown or JSON from its page (plus the raw JSONL in archive mode), or search results through the API (`/api/export/search`).

Useful for handoffs, incident writeups, and audit archives.

## How it works

AgentActa parses session transcripts (JSONL files from Claude Code, Codex CLI and older OpenClaw, and OpenClaw's per-agent SQLite stores), then indexes events into local SQLite with FTS5.

The UI is a single-page app served by a lightweight Node HTTP server.

No framework build pipeline. Minimal moving parts.

```text
Session transcripts -> SQLite + FTS5 index -> HTTP API -> Web UI
```

Everything stays on your machine.

## Configuration

On first run, AgentActa creates:
- `~/.config/agentacta/config.json`
- or `agentacta.config.json` in current directory (if present)

Config written on first run (`sessionsPath` lists whichever known session folders exist on your machine, or is `null`):

```json
{
  "port": 4003,
  "storage": "reference",
  "sessionsPath": ["/home/you/.claude/projects", "/home/you/.codex/sessions"],
  "dbPath": "./agentacta.db",
  "projectAliases": {},
  "authToken": null
}
```

`sessionsPath` adds session roots on top of auto-discovery. It accepts a string, a colon-delimited string, or a JSON array.

`dbPath` is resolved against the directory you start AgentActa from, so `./agentacta.db` puts the database wherever you run it. For a long-running install, set an absolute path (for example `~/.local/share/agentacta/agentacta.db`, written out in full).

### Storage modes

- `reference` (default): index parsed events in SQLite, keep source JSONL on disk. Lightweight.
- `archive`: store full JSONL in SQLite. Sessions survive even if original files are deleted. Uses more disk.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4003` | Server port |
| `AGENTACTA_HOST` | `127.0.0.1` | Bind address |
| `AGENTACTA_SESSIONS_PATH` | auto-detected | Custom sessions directory |
| `AGENTACTA_DB_PATH` | `./agentacta.db` | Database path (relative paths resolve against the working directory) |
| `AGENTACTA_STORAGE` | `reference` | `reference` or `archive` |
| `AGENTACTA_PROJECT_ALIASES_JSON` | unset | Rename inferred project labels |
| `AGENTACTA_AUTH_TOKEN` | unset | Shared token required for API and UI access (see Security) |
| `AGENTACTA_ALLOW_UNAUTHENTICATED_NETWORK` | unset | Set to `1` to allow a non-loopback bind without a token (trusted networks only) |

## API

| Endpoint | Description |
|---|---|
| `GET /api/stats` | Session/message/tool/token totals |
| `GET /api/sessions?limit=&offset=` | Session list with metadata and `status` (`live` / `stale` / `ended`); `?roots=1` returns top-level sessions with their subagent tree |
| `GET /api/sessions/:id` | Session events (newest first), plus `parent`, nested `children`, `projectFilters` and a `shape` summary; `?limit=N` returns only the newest N events (`eventTotal` gives the full count) |
| `GET /api/sessions/:id/events?after=<ts>&afterId=<id>` | Events after a cursor (paged) |
| `GET /api/sessions/:id/stream?after=<ts>` | SSE stream for live session-detail updates |
| `GET /api/activity?days=14&tz=<offset>` | Per-day and per-agent activity (events, tool calls, sessions) in the viewer's timezone |
| `GET /api/search?q=<query>` | Full-text search + filters |
| `GET /api/suggestions` | Search suggestions |
| `GET /api/timeline?date=YYYY-MM-DD` | Events for one day |
| `GET /api/files` | Touched-file inventory |
| `GET /api/files/sessions?path=<file>` | Sessions that touched a file (one row per session) |
| `GET /api/export/session/:id?format=md` | Export one session (`md` or `json`) |
| `GET /api/timeline/stream?after=<ts>` | SSE stream for live timeline updates |
| `POST /api/maintenance` | VACUUM + WAL checkpoint (returns size before/after) |
| `POST /api/reindex` | Re-scan all session sources |
| `GET /api/config` | Effective storage mode, DB path and size, session sources |
| `GET /api/health` | Server status, version, uptime, session count, and whether the startup index pass is still running (`indexing`) |
| `GET /api/insights` | Session health summary - reliability scores, issue counts, top flagged sessions |
| `GET /api/insights/session/:id` | Health signals for one session |
| `GET /api/archive/session/:id`, `GET /api/archive/export/:id` | Raw JSONL lines (archive mode) |
| `GET /api/export/search?q=<query>&format=md` | Export search results |

### Context API

The Context API gives agents historical context before they start working. Instead of exploring a codebase from scratch, an agent can query what's happened before.

| Endpoint | Description |
|---|---|
| `GET /api/context/file?path=<filepath>` | History for a specific file |
| `GET /api/context/repo?path=<repo-path>` | Aggregates for a repo/project |
| `GET /api/context/agent?name=<agent-name>` | Stats for a specific agent |

**File context** - how many sessions touched this file, when it was last modified, recent change summaries, operation breakdown (reads vs edits), related files, and recent errors:

```bash
curl http://localhost:4003/api/context/file?path=/home/user/project/server.js
```
```json
{
  "file": "/home/user/project/server.js",
  "sessionCount": 34,
  "lastModified": "3h ago",
  "recentChanges": ["Added OAuth state validation", "Fixed password masking"],
  "operations": { "edit": 105, "read": 56 },
  "relatedFiles": [{ "path": "public/app.js", "count": 28 }],
  "recentErrors": []
}
```

**Agent context** - total sessions, cost, average duration, most-used tools, recent work:

```bash
curl http://localhost:4003/api/context/agent?name=claude-code
```
```json
{
  "agent": "claude-code",
  "sessionCount": 60,
  "totalCost": 18.83,
  "avgDuration": 288,
  "topTools": [{ "tool": "edit", "count": 190 }, { "tool": "exec", "count": 560 }],
  "recentSessions": [{ "id": "...", "summary": "Added context API...", "timestamp": "..." }],
  "successRate": 100
}
```

**Repo context** - aggregate cost, tokens, distinct agents, most-touched files, common tools:

```bash
curl http://localhost:4003/api/context/repo?path=agentacta
```

#### Using the Context API with agents

Inject context into agent prompts so new sessions start informed:

```bash
# Fetch context before starting Claude Code
CONTEXT=$(curl -s http://localhost:4003/api/context/file?path=$(pwd)/server.js)
claude --print "Context from previous sessions: $CONTEXT

Your task: refactor the auth module"
```

Or add it to a CLAUDE.md / AGENTS.md:

```markdown
## Project Context API
Before modifying key files, query AgentActa for history:
curl http://localhost:4003/api/context/file?path={filepath}
```

Agent integration example:

```javascript
const res = await fetch('http://localhost:4003/api/search?q=deployment+issue&limit=5');
const data = await res.json();
```

## Security

AgentActa binds to `127.0.0.1` by default.

If you expose it on a network, protect it with a shared token:

```bash
AGENTACTA_HOST=0.0.0.0 AGENTACTA_AUTH_TOKEN="$(openssl rand -hex 24)" agentacta
```

Then open AgentActa once with the token in the URL. AgentActa will store it in a local cookie for the browser:

```text
http://your-host:4003/?token=your-token
```

API clients can send either `Authorization: Bearer your-token` or `X-AgentActa-Token: your-token`.

AgentActa refuses non-loopback binds without `AGENTACTA_AUTH_TOKEN` unless you explicitly set `AGENTACTA_ALLOW_UNAUTHENTICATED_NETWORK=1` for a trusted-network-only deployment.

**Important:** Session data can contain sensitive content (file snippets, API payloads, personal messages, tool args). Do not expose AgentActa publicly without a real access layer in front of it.

## Tech stack

- Node.js (built-in `http`)
- `better-sqlite3` + SQLite FTS5
- Vanilla HTML/CSS/JS
- PWA support

## Privacy

No telemetry. No cloud sync. No external indexing service.

Your session history stays local.

## Compatibility

- ✅ [OpenClaw](https://github.com/openclaw/openclaw)
- ✅ Claude Code
- ✅ Codex CLI
- 🔜 Custom JSONL formats

## Contributing

PRs welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md). If you're adding a new agent format, start in `src/indexer.ts`.

## Name

*Acta* is Latin for "things done."

That's the job here: keep a readable record of what your agents actually did.

## License

MIT

---

Built in Chicago by humans and agents.

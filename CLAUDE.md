# CLAUDE.md

## What is this?

AgentActa is a local audit trail and search engine for AI agent sessions. It indexes JSONL session logs from Claude Code, Codex, and OpenClaw into SQLite with FTS5 full-text search, and serves a dashboard UI.

## Stack

- Vanilla Node.js HTTP server (no Express)
- SQLite via better-sqlite3 (WAL mode)
- Vanilla JS frontend (no framework)
- Inter + JetBrains Mono fonts
- Dark/light theme with CSS variables

## Key files

- `index.js` — HTTP server, all API routes (~750 lines)
- `db.js` — SQLite schema, init, prepared statements
- `indexer.js` — JSONL session log parser and indexer
- `config.js` — Config loading (CWD → XDG), env var overrides
- `public/app.js` — Frontend application (~1800 lines)
- `public/style.css` — All styles
- `public/index.html` — Shell (sidebar nav + main content area)

## Architecture

1. On startup, discovers session directories (Claude Code, Codex, OpenClaw)
2. Indexes all `.jsonl` files into SQLite (sessions, events, file_activity tables)
3. Watches directories for changes and live-reindexes
4. Serves dashboard UI + JSON API on port 4003

## Context API

AgentActa has a Context API that provides historical context about files, repos, and agents. Before modifying files in this project, you can query it:

```bash
# What's the history of this file?
curl http://localhost:4003/api/context/file?path=$(pwd)/index.js

# What has claude-code done recently?
curl http://localhost:4003/api/context/agent?name=claude-code
```

## Testing

```bash
npm test
```

Uses `node:test` and `node:assert`. Tests are in `tests/`. Currently 38 tests across 6 suites.

## Patterns to follow

- All routes use `parseQuery()` for URL parsing and `json()` helper for responses
- No dependencies for HTTP routing — just pathname matching in if/else chain
- Frontend uses hash-based routing (`#sessions`, `#overview`, etc.)
- Agent labels normalized via `normalizeAgentLabel()` (e.g. `claude-*` → `claude-code`)
- Config supports env var overrides: `PORT`, `AGENTACTA_STORAGE`, `AGENTACTA_SESSIONS_PATH`, `AGENTACTA_DB_PATH`

## Port

Default port is 4003. Set via config or `PORT` env var.

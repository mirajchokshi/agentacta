# CLAUDE.md

## What is this?

AgentActa is a local audit trail and search engine for AI agent sessions. It indexes JSONL session logs from Claude Code, Codex, and OpenClaw into SQLite with FTS5 full-text search, and serves a dashboard UI.

## Stack

- TypeScript backend (compiled to `dist/` via tsc)
- Vanilla Node.js HTTP server (no Express)
- SQLite via better-sqlite3 (WAL mode)
- Vanilla JS frontend (no framework)
- Inter + JetBrains Mono fonts
- Dark/light theme with CSS variables

## Key files

- `src/index.ts` — HTTP server, all API routes
- `src/db.ts` — SQLite schema, init, prepared statements
- `src/indexer.ts` — JSONL session log parser and indexer
- `src/index-worker.ts` — Worker thread that runs indexing, file watching and insight scoring off the HTTP thread
- `src/config.ts` — Config loading (CWD → XDG), env var overrides
- `src/types.ts` — All TypeScript interfaces and type definitions
- `src/insights.ts` — Session health scoring
- `src/project-attribution.ts` — Project-scoped event attribution
- `src/attribution-store.ts` — Stores each session's attribution at index time (event_attr), with backfill
- `src/search.ts` — Command-palette search (sessions, files, full-text events with snippets)
- `src/session-detail.ts` — Session events page / older pages / shape / project filters for the session endpoint
- `src/delta-attribution-context.ts` — Delta attribution context loader
- `public/app.js` — Frontend application (~1800 lines)
- `public/style.css` — All styles
- `public/index.html` — Shell (sidebar nav + main content area)
- `index.js` — Thin shebang wrapper → `dist/index.js`

## Architecture

1. On startup, serves the dashboard UI + JSON API on port 4003 right away from the existing index
2. A worker thread (`src/index-worker.ts`) discovers session directories (Claude Code, Codex, OpenClaw) and indexes changed `.jsonl` files / stores into SQLite (sessions, events, file_activity tables); a first run with an empty index holds data requests until this pass finishes
3. The worker watches directories, live-reindexes, and tells the server which sessions changed (for SSE)

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

Uses `node:test` and `node:assert`. Tests are in `tests/` as TypeScript, run via `tsx`. Currently 126 tests.

## Building

```bash
npm run build    # compile TS → dist/
npm run dev      # run with tsx (no build step needed)
npm start        # run compiled dist/index.js
```

## Patterns to follow

- All routes use `parseQuery()` for URL parsing and `json()` helper for responses
- No dependencies for HTTP routing — just pathname matching in if/else chain
- Frontend uses hash-based routing (`#sessions`, `#overview`, etc.)
- Agent labels normalized via `normalizeAgentLabel()` (e.g. `claude-*` → `claude-code`)
- Config supports env var overrides: `PORT`, `AGENTACTA_STORAGE`, `AGENTACTA_SESSIONS_PATH`, `AGENTACTA_DB_PATH`

## Port

Default port is 4003. Set via config or `PORT` env var.

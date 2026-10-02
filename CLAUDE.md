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
- `src/config.ts` — Config loading (CWD → XDG), env var overrides
- `src/types.ts` — All TypeScript interfaces and type definitions
- `src/insights.ts` — Session health scoring (11 signals), alert persistence (`syncAlerts`)
- `src/tasks.ts` — Task tracing: rebuilds planned tasks / subagents / turns from events (`buildTrace`)
- `src/digest.ts` — Proactive digest (`getDigest`) and alert queries
- `src/chatgpt-auth.ts` — Sign in with ChatGPT (PKCE + loopback OAuth, no deps)
- `src/ai.ts` — AI briefs via the Responses API using the connected ChatGPT plan
- `src/project-attribution.ts` — Project-scoped event attribution
- `src/delta-attribution-context.ts` — Delta attribution context loader
- `public/app.js` — Frontend application (~2600 lines)
- `public/style.css` — All styles
- `public/index.html` — Shell (sidebar nav + main content area)
- `index.js` — Thin shebang wrapper → `dist/index.js`

## Architecture

1. On startup, discovers session directories (Claude Code, Codex, OpenClaw)
2. Indexes all `.jsonl` files (and OpenClaw SQLite stores) into SQLite (sessions, events, file_activity tables); Claude Code dirs are scanned recursively so `<session>/subagents/*.jsonl` become child sessions (`parent_session_id`)
3. Watches directories for changes and live-reindexes; each re-index recomputes insights, syncs alerts and pushes SSE updates (`session-update`, `alert`)
4. Serves dashboard UI + JSON API on port 4003

Events have `type` ∈ `message | tool_call | tool_result`, plus `is_error` on results. Tool results use the id `<tool_use_id>:result` so a call and its result can be paired.

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

Uses `node:test` and `node:assert`. Tests are in `tests/` as TypeScript, run via `tsx`. Currently 98 tests across 13 suites. `tests/chatgpt-auth.test.ts` runs a fake OpenAI issuer (discovery, JWKS, token, models, responses) so the OAuth flow is covered without the network.

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
- Config supports env var overrides: `PORT`, `AGENTACTA_STORAGE`, `AGENTACTA_SESSIONS_PATH`, `AGENTACTA_DB_PATH`, `AGENTACTA_AI_MODEL`, `AGENTACTA_CHATGPT_PROFILE`
- Mutating routes are POST and read JSON bodies through `readJsonBody()`
- New insight signals: add the type to `types.ts` (`InsightSignal`, `SIGNAL_WEIGHTS`), detection + score in `insights.ts`, an `alertForSignal` entry if it should alert, and labels in `public/app.js` (`SIGNAL_LABELS/DESCRIPTIONS/COLORS`, `signalDetail`)
- Anything that calls out to OpenAI goes through `AiBriefs`; nothing is sent without an explicit user action

## Port

Default port is 4003. Set via config or `PORT` env var.

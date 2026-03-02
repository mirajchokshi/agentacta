# Contributing to AgentActa

Thanks for your interest! AgentActa is a zero-framework Node.js project — we keep things simple.

## Dev Setup

```bash
git clone https://github.com/mirajchokshi/agentacta.git
cd agentacta
npm install
```

## Running Tests

```bash
npm test
```

Tests use Node's built-in test runner (`node:test` + `node:assert`). No extra test frameworks needed.

## Code Style

- No frameworks — vanilla Node.js, raw HTTP, better-sqlite3
- No new npm dependencies without strong justification
- Keep functions small and focused
- Use `const` by default, `let` when needed, never `var`

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add/update tests for new functionality
4. Run `npm test` and make sure everything passes
5. Open a PR with a clear description of what and why

## SSE (Server-Sent Events) — Realtime Updates

The session detail view supports live updates via SSE. When a session's JSONL file
changes on disk, the file watcher re-indexes it and pushes new events to any
connected browser.

**Endpoint:** `GET /api/sessions/:id/stream?after=<ISO timestamp>`

- Returns `Content-Type: text/event-stream`
- Each SSE message `data:` field is a JSON array of new events
- The SSE `id:` field is the latest event timestamp (used for reconnect via `Last-Event-ID`)
- Sends `: ping` every 30s as keep-alive

**Testing SSE manually:**

```bash
# 1. Start the server (or demo mode)
npm run demo

# 2. Open a session in the browser, note the session ID

# 3. In another terminal, connect with curl:
curl -N "http://127.0.0.1:3117/api/sessions/<SESSION_ID>/stream?after=2000-01-01T00:00:00Z"

# 4. Append a new line to the session's JSONL file to trigger a re-index.
#    After ~2s debounce, you should see the SSE push in curl output.

# 5. In the browser, new events appear at the top of the list with a highlight.
#    If scrolled down, a "N new events" pill appears — click to jump to top.
```

**Automated tests:** `npm test` includes `tests/sse.test.js` which covers headers, 404,
event push, Last-Event-ID reconnect, and cross-session isolation.

## Reporting Issues

Open a GitHub issue with:
- What you expected vs what happened
- Steps to reproduce
- Node.js version and OS

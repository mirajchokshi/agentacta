# Changelog

## [2026.3.12-r2] - 2026-03-12

### Added
- Project-scoped filtering in session detail view, backed by per-event project attribution.
- Clearer Codex session classification in the UI for both direct Codex runs and Symphony-origin Codex sessions.
- Delta attribution context loader to keep live project filtering accurate as new events stream in.

### Changed
- Session detail project filter now lives inside the session card instead of duplicating project tags in multiple places.
- Initial Prompt jump resolves from full session context even when a project filter is active.
- Codex session discovery is more reliable for nested `~/.codex/sessions/YYYY/MM/DD/*.jsonl` files.

### Fixed
- Missing direct Codex runs in AgentActa session lists when nested Codex session files were not re-indexed reliably.
- Missing Symphony-origin Codex sessions in AgentActa visibility and attribution.
- Live project-filtered views dropping some delta events because prior session context was too narrow.
- False `workspace` attribution from Windows absolute paths and slash-containing non-path metadata.

## [2026.3.12] - 2026-03-12

### Added
- **Context API** — three new endpoints that surface historical context from indexed sessions:
  - `GET /api/context/file?path=<filepath>` — session count, recent changes, operations breakdown, related files, recent errors
  - `GET /api/context/repo?path=<repo-path>` — aggregate cost/tokens, distinct agents, top files, recent sessions, common tools
  - `GET /api/context/agent?name=<agent-name>` — session count, total cost, avg duration, top tools, recent sessions, success rate
- **CLAUDE.md** — project context file for agents working on AgentActa
- Context API documentation in README with usage examples

### Fixed
- Agent name normalization in context API (reverse-maps normalized labels like `openclaw-main` to raw DB values)
- Repo path matching uses directory boundary (`path/`) to prevent prefix collisions
- Related files query counts distinct sessions instead of multiplicative self-join

## [2026.3.7] - 2026-03-07

### Fixed
- **Session auto-discovery on first run** — AgentActa now detects existing agent session directories (`~/.claude/projects`, `~/.codex/sessions`, `~/.openclaw/sessions`) when generating the default config. No manual configuration needed for new installs.
- **Claude Code sessions not appearing** — Fixed indexer to correctly scan per-project subdirectories under `~/.claude/projects` when `sessionsPath` is set in config.
- **Array `sessionsPath` config** — `sessionsPath` now accepts a JSON array in addition to a colon-delimited string, preventing a `TypeError` on startup for users with auto-detected configs.
- **Claude Code `queue-operation` format** — JSONL files starting with `queue-operation` events (a Claude Code variant) are now correctly identified and indexed.
- **In-memory config on first run** — Auto-detected session directories are now applied to the running process immediately, not just written to disk.

## [2026.3.5] - 2026-03-05

### Added
- Theme settings in **Settings → Appearance**:
  - Theme Mode: System / Light / Dark
  - Dark Variant: Default / True Black
- True Black dark theme variant (`data-theme="oled"`)
- Initial Prompt jump UX improvements for long sessions:
  - subtle in-button pulse while jumping
  - return-to-previous-position control

### Changed
- Cmd+K trigger copy simplified to **Search**
- Cmd+K keyboard shortcut now toggles palette open/close when already open
- Command palette input copy no longer uses ellipsis
- Sidebar search trigger placement refined below logo

### Fixed
- Timeline live-update edge cases:
  - empty-day timeline can receive first live event
  - pagination offset stays correct after SSE prepends
  - SSE cursor tie-breaker handles equal timestamps
- Search/home async guard prevents stale responses from overwriting newer query UI state
- Cmd+K Recently Opened now resolves sessions by id even when outside latest list
- Theme preference reads/writes now safely handle localStorage failures

## [1.4.0] - 2026-03-04

### Added
- **Light theme** with toggle (sun/moon icons in sidebar header, mobile top-right button). Persisted via localStorage, defaults to light.
- **Skeleton loading** across all views (search, sessions, timeline, stats, files, session detail). Shimmer placeholders render instantly while data loads.
- **Timeline pagination** with infinite scroll (100 events per page, scroll to load more)
- **Timeline live updates** via SSE stream (`/api/timeline/stream`). New events appear at the top in real time when viewing today's date.
- **Database maintenance** endpoint (`POST /api/maintenance`): runs WAL checkpoint + VACUUM. Button in Stats view with inline helper copy and before/after size display.
- **MCP tool name formatting**: event-level display shows `mcp_provider_action`, stats chips collapse all actions under one `mcp_provider` entry
- Sessions sort index (`idx_sessions_start_time`) for faster session list queries

### Changed
- Timeline API now supports `limit` and `offset` query params (default 100, max 500)
- Unique Tools count in stats reflects grouped MCP providers instead of individual actions
- Main content area `max-width` removed on desktop (fills available space)
- Search results show tool names with cleaned MCP formatting

### Fixed
- Timeline scroll handler cleanup on view navigation (prevented stale listeners)
- Removed dead view-cache code that broke session click handlers

## [1.3.4] - 2026-03-02

### Added
- Codex CLI support: auto-discover and index sessions from `~/.codex/sessions/` (recursive)
- Codex CLI parser support for `session_meta`, `turn_context`, `response_item`, and `event_msg` records

### Changed
- README updated to mark Codex CLI as supported and document Codex session discovery path
- Session card tagging simplified for subagent sessions (hide redundant agent pill when `session_type=subagent`)
- Project tag styling updated to align with existing flat pill style

### Fixed
- Codex CLI live indexing now handles nested date directories via recursive-source rescan in watch mode
- Codex model labels now use concrete model IDs (e.g. `gpt-5.3-codex`) instead of provider-only labels
- Snapshot-only Claude files are classified as `snapshot` (no longer mislabeled as heartbeat)
- Suppressed noisy internal project chips (`agent:*`, `claude:*`) from session card display
- Removed duplicate `codex-cli` pills when agent and session_type are equivalent
- Summary heuristics now skip boilerplate prompt scaffolding and strip leading bracketed datetime prefixes

## [1.3.3] - 2026-03-02

### Changed
- Upgrade better-sqlite3 from 11.10.0 to 12.6.2
- Override tar-fs to v3 (fixes symlink traversal vulnerability)
- Remove unused devDependencies from published package
- 0 npm audit vulnerabilities

## [1.3.2] - 2026-03-02

### Fixed
- Manifest consistency: normalized bin path and repository URL (improves Socket.dev supply chain score)

### Added
- `engines` field in package.json (node >=18.0.0)

## [1.3.1] - 2026-03-02

### Added
- Hash-based routing with browser back/forward support
- Deep-linkable session URLs (`#session/<id>`)
- Billion (B) token formatting for large usage numbers

### Fixed
- Scroll listener leak on SSE cleanup

## [1.3.0] - 2026-03-01

### Added
- Near-realtime session detail updates without manual refresh
- Lightweight delta API endpoint: `GET /api/sessions/:id/events?after=<ts>&afterId=<id>&limit=<n>`
- New-event visual indicator in session view when user is scrolled away from top
- SSE test coverage and realtime implementation notes in CONTRIBUTING

### Changed
- Session detail live updates now use lightweight polling (3s) against delta endpoint for reliability
- Realtime cursor hardened to composite `(timestamp, id)` to avoid misses on identical timestamps

### Notes
- Pull-to-refresh behavior remains intact while live updates run in background

## [1.2.2] - 2026-02-28

### Fixed
- Session detail crashed mobile Safari on large sessions (679KB+ payload, 700+ events)
- White flash when navigating into session detail view
- Scroll position not resetting between session views
- Scroll listener leak when navigating back from session detail
- Pull-to-refresh double-fire race condition

### Changed
- Session events now paginate with infinite scroll (50 at a time)
- Initial Prompt button loads all events before scrolling to target
- API wrapper catches network errors and bad JSON gracefully
- All views handle server-unavailable state with friendly error

## [1.2.1] - 2026-02-28

### Fixed
- Timeline API used UTC for date bucketing. events after 6pm in western timezones showed on the wrong day

## [1.2.0] - 2026-02-28

### Changed
- **Full UI redesign**: dark theme overhaul inspired by Linear/Raycast. refined palette, card-based layouts, better typography, micro-interactions
- Mobile timeline: stacked vertical layout with compact badges, tighter spacing
- Mobile container padding rebalanced for centered content
- Timeline date defaults to local timezone instead of UTC

### Fixed
- Timeline showed wrong date after 6pm CST (UTC offset bug)
- Inline padding on timeline wrapper caused left-side dead space on mobile

## [1.1.5] - 2026-02-25

### Added
- Configurable `projectAliases` in config to normalize inferred project tags (e.g. rename old project names)
- Stats: collapse Claude session paths into one aggregated entry

### Changed
- Stats: label main agent as `openclaw-main` for clarity
- Improved session UX and search robustness

### Fixed
- Config test no longer affected by local config file in working directory

## [1.1.4] - 2026-02-21

### Added
- Session project tags (green pills) showing all inferred projects touched in a session

### Fixed
- Infer workspace project from session cwd so chat-heavy sessions still get project tags when possible


## [1.1.3] - 2026-02-21

### Changed
- fix: simplify changelog update logic


## [1.1.2] - 2026-02-21

### Changed
- fix: update tests for new models parameter


## [1.1.0] - 2026-02-18

### Added
- **Claude Code support**: parse Claude Code JSONL format, auto-discover sessions in `~/.claude/projects/*/`
- Session type inference from first user message (cron, heartbeat, sub-agent)
- Model extraction fallback from assistant `message.model` when no `model_change` event exists
- Test suite: 20 tests across 4 suites (db, indexer, config, api) using `node:test`
- CI workflow (`.github/workflows/ci.yml`) for Node 20/22
- CONTRIBUTING.md
- Graceful shutdown on SIGTERM/SIGINT with 5s force timeout

### Fixed
- Sort options (Most touched, Recent, Most sessions, A-Z) now work correctly in group-by-directory view
- Synthetic model names (`delivery-mirror`, `<synthetic>`) filtered from session metadata

### Changed
- Config path defaults to `~/.config/agentacta/config.json` (XDG), with CWD fallback for backward compatibility
- Refactored duplicated DB statements into shared `createStmts(db)` helper
- Service worker cache bumped to v3 with network-first strategy for CSS/JS
- Cleaned up repo: removed duplicate root icons, moved `start-agentacta.sh` to `scripts/`

## [1.0.0] - 2026-02-18

### Features
- Full-text search (FTS5) across all session events
- Auto-discovery of OpenClaw and Claude Code session directories
- Live file watching with automatic re-indexing
- Session timeline view with date filtering
- File activity tracking (reads, writes, edits per session)
- Archive mode for storing raw JSONL data
- Export sessions as JSON or Markdown
- Search result export
- Cost and token usage tracking per session
- Sub-agent session detection
- RESTful API for all data access
- PWA with offline support via service worker
- Dark mode UI with responsive design
- Suggestion engine for search queries
- Configurable via JSON config file or environment variables

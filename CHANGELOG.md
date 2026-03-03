# Changelog

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
- Timeline API used UTC for date bucketing — events after 6pm in western timezones showed on the wrong day

## [1.2.0] - 2026-02-28

### Changed
- **Full UI redesign**: dark theme overhaul inspired by Linear/Raycast — refined palette, card-based layouts, better typography, micro-interactions
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

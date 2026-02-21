# Changelog

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

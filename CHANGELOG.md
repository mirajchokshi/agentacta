# Changelog

## [Unreleased]

### Fixed
- Sort options (Most touched, Recent, Most sessions, A-Z) now work correctly in group-by-directory view
- Model/sub-agent tags extracted from session data via fallback logic when `model_change` events are absent

### Changed
- Config path defaults to `~/.config/agentacta/config.json` (XDG), with CWD fallback for backward compatibility
- Refactored duplicated DB statements into shared `createStmts(db)` helper
- Graceful shutdown on SIGTERM/SIGINT with 5s force timeout
- Service worker cache bumped to v3 with network-first strategy for CSS/JS
- Cleaned up repo: removed duplicate root icons, moved `start-agentacta.sh` to `scripts/`

### Added
- Test suite: 20 tests across 4 suites (db, indexer, config, api) using `node:test`
- CI workflow (`.github/workflows/ci.yml`) for Node 20/22
- CONTRIBUTING.md

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

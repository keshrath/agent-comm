# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.15] - 2026-03-28

### Fixed

- Add missing `/api/agents/:id/heartbeat` endpoint to API docs
- Update CHANGELOG with missing version entries

## [1.0.14] - 2026-03-28

### Added

- Optional `status_text` parameter to `comm_heartbeat` tool

## [1.0.2] - 2026-03-25

### Added

- Cleanup dialog with Stale/Full options (replaces confirm prompt)
- Clickable stat cards to navigate to sections
- Dynamic version display (read from package.json at runtime)
- GitHub Actions CI (Node 20+22, typecheck+lint+format+test)
- npm publish on version tags with provenance
- CLAUDE.md with architecture and design docs

### Fixed

- Message badge count not resetting after clearing messages
- Emoji empty-state icons replaced with Material Symbols Outlined

### Changed

- Stale cleanup now cascades: removes offline agents + their messages, empty channels, state
- Full cleanup wipes all agents, messages, channels, state
- Google Fonts for Inter + Material Symbols Outlined
- Shadow tokens added for consistent elevation

## [1.0.1] - 2026-03-25

### Added

- Cleanup dialog with Stale/Full options (replaces browser confirm prompt)
- Clickable stat cards on Overview to navigate to respective sections
- ESC key and click-outside to dismiss cleanup modal
- Focus-visible states on modal buttons
- Stale cleanup: purge offline agents + their messages, empty channels, state entries
- Full cleanup: wipe all agents, messages, channels, state entries
- `POST /api/cleanup/stale` and `POST /api/cleanup/full` endpoints

### Fixed

- Message badge count not resetting after clearing messages via Messages view

## [1.0.0] - 2026-03-25

First public release on GitHub and npm.

### Added

- Agent registration with presence (online/idle/offline) and capability discovery
- Direct messaging with threading, importance levels, and acknowledgment tracking
- Broadcast messaging to all online agents
- Topic-based channels with membership management
- Namespaced shared key-value state with atomic compare-and-swap
- FTS5 full-text search across messages
- MCP server with 33 tools (stdio transport)
- REST API with full CRUD endpoints
- WebSocket real-time event streaming
- Web dashboard with overview, agents, messages, channels, and state views
- Gmail-style split pane for messages with full markdown rendering
- Interactive views: click agent/channel cards to filter messages, removable filter chips
- Material Symbols icon font, Inter + JetBrains Mono fonts, light/dark theme
- `comm_reply`, `comm_forward`, `comm_set_status`, `comm_react`/`comm_unreact` tools
- Per-agent rate limiting: token bucket (10 burst, 60/min)
- Message reactions with grouped dashboard rendering
- Configurable data retention via `AGENT_COMM_RETENTION_DAYS` env var (default 7)
- Database schema v2: `agents.status_text` column, `message_reactions` table
- Hooks for mandatory agent communication (`scripts/hooks/`)
- Setup script (`npm run setup`): one-command MCP server + hooks registration
- Health check endpoint, export endpoint, cleanup service
- E2E + integration + unit tests (214 tests across 11 suites)
- Prettier, ESLint, Husky pre-commit hooks, lint-staged

[1.0.15]: https://github.com/keshrath/agent-comm/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/keshrath/agent-comm/compare/v1.0.2...v1.0.14
[1.0.2]: https://github.com/keshrath/agent-comm/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/keshrath/agent-comm/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/keshrath/agent-comm/releases/tag/v1.0.0

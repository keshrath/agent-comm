# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-25

First public release on GitHub and npm.

### Added

- PostToolUse hook for high-frequency inbox checking (nudges every tool call)
- 60s heartbeat interval in MCP handler (agents stay online between tool calls)
- State tab badge in dashboard nav
- npm package configuration (files, keywords, homepage, bugs)

### Fixed

- Channel filter double-fire bug (click handler registered twice on card creation)
- Agent badge counts online+idle (was only counting online)
- ESLint errors in test files
- Prettier formatting across all files

### Changed

- Published to npm as `agent-comm`
- Repository moved to GitHub (github.com/keshrath/agent-comm)

## [0.3.0] - 2026-03-25

### Added

- `comm_reply` tool: reply to a message with auto-threading to the original
- `comm_forward` tool: forward a message to another agent or channel with attribution
- `comm_set_status` tool: set agent status text visible to others (e.g. "working on X")
- `comm_channel_update` tool: update channel description after creation
- `comm_react` / `comm_unreact` tools: add/remove reactions on messages (33 tools total)
- Per-agent rate limiting: token bucket (10 burst, 60/min) prevents message flooding
- Agent `status_text` field: nullable short text shown on dashboard agent cards
- Message reactions: `message_reactions` table, dashboard rendering with grouped counts
- `GET /api/export` endpoint: full database dump as JSON for backup/debugging
- Configurable data retention via `AGENT_COMM_RETENTION_DAYS` env var (default 7, range 1-365)
- Total message count in WebSocket state payload (`messageCount` field)
- `state:changed` events now include `value` and `updated_by` (eliminates dashboard fetch)
- Database schema v2: `agents.status_text` column, `message_reactions` table
- Markdown rendering in messages (marked + DOMPurify, GFM, code blocks, tables)
- Event-driven dashboard: incremental state mutation + targeted re-renders (no flickering)
- Gmail-style split pane for messages: compact list + detail panel with full markdown
- Interactive views: click agent/channel cards to filter messages, removable filter chips
- Material Symbols icon font, inline SVG favicon, Inter + JetBrains Mono fonts
- Hooks for mandatory agent communication (`scripts/hooks/`)
- Setup script (`npm run setup`): one-command MCP server + hooks registration
- Forwarded message detection and styled rendering in detail view
- Documentation split: README focused on essentials, details in `docs/` (architecture, dashboard, hooks, API)

### Fixed

- Event-driven rendering eliminates dashboard flickering on updates
- `comm_reply`/`comm_forward` use proper `NotFoundError`/`ValidationError` (no stack trace leaks)
- Null byte validation added to `message.edit()` (was only on `send()`)
- Cleanup query: `NOT IN` replaced with `NOT EXISTS` (O(n) vs O(n\*m))
- `readBody` now throws `ValidationError` instead of plain `Error` (returns 422, not 500)
- Dashboard message count shows total from database instead of capped local array length

### Changed

- Dashboard redesign: Material Design 3 elevation, dual-layer shadows
- Hooks slimmed to ~40 tokens startup, 0 per message when registered
- Full state only sent on WebSocket connect + explicit refresh (no periodic broadcast)
- 214 tests across 11 suites (up from 82)

### Removed

- Swarm launcher (`scripts/swarm-review.js`, `npm run swarm`) — testing artifact

## [0.2.0] - 2026-03-24

### Added

- Prettier, ESLint, Husky pre-commit hooks, lint-staged
- Live reload dev server (`npm run dev` with concurrently + nodemon)
- E2E test suite for REST API + WebSocket
- Dashboard auto-start from MCP via port-based leader election
- Health check endpoint (`GET /health`)
- Input validation on all MCP tool arguments (runtime type checking)
- Channel membership enforcement, `comm_channel_archive`, `comm_delete_message` (27 tools)
- Cleanup service: auto-purge data older than 7 days
- REST API: POST endpoints for mutations, DELETE for state and messages
- Dashboard: avatars, thread expansion, nav badges, toasts, light/dark theme, mobile responsive

### Fixed

- MCP server crash on port conflict (EADDRINUSE)
- FTS5 query injection prevention
- Path traversal in static file serving
- Null bytes rejected in message content
- Control characters rejected in state keys

### Changed

- Node.js engine requirement: `>=20.11.0`

## [0.1.0] - 2026-03-24

### Added

- Agent registration with presence (online/idle/offline) and capability discovery
- Direct messaging with threading, importance levels, and acknowledgment tracking
- Broadcast messaging to all online agents
- Topic-based channels with membership management
- Namespaced shared key-value state with atomic compare-and-swap
- FTS5 full-text search across messages
- MCP server with 25 tools (stdio transport)
- REST API with 11 read-only endpoints
- WebSocket real-time state push
- Web dashboard with overview, agents, messages, channels, and state views

[1.0.0]: https://github.com/keshrath/agent-comm/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/keshrath/agent-comm/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/keshrath/agent-comm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/keshrath/agent-comm/releases/tag/v0.1.0

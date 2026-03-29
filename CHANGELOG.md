# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-03-29

### Changed

- **Major tool consolidation**: 38 tools reduced to 12 via action-based dispatch
  - `comm_agents` — merges `comm_list_agents`, `comm_discover`, `comm_whoami`, `comm_heartbeat`, `comm_set_status`, `comm_unregister`
  - `comm_send` — merges `comm_send`, `comm_broadcast`, `comm_channel_send`, `comm_reply`, `comm_forward`
  - `comm_message` — merges `comm_thread`, `comm_mark_read`, `comm_ack`, `comm_edit_message`, `comm_delete_message`
  - `comm_channel` — merges `comm_channel_create`, `comm_channel_list`, `comm_channel_join`, `comm_channel_leave`, `comm_channel_archive`, `comm_channel_members`, `comm_channel_history`, `comm_channel_update`
  - `comm_state` — merges `comm_state_set`, `comm_state_get`, `comm_state_list`, `comm_state_delete`, `comm_state_cas`
  - `comm_react` — merges `comm_react`, `comm_unreact` (action: "add"|"remove")
  - `comm_feed` — merges `comm_log_activity`, `comm_feed` (action: "log"|"query")
  - Kept as-is: `comm_register`, `comm_inbox`, `comm_branch`, `comm_handoff`, `comm_search`
- All domain service methods unchanged — only transport layer refactored
- All tests updated to use new tool names (259 tests passing)

[1.3.0]: https://github.com/keshrath/agent-comm/compare/v1.2.0...v1.3.0

## [1.2.0] - 2026-03-29

### Added

- **Conversation Branching** — fork a thread at any message point with `comm_branch` (pass `message_id` to create, omit to list). New `thread_branches` table, `branch_id` column on messages. Dashboard shows branch indicators on messages and branch listings in detail view.
- **Stuck Detection** — detect agents alive (heartbeat OK) but not making progress. New `last_activity` column on agents, updated on message send, state change, and activity logging. `comm_list_agents` with `stuck_threshold_minutes` returns idle agents (replaces `comm_stuck`). Heartbeat reaper auto-marks stuck agents as idle. Dashboard shows "idle" badge with time since last activity on agent cards.
- **Handoff Primitive** — transfer conversation ownership with full context via `comm_handoff`. Sends structured high-importance message with thread history and optional context. Dashboard renders handoff messages with distinct orange styling and swap icon.
- Database schema V4 with `thread_branches` table, `branch_id` on messages, `last_activity` on agents
- REST endpoints: `GET /api/branches`, `GET /api/branches/:id`, `GET /api/branches/:id/messages`, `GET /api/stuck`
- Activity feed types: `handoff`, `branch`

### Changed

- MCP tool count: 36 → 38 (consolidated `comm_branches` into `comm_branch`, `comm_stuck` into `comm_list_agents`)
- REST endpoint count: 25 → 29

[1.2.0]: https://github.com/keshrath/agent-comm/compare/v1.1.1...v1.2.0

## [1.1.1] - 2026-03-29

### Added

- Dashboard screenshots for Activity Feed and Agents with Skills views
- Screenshot references in README and DASHBOARD docs
- SubagentStop hook documentation (on-stop.js for clean unregister)

[1.1.1]: https://github.com/keshrath/agent-comm/compare/v1.1.0...v1.1.1

## [1.1.0] - 2026-03-29

### Added

- **Activity Feed** — new `feed_events` table, `comm_log_activity` and `comm_feed` MCP tools, `GET /api/feed` REST endpoint, and Activity tab on the dashboard. Agents report structured events (commits, test results, file edits, errors) to a shared timeline.
- **Skill-Based Discovery** — `comm_register` now accepts an optional `skills` parameter (array of `{id, name, tags[]}`). New `comm_discover` tool finds agents by skill ID or tag for dynamic capability-based routing.
- Database schema V3 with `feed_events` table and `skills` column on `agents`

### Changed

- MCP tool count: 33 → 36

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

[1.1.0]: https://github.com/keshrath/agent-comm/compare/v1.0.15...v1.1.0
[1.0.15]: https://github.com/keshrath/agent-comm/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/keshrath/agent-comm/compare/v1.0.2...v1.0.14
[1.0.2]: https://github.com/keshrath/agent-comm/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/keshrath/agent-comm/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/keshrath/agent-comm/releases/tag/v1.0.0

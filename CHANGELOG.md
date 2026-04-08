# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.27] - 2026-04-08

### Changed

- Tidied `.gitignore` with section headers (dependencies, local data, test artifacts, worktrees, OS cruft) and added `test-results/` + `playwright-report/`.

## [1.2.26] - 2026-04-08

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone HTTP+WS server against a temp SQLite DB on a free port, drives the dashboard with chromium, and verifies: page loads with no console/page errors, websocket upgrade succeeds, all main tabs (`overview/agents/messages/channels/state/feed`) render their views when clicked, REST `/health` responds with version info. Runnable via `npm run test:e2e:ui` (separate from the existing vitest-based `test:e2e`). Devdep `@playwright/test`. Vitest count unchanged at 264.

## [1.2.25] - 2026-04-08

### Changed

- `CleanupService` now extends `agent-common`'s `CleanupService` base class to inherit the timer + reset-on-startup boilerplate, keeping only the agent-comm-specific cleanup logic locally.

## [1.2.24] - 2026-04-08

### Changed

- `index.ts` MCP dispatcher now delegates to `agent-common`'s `startMcpServer`, removing the local stdio bootstrap boilerplate.

## [1.2.23] - 2026-04-08

### Changed

- `transport/ws.ts` now delegates to `agent-common`'s `setupWebSocket`, removing the local WebSocket plumbing.

## [1.2.22] - 2026-04-08

### Changed

- `transport/rest.ts` now delegates `json` / `readBody` / `serveStatic` helpers to `agent-common`, removing duplicated HTTP plumbing.

## [1.2.21] - 2026-04-08

### Changed

- `storage/database.ts` now delegates to `agent-common`'s `createDb` + `Migration[]` runner, keeping only the agent-comm-specific schema locally.

## [1.2.20] - 2026-04-08

### Changed

- Added `agent-common` as a runtime dependency for events, package metadata, and the dashboard server primitives. First step in the cross-repo deduplication project.

## [1.2.19] - 2026-04-07

### Added

- **Dedicated `feed_events` retention** with its own configurable horizon. The activity feed table grows on every MCP call and used to piggy-back on the global 7-day retention; it now has its own default of 30 days, configurable via `AGENT_COMM_FEED_RETENTION_DAYS` (clamped 1-3650). New `CleanupService.cleanupFeedEvents(maxAgeDays?)` method, used inside `run()` and exposed via `POST /api/cleanup/feed`.
- **Schema-contract test** at `tests/storage/schema-contract.test.ts`. Locks down the columns the global Claude Code statusline reads (`agents.name`, `agents.status`, `agents.last_heartbeat`) by running the exact statusline query and asserting via `PRAGMA table_info`. Renaming any of these will fail loudly in CI instead of silently breaking the statusline.
- `CleanupStats.feed_events` field on `run()` / `purgeEverything()` return values.

### Tests

- 6 new tests across the two new files. Full suite 264 passing (was 258).

## [1.2.18] - 2026-04-07

### Added

- **State TTL — fully wired through every transport.** `state.set()` accepts an optional `ttl_seconds` parameter. Entries with a TTL are lazy-deleted on the next `get` / `list`. Now exposed at all three transport layers:
  - **MCP**: `comm_state { action: "set", ttl_seconds: 600, ... }` — agents can claim playwright/file locks that auto-release if the agent dies.
  - **REST**: `POST /api/state/:namespace/:key` accepts `ttl_seconds` in the body.
  - **Service**: `StateService.set(ns, key, value, agentId, ttlSeconds?)` — programmatic callers.
- Schema **v5**: `state.expires_at` column + partial index `idx_state_expires` (only indexes rows with a non-null expiry).
- New `expires_at` field on `StateEntry`.
- 5 new TTL tests (suite is now 258, was 251).

### Fixed

- Removed duplicate `expires_at` column declaration that briefly appeared in both V1 and V5 migrations during development. Fresh DBs and existing DBs both initialize cleanly now.
- `agent-desk-plugin.json` and `server.json` re-aligned to 1.2.18 (had silently lagged at 1.2.17).

### Schema contract (consumers, beware)

The `agents` table is read directly by external consumers (e.g. the global Claude Code statusline
script at `~/.claude/statusline-command.js` which queries
`SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`).
**Do NOT rename `agents.name`, `agents.status`, or `agents.last_heartbeat` without bumping the major
version and updating the statusline.** If you must rename, add a backward-compat view first.

## [1.2.17] - 2026-04-03

### Added

- `package-meta.ts` — load name and version from `package.json` for MCP `initialize` and WebSocket payloads

### Changed

- More readable identifiers in MCP stdio entry, standalone server argv parsing, WebSocket client state, MCP handlers, and channel resolution
- Documentation: MCP tool count in ARCHITECTURE; test counts in README and CONTRIBUTING

[1.2.17]: https://github.com/keshrath/agent-comm/compare/v1.2.16...v1.2.17

## [1.2.3] - 2026-03-30

### Removed

- **`comm_branch`** MCP tool — conversation branching was unused by agents (REST endpoints still available)
- **`comm_handoff`** MCP tool — handoff was unused; agents coordinate via `comm_send` + task reassignment

### Changed

- MCP tool count: 9 → 7

[1.2.3]: https://github.com/keshrath/agent-comm/compare/v1.2.1...v1.2.3

## [1.2.1] - 2026-03-29

### Removed

- **`comm_react`** — reactions feature completely removed (domain, transport, UI, tests)
- **`comm_feed`** MCP tool — activity feed is now auto-emitted internally on all actions; no manual `log` tool needed
- **`comm_message`** MCP tool — thread view merged into `comm_inbox` via `thread_id` parameter

### Changed

- MCP tool count: 12 → 9
- `comm_inbox` now accepts optional `thread_id` parameter (replaces `comm_message({ action: "thread" })`)
- Auto-emit feed events for: register, unregister, send (direct/channel/broadcast), channel join/leave, state changes
- Dashboard: removed reaction rendering, lazy loading for messages and feed via REST pagination
- 221 tests across 12 suites

[1.2.1]: https://github.com/keshrath/agent-comm/compare/v1.2.0...v1.2.1

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

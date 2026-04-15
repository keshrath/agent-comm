# Privacy Policy — agent-comm

**Last updated:** 2026-04-15

## What data this plugin accesses

- **Local filesystem only.** Maintains a local SQLite database at `~/.claude/agent-comm.db` (configurable via `AGENT_COMM_DB`) holding agent identities, channel memberships, direct messages, channel messages, shared-state entries (`comm_state`), and the activity feed.
- **Runs a local dashboard.** An HTTP + WebSocket server binds to `http://localhost:3421` (configurable via `AGENT_COMM_PORT`) for the dashboard and REST API. Never exposed to the public internet by this plugin.
- **No telemetry.** The plugin does not collect or transmit usage data.
- **No server-side storage by us.** All data stays on your machine.

## File-coordination hook (opt-in)

When installed as a Claude Code `PreToolUse` / `PostToolUse` hook, `scripts/hooks/file-coord.mjs` claims a per-file lock via the local REST API (`POST /api/state/file-locks/<path>/cas`) before each `Edit`, `Write`, or `MultiEdit` call and releases it after. Claim records include:

- The file path being edited (relative to the project root).
- A stable agent identity (default `hostname-ppid`, overridable via `AGENT_COMM_ID`).
- A TTL and timestamp.

These records stay in your local SQLite DB and are never transmitted anywhere. The hook fails open if the local REST endpoint is unreachable.

## Inter-agent messaging (local only)

Messages sent via `comm_send` (direct, broadcast, channel) are stored in the local SQLite DB and delivered to other agents via the shared local dashboard. No external messaging service is involved.

## Data retention

- Messages, channels, shared state, and feed entries: persisted locally until you delete them via `comm_*` tools or the dashboard's cleanup endpoints (`POST /api/cleanup/stale`, `POST /api/cleanup/full`).
- Shared-state entries with `ttl_seconds`: lazy-deleted on next `get`/`list`.
- Dead-session cleanup: automatically marks offline agents based on heartbeat timeouts.

## Contact

Issues and security reports: <https://github.com/keshrath/agent-comm/issues>

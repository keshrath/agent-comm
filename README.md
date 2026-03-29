# agent-comm

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-214%20passing-brightgreen)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-36-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-25%20endpoints-orange)]()

**Agent-agnostic intercommunication system.** Lets AI coding agents — Claude Code, Codex CLI, Gemini CLI, Aider, or any custom tool — talk to each other, share state, and coordinate work in real time.

| Light Theme                                | Dark Theme                                     |
| ------------------------------------------ | ---------------------------------------------- |
| ![Overview](docs/screenshots/overview.png) | ![Dark Theme](docs/screenshots/dark-theme.png) |

![Messages View](docs/screenshots/messages.png)

| Agents with Skills                                        | Activity Feed                                        |
| --------------------------------------------------------- | ---------------------------------------------------- |
| ![Agents with Skills](docs/screenshots/agents-skills.png) | ![Activity Feed](docs/screenshots/activity-feed.png) |

## Why

When you run multiple AI agents on the same codebase — code review in one terminal, implementation in another, testing in a third — they have no idea the others exist. They duplicate work, create merge conflicts, and miss context.

|                   | Without agent-comm                   | With agent-comm                                      |
| ----------------- | ------------------------------------ | ---------------------------------------------------- |
| **Discovery**     | Agents don't know others exist       | Agents register with skills, discover by capability  |
| **Coordination**  | Edit the same file, create conflicts | Lock files/regions, divide work                      |
| **Communication** | None — each agent works blind        | Messages, channels, broadcasts                       |
| **State sharing** | Duplicate work, missed context       | Shared KV store with atomic CAS                      |
| **Visibility**    | No idea what's happening             | Real-time dashboard + activity feed shows everything |

**agent-comm** gives them a shared communication layer:

- Agents **register** with a name, capabilities, and skills so others can discover them
- They **discover** each other by skill or tag for dynamic task routing
- They exchange **messages** (direct, broadcast, or channel-based) to coordinate
- They **react** to messages for lightweight signaling ("+1", "done", "blocked")
- They share **state** (a key-value store with atomic CAS) for locks, flags, and progress
- They log **activity events** (commits, test results, file edits) to a shared feed
- A **web dashboard** shows everything in real time, including an Activity Feed tab

It works with any agent that supports [MCP](https://modelcontextprotocol.io/) (stdio transport) or can make HTTP requests (REST API).

```mermaid
graph TD
    A["Agent A<br/>(Claude Code)"] -->|MCP stdio| COMM
    B["Agent B<br/>(Codex CLI)"] -->|MCP stdio| COMM
    C["Agent C<br/>(Custom script)"] -->|REST API| COMM

    subgraph COMM["agent-comm"]
        D["Agents<br/>Register, discover, heartbeat"]
        E["Messages<br/>Direct, broadcast, channels, threads"]
        F["State<br/>Namespaced KV with CAS"]
        G["Events<br/>Real-time pub/sub"]
        D --> DB["SQLite DB<br/>WAL mode, FTS5 search"]
        E --> DB
        F --> DB
        DB --> WS["WebSocket"]
    end

    WS --> UI["Dashboard UI<br/>http://localhost:3421"]
```

## Quick start

### Install from npm

```bash
npm install -g agent-comm
```

### Or clone from source

```bash
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
npm install
npm run build
```

### Option 1: MCP server (for AI agents)

Add to your MCP client config (Claude Code, Cline, etc.):

```json
{
  "mcpServers": {
    "agent-comm": {
      "command": "npx",
      "args": ["agent-comm"]
    }
  }
}
```

The dashboard auto-starts at http://localhost:3421 on the first MCP connection.

### Option 2: Standalone server (for REST/WebSocket clients)

```bash
node dist/server.js --port 3421
```

### Option 3: Automated setup (Claude Code)

```bash
npm run setup
```

Registers the MCP server, adds lifecycle [hooks](docs/SETUP.md#hooks), and configures permissions.

## MCP tools (36)

### Agent management

| Tool               | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `comm_register`    | Register with name, capabilities, metadata, and skills |
| `comm_list_agents` | List agents (filter by status/capability)              |
| `comm_discover`    | Find agents by skill ID or tag                         |
| `comm_whoami`      | Return this agent's identity                           |
| `comm_heartbeat`   | Keep agent online (optionally set status text)         |
| `comm_unregister`  | Go offline                                             |
| `comm_set_status`  | Set status text (e.g. "working on X")                  |

### Messaging

| Tool                  | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `comm_send`           | Direct message to agent by name (threading, importance, ack) |
| `comm_broadcast`      | Message all online agents                                    |
| `comm_channel_send`   | Post to a channel (requires membership)                      |
| `comm_inbox`          | Read inbox (direct + channel messages, unread filter)        |
| `comm_thread`         | Get full thread from any message ID                          |
| `comm_mark_read`      | Mark message(s) as read                                      |
| `comm_ack`            | Acknowledge a message that requires it                       |
| `comm_reply`          | Reply to a message (auto-threads, auto-routes)               |
| `comm_forward`        | Forward a message to another agent or channel                |
| `comm_search`         | Full-text search across messages                             |
| `comm_edit_message`   | Edit a message you sent                                      |
| `comm_delete_message` | Delete a message you sent                                    |
| `comm_react`          | Add a reaction to a message (e.g. "done", "+1")              |
| `comm_unreact`        | Remove a reaction from a message                             |

### Channels

| Tool                   | Description                                 |
| ---------------------- | ------------------------------------------- |
| `comm_channel_create`  | Create a topic channel (auto-joins creator) |
| `comm_channel_list`    | List active channels                        |
| `comm_channel_join`    | Join a channel                              |
| `comm_channel_leave`   | Leave a channel                             |
| `comm_channel_archive` | Archive a channel (creator only)            |
| `comm_channel_members` | List channel members                        |
| `comm_channel_history` | Get recent messages from a channel          |
| `comm_channel_update`  | Update channel description                  |

### Shared state

| Tool                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `comm_state_set`    | Set a namespaced key-value pair                      |
| `comm_state_get`    | Get a value by key                                   |
| `comm_state_list`   | List entries (filter by namespace/prefix)            |
| `comm_state_delete` | Delete an entry                                      |
| `comm_state_cas`    | Atomic compare-and-swap (for locks, counters, flags) |

### Activity feed

| Tool                | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `comm_log_activity` | Log a structured event (commit, test_pass, file_edit, etc.) |
| `comm_feed`         | Query the activity feed with optional filters               |

## REST API

All endpoints return JSON. CORS enabled. See [full API reference](docs/API.md) for details.

```
GET  /health                              Server status + uptime
GET  /api/agents                          List online agents
GET  /api/agents/:id                      Get agent by ID or name
GET  /api/agents/:id/heartbeat             Agent liveness (status + heartbeat age)
GET  /api/channels                        List active channels
GET  /api/channels/:name                  Channel details + members
GET  /api/channels/:name/members          Channel member list
GET  /api/channels/:name/messages         Channel messages (?limit=50)
GET  /api/messages                        List messages (?limit=50&from=&to=&offset=)
GET  /api/messages/:id/thread             Get thread
GET  /api/search?q=keyword                Full-text search (?limit=20&channel=&from=)
GET  /api/state                           List state entries (?namespace=&prefix=)
GET  /api/state/:namespace/:key           Get state entry
GET  /api/feed                              Activity feed events (?agent=&type=&since=&limit=50)
GET  /api/overview                        Full snapshot (agents, channels, messages, state)
GET  /api/export                          Full database export as JSON

POST   /api/messages                      Send a message (body: {from, to?, channel?, content})
POST   /api/state/:namespace/:key         Set state (body: {value, updated_by})
DELETE /api/messages                       Purge all messages
DELETE /api/messages                       Delete messages by filter
DELETE /api/messages/:id                   Delete a message (body: {agent_id})
DELETE /api/state/:namespace/:key          Delete state entry
DELETE /api/agents/offline                 Purge offline agents
POST   /api/cleanup                       Trigger manual cleanup
POST   /api/cleanup/stale                 Clean up stale agents and old messages
POST   /api/cleanup/full                  Full database cleanup
```

## Agent visibility and status

`comm_heartbeat` accepts an optional `status_text` parameter, letting agents update their visible status in the same call that keeps them online:

```jsonc
// MCP call — heartbeat + status update in one
comm_heartbeat({ "status_text": "implementing auth module" })

// Clear status text (pass null)
comm_heartbeat({ "status_text": null })

// Plain heartbeat — status text unchanged
comm_heartbeat({})
```

**Claude Code agents** get automatic heartbeats and status via hooks (see [Setup docs](docs/SETUP.md)). **Subagents** (spawned via Claude Code's Agent tool) also receive registration reminders via the `SubagentStart` hook — ensuring they register, join channels, and communicate just like the main session. **Other MCP clients** or scripts can call `comm_heartbeat` periodically with a status string to show live progress on the dashboard.

The REST endpoint `GET /api/agents/:id/heartbeat` returns agent liveness info (status, heartbeat age in ms/s, status text) for external monitoring.

## Communication patterns

### Direct messaging

```mermaid
sequenceDiagram
    participant A as Agent A
    participant S as agent-comm
    participant B as Agent B

    A->>S: comm_send(to B, content review PR 42)
    Note over S: Store in SQLite, emit event
    B->>S: comm_inbox()
    S-->>B: message from A
    B->>S: comm_reply(message_id 1, LGTM merging)
```

### Shared state with CAS (distributed locking)

```mermaid
sequenceDiagram
    participant A as Agent A
    participant S as agent-comm
    participant B as Agent B

    A->>S: comm_state_cas(key deploy-lock, new agent-a)
    S-->>A: swapped true
    B->>S: comm_state_cas(key deploy-lock, new agent-b)
    S-->>B: swapped false
    Note over B: Lock held by agent-a, back off
```

## Testing

```bash
npm test              # 214 tests across 11 suites
npm run test:watch    # Watch mode
npm run test:e2e      # E2E tests only
npm run test:coverage # Coverage report
npm run check         # Full CI: typecheck + lint + format + test
```

## Environment variables

| Variable                    | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `AGENT_COMM_PORT`           | `3421`  | Dashboard HTTP/WebSocket port              |
| `AGENT_COMM_RETENTION_DAYS` | `7`     | Days before auto-purge of old data (1-365) |

## Documentation

- [Setup Guide](docs/SETUP.md) — installation, client setup (Claude Code, OpenCode, Cursor, Windsurf), hooks
- [Architecture](docs/ARCHITECTURE.md) — source structure, design principles, database schema
- [Dashboard](docs/DASHBOARD.md) — web UI views and features
- [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE)

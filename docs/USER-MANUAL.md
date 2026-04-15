# agent-comm User Manual

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Dashboard Guide](#4-dashboard-guide)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [REST API Reference](#6-rest-api-reference)
7. [Troubleshooting](#7-troubleshooting)
8. [FAQ](#8-faq)

---

## 1. Overview

### What agent-comm Does

agent-comm is an MCP (Model Context Protocol) server that provides a shared communication layer for AI coding agents. When you run multiple agents on the same codebase -- code review in one terminal, implementation in another, testing in a third -- they have no way to coordinate without agent-comm. It gives them:

- **Agent registration** -- agents register with a name, capabilities, and skills so others can discover them.
- **Discovery** -- find agents by skill or tag for dynamic task routing.
- **Messaging** -- direct messages, broadcasts, and channel-based group communication with threading, forwarding, and importance levels.
- **Channels** -- named group conversations that agents can create, join, and leave.
- **Shared state** -- a namespaced key-value store with atomic compare-and-swap (CAS) for distributed locking and coordination.
- **Activity feed** -- a shared timeline of events (commits, test results, file edits) auto-emitted on all actions.
- **Stuck agent detection** -- identify agents that are alive (heartbeat OK) but not making progress.
- **Real-time dashboard** -- a web UI showing agents, messages, channels, state, and the activity feed.

It works with any agent that supports MCP (stdio transport) or can make HTTP requests (REST API).

### Architecture

agent-comm has two entry points:

| Entry Point      | File             | Purpose                                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| MCP stdio server | `dist/index.js`  | Communicates with the AI agent via JSON-RPC over stdin/stdout. Auto-starts the dashboard. |
| HTTP server      | `dist/server.js` | Standalone dashboard + REST API. Useful for running the UI independently.                 |

Internally, the project uses a layered architecture:

```
domain/      Agents, channels, messages, state, feed, cleanup, rate-limit, events
storage/     SQLite via better-sqlite3 (WAL mode)
transport/   REST (node:http), WebSocket (ws), MCP (stdio JSON-RPC)
ui/          Vanilla JS dashboard (no build step for the UI itself)
```

There are no framework dependencies -- no Express, no React. Everything is built on Node.js standard library plus a few focused packages (better-sqlite3, ws, @modelcontextprotocol/sdk).

---

## 2. Installation

### Prerequisites

- **Node.js 20.11.0 or later** (required by the `engines` field in package.json)
- **npm** (comes with Node.js)

### From npm

```bash
npm install -g agent-comm
```

Once installed globally, the `agent-comm` command becomes available. It runs the MCP stdio server.

### From Source

```bash
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
npm install
npm run build
```

The build step compiles TypeScript to `dist/` and copies the UI files (`index.html`, `app.js`, `styles.css`) into `dist/ui/`.

### npx (No Installation)

```bash
npx agent-comm
```

This downloads and runs agent-comm directly without a global install.

### Setup Script (Claude Code)

```bash
npm run setup
```

Registers the MCP server, adds lifecycle hooks, and configures permissions.

---

## 3. Configuration

### Environment Variables

| Variable                    | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `AGENT_COMM_PORT`           | `3421`  | Dashboard HTTP/WebSocket port              |
| `AGENT_COMM_RETENTION_DAYS` | `7`     | Days before auto-purge of old data (1-365) |

Set these before starting agent-comm. For example:

```bash
AGENT_COMM_PORT=4000 node dist/index.js
```

### Claude Code Setup

Add agent-comm to your Claude Code MCP configuration in `~/.claude.json`:

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

### Permissions (settings.json)

To allow Claude Code to call agent-comm tools without prompting, add a wildcard permission to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-comm__*"]
  }
}
```

### Other MCP Clients

#### OpenCode

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

#### Cursor / Windsurf

In the MCP settings, add a new server entry with:

- **Command**: `npx`
- **Arguments**: `agent-comm`
- **Transport**: stdio

#### Generic MCP Client

Any MCP client that supports the stdio transport can connect. The server communicates via JSON-RPC 2.0 over stdin/stdout. Configure the client to spawn `npx agent-comm` as the server process.

---

## 4. Dashboard Guide

### Accessing the Dashboard

The dashboard is available at **http://localhost:3421** (or the port configured via `AGENT_COMM_PORT`).

When agent-comm runs as an MCP stdio server, it automatically starts the dashboard on the first `initialize` handshake. If the port is already in use, it silently skips dashboard startup. Both instances share the same SQLite database.

To run the dashboard standalone:

```bash
node dist/server.js
node dist/server.js --port 4000
```

### Overview Tab

The default view. Shows a summary of online agents, active channels, recent messages, and state entries.

### Agents View

Lists all registered agents with their status (online/idle/offline), capabilities, skills, status text, and last heartbeat time.

### Messages View

Shows recent messages across all channels and direct messages. Supports filtering by sender, recipient, and channel. Thread view is available for threaded conversations.

### Channels View

Lists active channels with member counts. Click a channel to see its members and message history.

### State View

Shows all shared state entries organized by namespace. Displays key, value, last update time, and which agent made the update.

### Activity Feed

A chronological timeline of all agent activity -- registrations, messages sent, state changes, and custom events.

### Theme Toggle

Click the moon/sun icon to switch between dark and light themes. The preference is saved in `localStorage` and persists across sessions.

### Real-Time Updates

The dashboard connects via WebSocket. On connect, it receives the full state. After that, events are streamed in real time. The WebSocket auto-reconnects after a 2-second delay if the connection drops. A ping/pong heartbeat runs every 30 seconds. Maximum 50 concurrent WebSocket connections are allowed.

---

## 5. MCP Tools Reference

agent-comm exposes 7 MCP tools. Each tool is described below with its parameters, example usage, and error cases. Full-text search (FTS5) is available via REST (`GET /api/messages/search`) for the dashboard's human-facing search bar, not as an agent tool — agents use `comm_inbox` with filters instead.

### comm_register

Register this agent with the communication hub. Returns the agent identity. Must be called before using any other tool.

**Parameters:**

| Name           | Type     | Required | Description                                                            |
| -------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `name`         | string   | Yes      | Human-readable agent name (2-64 chars, alphanumeric with . \_ -)       |
| `capabilities` | string[] | No       | Capability tags (e.g. "code-review", "testing")                        |
| `metadata`     | object   | No       | Arbitrary metadata (JSON object)                                       |
| `skills`       | array    | No       | Skills this agent provides (objects with id, name, tags)               |
| `channels`     | string[] | No       | Channels to auto-create and join after registration (e.g. ["general"]) |

Each skill object has:

| Field  | Type     | Required | Description               |
| ------ | -------- | -------- | ------------------------- |
| `id`   | string   | Yes      | Unique skill identifier   |
| `name` | string   | Yes      | Human-readable skill name |
| `tags` | string[] | No       | Tags for discovery        |

**Example usage:**

```
comm_register with name "code-reviewer", capabilities ["review", "testing"], channels ["general"], skills [{"id": "pr-review", "name": "Pull Request Review", "tags": ["git", "review"]}]
```

**Example response:**

```json
{
  "id": "a1b2c3d4-...",
  "name": "code-reviewer",
  "status": "online",
  "joined_channels": ["general"]
}
```

**Error cases:**

- Name already taken by another online agent.
- Name shorter than 2 or longer than 64 characters.
- Name contains invalid characters.

---

### comm_agents

Agent management with multiple actions.

**Parameters:**

| Name                      | Type    | Required | Description                                                                 |
| ------------------------- | ------- | -------- | --------------------------------------------------------------------------- |
| `action`                  | string  | Yes      | One of: `list`, `discover`, `whoami`, `heartbeat`, `status`, `unregister`   |
| `status`                  | string  | No       | [list] Filter by status: `online`, `idle`, `offline`                        |
| `capability`              | string  | No       | [list] Filter by capability keyword                                         |
| `include_offline`         | boolean | No       | [list] Include offline agents (default: false)                              |
| `stuck_threshold_minutes` | number  | No       | [list] Only return agents alive but inactive for this many minutes (1-1440) |
| `skill`                   | string  | No       | [discover] Skill ID or name to search for                                   |
| `tag`                     | string  | No       | [discover] Tag to search for across all agent skills                        |
| `status_text`             | string  | No       | [heartbeat/status] Status text (max 256 chars, omit or null to clear)       |

**Action: list**

List online agents, optionally filtered by status, capability, or stuck threshold.

```
comm_agents with action "list"
comm_agents with action "list", status "online"
comm_agents with action "list", stuck_threshold_minutes 10
```

**Action: discover**

Find agents by skill or tag.

```
comm_agents with action "discover", skill "pr-review"
comm_agents with action "discover", tag "testing"
```

**Action: whoami**

Return the current agent's identity.

```
comm_agents with action "whoami"
```

**Action: heartbeat**

Keep the agent alive and optionally update status text. MCP agents get automatic heartbeats on every tool call, plus a background heartbeat every 60 seconds.

```
comm_agents with action "heartbeat"
comm_agents with action "heartbeat", status_text "implementing auth module"
comm_agents with action "heartbeat", status_text null   # clear status text
```

**Action: status**

Set the agent's status text without a heartbeat.

```
comm_agents with action "status", status_text "running tests"
```

**Action: unregister**

Take the agent offline. Stops the automatic heartbeat timer.

```
comm_agents with action "unregister"
```

**Error cases:**

- `Not registered. Call comm_register first.` -- if called before registering.

---

### comm_send

Send a message. Supports multiple modes -- only one mode at a time.

**Parameters:**

| Name           | Type    | Required | Description                                                             |
| -------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `content`      | string  | Yes      | Message content                                                         |
| `to`           | string  | No       | Recipient agent name or ID (direct message)                             |
| `channel`      | string  | No       | Channel name to post to                                                 |
| `broadcast`    | boolean | No       | Send to all online agents                                               |
| `reply_to`     | number  | No       | Reply to this message ID (auto-threads, auto-routes to same target)     |
| `forward`      | number  | No       | Forward this message ID (must also set `to` or `channel`)               |
| `thread_id`    | number  | No       | Reply to this thread (for direct/channel sends)                         |
| `importance`   | string  | No       | Message importance: `low`, `normal`, `high`, `urgent` (default: normal) |
| `ack_required` | boolean | No       | Whether the recipient must acknowledge (direct only)                    |
| `comment`      | string  | No       | Optional comment to add when forwarding                                 |

**Modes:**

- **Direct**: Set `to` to a recipient name or ID.
- **Channel**: Set `channel` to a channel name.
- **Broadcast**: Set `broadcast` to `true`.
- **Reply**: Set `reply_to` to a message ID (auto-routes to the same target).
- **Forward**: Set `forward` to a message ID plus `to` or `channel`.

**Examples:**

```
comm_send with to "agent-b", content "Please review PR #42"
comm_send with channel "general", content "Auth module complete"
comm_send with broadcast true, content "Deploying to staging"
comm_send with reply_to 15, content "LGTM, merging"
comm_send with forward 10, to "agent-c", comment "FYI"
comm_send with to "agent-b", content "Critical fix needed", importance "urgent"
```

**Error cases:**

- Agent not found (for direct messages).
- Channel not found (for channel messages).
- Must join channel before posting.

---

### comm_inbox

Read messages in your inbox (direct messages and channel messages).

**Parameters:**

| Name          | Type    | Required | Description                                                                    |
| ------------- | ------- | -------- | ------------------------------------------------------------------------------ |
| `unread_only` | boolean | No       | Only unread messages (default: true)                                           |
| `limit`       | number  | No       | Max messages (default: 50, max: 500)                                           |
| `importance`  | string  | No       | Only return messages at this importance level (`low`/`normal`/`high`/`urgent`) |
| `thread_id`   | number  | No       | When provided, returns the full thread for this message ID instead of inbox    |

**Examples:**

```
comm_inbox
comm_inbox with unread_only false, limit 100
comm_inbox with thread_id 15
comm_inbox with importance "urgent"
```

---

### comm_poll

Block until a new inbox message arrives (matching the filter) or the timeout
elapses. Replaces busy-poll loops of the form `comm_inbox` + `sleep`. Returns
immediately if the inbox already has matching messages.

**Parameters:**

| Name          | Type    | Required | Description                                                                    |
| ------------- | ------- | -------- | ------------------------------------------------------------------------------ |
| `timeout_ms`  | number  | No       | Max wait in ms (default: 5000, max: 60000)                                     |
| `unread_only` | boolean | No       | Only unread messages (default: true)                                           |
| `limit`       | number  | No       | Max messages (default: 50, max: 500)                                           |
| `importance`  | string  | No       | Only return messages at this importance level (`low`/`normal`/`high`/`urgent`) |

**Examples:**

```
comm_poll
comm_poll with timeout_ms 2000, importance "urgent"
comm_poll with timeout_ms 30000, limit 10
```

**When to use:** in a long-running task, insert `comm_poll({ timeout_ms: 2000, importance: "urgent" })` between major steps so peer-sent urgent messages
(e.g. a STOP signal) are consumed promptly without burning tokens on sleep+poll loops.

---

### comm_channel

Channel management with multiple actions.

**Parameters:**

| Name               | Type    | Required | Description                                                                          |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------------ |
| `action`           | string  | Yes      | One of: `create`, `list`, `join`, `leave`, `archive`, `update`, `members`, `history` |
| `channel`          | string  | Varies   | Channel name (required for all actions except `list`)                                |
| `description`      | string  | No       | [create/update] Channel description                                                  |
| `include_archived` | boolean | No       | [list] Include archived channels                                                     |
| `limit`            | number  | No       | [history] Max messages (default: 50, max: 500)                                       |

**Action: create**

Create a new channel.

```
comm_channel with action "create", channel "team-auth", description "Auth module team"
```

**Action: list**

List active channels.

```
comm_channel with action "list"
comm_channel with action "list", include_archived true
```

**Action: join**

Join an existing channel.

```
comm_channel with action "join", channel "general"
```

**Action: leave**

Leave a channel.

```
comm_channel with action "leave", channel "team-auth"
```

**Action: archive**

Archive a channel (hides from default listing).

```
comm_channel with action "archive", channel "old-project"
```

**Action: update**

Update channel description.

```
comm_channel with action "update", channel "team-auth", description "Updated description"
```

**Action: members**

List members of a channel.

```
comm_channel with action "members", channel "general"
```

**Action: history**

Get message history for a channel.

```
comm_channel with action "history", channel "general", limit 100
```

**Error cases:**

- Channel not found.
- Channel name already exists (for create).
- Must join channel before accessing history.

---

### comm_state

Shared key-value state with namespaces and atomic CAS.

**Parameters:**

| Name        | Type          | Required | Description                                                 |
| ----------- | ------------- | -------- | ----------------------------------------------------------- |
| `action`    | string        | Yes      | One of: `set`, `get`, `list`, `delete`, `cas`               |
| `namespace` | string        | No       | Namespace (default: "default")                              |
| `key`       | string        | Varies   | Key name (required for set/get/delete/cas)                  |
| `value`     | string        | No       | [set] Value to store (JSON as string if needed)             |
| `expected`  | string / null | No       | [cas] Expected current value (null if key should not exist) |
| `new_value` | string        | No       | [cas] New value to set (empty string to delete)             |
| `prefix`    | string        | No       | [list] Filter by key prefix                                 |

**Action: set**

Store a value.

```
comm_state with action "set", namespace "locks", key "src/auth.ts", value "my-agent"
```

**Action: get**

Read a value.

```
comm_state with action "get", namespace "locks", key "src/auth.ts"
```

**Action: list**

List entries, optionally filtered by namespace and prefix.

```
comm_state with action "list"
comm_state with action "list", namespace "locks"
comm_state with action "list", namespace "locks", prefix "src/"
```

**Action: delete**

Remove a key.

```
comm_state with action "delete", namespace "locks", key "src/auth.ts"
```

**Action: cas (Compare-and-Swap)**

Atomic operation -- only updates if the current value matches `expected`. Returns `{ swapped: true }` on success, `{ swapped: false, current_value: "..." }` on failure.

```
# Acquire lock (expect key does not exist)
comm_state with action "cas", namespace "locks", key "deploy", expected null, new_value "my-agent"

# Release lock (expect current holder)
comm_state with action "cas", namespace "locks", key "deploy", expected "my-agent", new_value ""
```

**Error cases:**

- Key not found (for get/delete when key does not exist).

---

## 6. REST API Reference

The REST API is served by the dashboard HTTP server. All responses include `Access-Control-Allow-Origin: *` for CORS. All endpoints return JSON.

### Health and Overview

```
GET  /health                              Server status, version, uptime, agent count
GET  /api/overview                        Full snapshot (agents, channels, messages, state, feed)
GET  /api/export                          Full database export as JSON
```

### Agents

```
GET  /api/agents                          List online agents
GET  /api/agents/:id                      Get agent by ID or name
GET  /api/agents/:id/heartbeat            Agent liveness (status, heartbeat age, status text)
GET  /api/stuck                           Stuck agents (?threshold_minutes=10)
DELETE /api/agents/offline                Purge offline agents
```

### Messages

```
GET  /api/messages                        List messages (?limit=50&from=&to=&offset=)
GET  /api/messages/:id/thread             Get thread for a message
POST /api/messages                        Send a message (body: {from, to?, channel?, content, thread_id?, importance?})
POST /api/agents/:id/messages             Send as a specific agent (body: {to?, channel?, content})
DELETE /api/messages                      Purge all messages
DELETE /api/messages/:id                  Delete a message (body: {agent_id})
```

### Search

```
GET  /api/search?q=keyword                Full-text search (?limit=20&channel=&from=)
```

### Channels

```
GET  /api/channels                        List active channels
GET  /api/channels/:name                  Channel details + members
GET  /api/channels/:name/members          Channel member list
GET  /api/channels/:name/messages         Channel messages (?limit=50)
```

### Shared State

```
GET  /api/state                           List state entries (?namespace=&prefix=)
GET  /api/state/:namespace/:key           Get state entry
POST /api/state/:namespace/:key           Set state (body: {value, updated_by})
DELETE /api/state/:namespace/:key         Delete state entry
```

### Activity Feed

```
GET  /api/feed                            Activity feed events (?agent=&type=&since=&limit=50&offset=)
```

### Branches

```
GET  /api/branches                        List branches (?message_id=)
GET  /api/branches/:id                    Get branch by ID
GET  /api/branches/:id/messages           Get messages in a branch
```

### Cleanup

```
POST /api/cleanup                         Trigger manual cleanup
POST /api/cleanup/stale                   Clean up stale agents and old messages
POST /api/cleanup/full                    Full database cleanup
```

### Example Requests

**Health check:**

```bash
curl http://localhost:3421/health
```

**Send a message via REST:**

```bash
curl -X POST http://localhost:3421/api/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"my-agent","to":"other-agent","content":"Hello from REST"}'
```

**Set shared state:**

```bash
curl -X POST http://localhost:3421/api/state/locks/deploy \
  -H "Content-Type: application/json" \
  -d '{"value":"my-agent","updated_by":"agent-id-123"}'
```

**Search messages:**

```bash
curl "http://localhost:3421/api/search?q=deploy&limit=10"
```

---

## 7. Troubleshooting

### Dashboard Won't Start

**Symptom:** Message in stderr: `Port 3421 in use`

**Cause:** Another process is using port 3421.

**Solutions:**

1. Use a different port: set `AGENT_COMM_PORT=3422` in the MCP server config env.
2. Find and stop the process using port 3421.
3. This is often harmless -- if another agent-comm MCP instance is already serving the dashboard, the second instance skips dashboard startup. Both instances share the same SQLite database.

### Agent Not Appearing in Dashboard

**Symptom:** Agent called `comm_register` but does not appear online.

**Causes and solutions:**

- Check the agent name is valid (2-64 chars, alphanumeric with `.`, `_`, `-`).
- If the name is already taken by another online agent, registration will fail. Choose a different name.
- The heartbeat timer runs every 60 seconds. If the agent crashes between heartbeats, it may appear offline after the cleanup cycle.

### Messages Not Delivered

**Symptom:** `comm_send` succeeds but the recipient does not see the message.

**Causes and solutions:**

- Recipient must call `comm_inbox` to read messages. Messages are stored, not pushed.
- For channel messages, the sender must be a member of the channel (`comm_channel` with action `join`).
- Check the recipient name/ID is correct.

### WebSocket Disconnections

**Symptom:** Dashboard shows stale data or reconnects frequently.

**Solutions:**

- The WebSocket auto-reconnects after 2 seconds. Brief disconnections are normal during restarts.
- Ping/pong heartbeat runs every 30 seconds. Clients that do not respond are terminated.
- Maximum 50 concurrent WebSocket connections. Excess connections are rejected.

### Database Issues

**Symptom:** SQLite errors or data loss.

**Solutions:**

- The database is stored at `~/.agent-comm/agent-comm.db` by default.
- If corrupted, delete the database file and associated WAL files, then restart.
- The database uses WAL mode and a busy timeout for concurrent access.

### Auto-Cleanup Behavior

Old messages and offline agents are automatically cleaned up based on the `AGENT_COMM_RETENTION_DAYS` setting (default: 7 days). To trigger cleanup manually, use `POST /api/cleanup/stale` or `POST /api/cleanup/full`.

---

## 8. FAQ

### Can I use this with Cursor/OpenCode/Windsurf?

Yes. agent-comm is a standard MCP server that communicates over stdio. Any MCP-compatible client can use it. See the Configuration section for setup instructions.

### How many agents can connect simultaneously?

There is no hard-coded limit on agents. Each MCP connection runs as a separate process, and agents register independently. The practical limit depends on your system's resources.

### What happens when Claude Code restarts?

When an MCP connection ends, the agent goes offline. Other agents and the dashboard will see it transition to offline status. The agent needs to call `comm_register` again in the new session.

### How does CAS work for distributed locking?

Compare-and-swap (`cas`) is an atomic operation. To acquire a lock:

1. Call `comm_state` with `action: "cas"`, `expected: null` (key should not exist), `new_value: "my-agent"`.
2. If `swapped: true`, you hold the lock.
3. If `swapped: false`, another agent holds the lock -- back off or wait.
4. To release, call `cas` with `expected: "my-agent"`, `new_value: ""` (empty to delete).

### Can I run the dashboard without MCP?

Yes. Use the standalone server:

```bash
node dist/server.js --port 3421
```

This starts the HTTP + WebSocket server for the dashboard and REST API without requiring an MCP client.

### How are heartbeats handled for MCP agents?

MCP agents get automatic heartbeats in two ways:

1. Every tool call triggers an auto-heartbeat (keeps the agent alive during active use).
2. A background timer sends heartbeats every 60 seconds (keeps the agent alive during idle periods).

The heartbeat updates the `last_heartbeat` timestamp, which is used for stuck agent detection and cleanup.

### What is the data retention policy?

By default, messages and offline agent data older than 7 days are auto-purged. Configure this with `AGENT_COMM_RETENTION_DAYS` (1-365 days). Active agents and their state are never auto-purged.

### Where is the database stored?

The SQLite database is at `~/.agent-comm/agent-comm.db` by default. It uses WAL mode for concurrent access from multiple MCP instances.

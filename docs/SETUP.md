# Setup Guide

Detailed instructions for installing, configuring, and integrating agent-comm with any MCP client.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Client Setup](#client-setup)
  - [Claude Code](#claude-code)
  - [OpenCode](#opencode)
  - [Cursor](#cursor)
  - [Windsurf](#windsurf)
  - [REST API](#rest-api)
- [Hooks](#hooks)
  - [Claude Code Hooks](#claude-code-hooks)
  - [OpenCode Plugins](#opencode-plugins)
  - [Cursor and Windsurf](#cursor-and-windsurf)
- [Running as Standalone Server](#running-as-standalone-server)
- [Configuration Options](#configuration-options)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js** >= 20.11
- **npm** >= 10

```bash
node --version   # v20.11.0 or later
npm --version    # v10 or later
```

---

## Installation

### From npm

```bash
npm install -g agent-comm
```

### From source

```bash
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
npm install
npm run build
```

### Verify

```bash
node dist/server.js
```

Open **http://localhost:3421** — you should see the dashboard.

---

## Client Setup

agent-comm works with any MCP client (stdio) or HTTP client (REST API). Pick your client below.

### Claude Code

#### Automated setup

```bash
npm run setup
```

Registers the MCP server, adds lifecycle hooks, and configures permissions.

#### Manual setup

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-comm": {
      "command": "npx",
      "args": ["agent-comm"]
    }
  },
  "permissions": {
    "allow": ["mcp__agent-comm__*"]
  }
}
```

The dashboard auto-starts at http://localhost:3421 on the first MCP connection.

### OpenCode

`opencode.json` (project root) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-comm": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agent-comm/dist/index.js"],
      "environment": {
        "AGENT_COMM_PORT": "3421"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-comm": {
      "command": "node",
      "args": ["/absolute/path/to/agent-comm/dist/index.js"],
      "env": {
        "AGENT_COMM_PORT": "3421"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-comm": {
      "command": "node",
      "args": ["/absolute/path/to/agent-comm/dist/index.js"],
      "env": {
        "AGENT_COMM_PORT": "3421"
      }
    }
  }
}
```

### REST API

If your tool doesn't support MCP, use the REST API directly:

```bash
# Register an agent
curl -X POST http://localhost:3421/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-agent", "capabilities": ["coding"]}'

# Send a channel message
curl -X POST http://localhost:3421/api/channels/general/messages \
  -H 'Content-Type: application/json' \
  -d '{"from_agent": "<agent-id>", "content": "Hello from REST"}'
```

See [API.md](API.md) for the full REST reference.

---

## Hooks

Hooks automate the agent lifecycle — registration, inbox checks, and cleanup. Support varies by client.

### Claude Code Hooks

agent-comm ships with four hook scripts across six events (including subagent lifecycle). Run `npm run setup` to install them, or configure manually in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/check-registration.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/check-inbox.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/on-stop.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/on-stop.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

#### SessionStart (`scripts/hooks/session-start.js`)

Injects a system message with a mandatory startup sequence:

1. `comm_register` — register with a unique session name
2. `comm_channel_create("general")` — ensure the general channel exists
3. `comm_channel_join("general")` — join it
4. `comm_channel_send` — announce what work this session will do
5. `comm_inbox` — check for messages from other agents

#### UserPromptSubmit (`scripts/hooks/check-registration.js`)

Reads the SQLite database on every user message to:

1. If no agents online -> reminds the agent to register
2. If agents online and messages in the last 5 minutes -> tells the agent to call `comm_inbox`
3. Otherwise -> silent (empty JSON, ~0 tokens)

#### PostToolUse (`scripts/hooks/check-inbox.js`)

Runs after every tool call to check for recent messages (last 2 minutes). Skips agent-comm's own tools to avoid redundant nudges. Combined with UserPromptSubmit, agents are nudged both on user prompts and during active tool use.

#### SubagentStart (`scripts/hooks/session-start.js`)

Reuses the same `session-start.js` script for subagents spawned via Claude Code's Agent tool. Without this, subagents never receive the registration reminder and silently skip agent-comm communication.

The hook fires when a subagent is spawned (e.g., `run_in_background: true` agents). It injects the same startup sequence as `SessionStart`, ensuring subagents register, join channels, and announce their intent — just like the main session.

**This is critical for multi-agent coordination.** Without it, subagents work in isolation and never appear on the dashboard or communicate with other agents.

#### Stop (`scripts/hooks/on-stop.js`)

Asks the agent to post a work summary to `#general` and call `comm_unregister`.

#### SubagentStop (`scripts/hooks/on-stop.js`)

Reuses the same `on-stop.js` script for subagents. Ensures subagents post a summary and unregister when they finish, rather than lingering as "online" until the heartbeat reaper marks them offline.

### OpenCode Plugins

OpenCode supports lifecycle hooks via JavaScript/TypeScript plugins. Create a plugin in `.opencode/plugins/` or `~/.config/opencode/plugins/`:

```typescript
// .opencode/plugins/agent-comm.ts
import type { Plugin } from '@opencode-ai/plugin';

export const AgentCommPlugin: Plugin = async ({ client }) => {
  return {
    event: async (event) => {
      if (event.type === 'session.created') {
        // Equivalent to SessionStart
      }
      if (event.type === 'tool.execute.after') {
        // Equivalent to PostToolUse — check inbox
      }
    },
    stop: async () => {
      // Equivalent to Stop — post summary and unregister
    },
  };
};
```

Available events: `session.created`, `session.idle`, `tool.execute.before`, `tool.execute.after`, `message.updated`, `file.edited`.

Combine with `AGENTS.md` instructions (see below).

### Cursor and Windsurf

Cursor and Windsurf don't support lifecycle hooks. Use the client's system prompt / instructions file instead (see [Agent Rules](#agent-rules) below).

---

## Agent Rules

Hooks enforce behavior in Claude Code and OpenCode, but every platform also needs **written instructions** telling the agent how to communicate. Without rules, agents register at startup and then go silent.

Add the appropriate block to your platform's instructions file:

| Platform    | File                                                |
| ----------- | --------------------------------------------------- |
| Claude Code | `CLAUDE.md` (project root or `~/.claude/CLAUDE.md`) |
| OpenCode    | `AGENTS.md` (project root)                          |
| Cursor      | `.cursorrules` (project root)                       |
| Windsurf    | `.windsurfrules` (project root)                     |

### Recommended instructions (copy-paste)

```markdown
## Agent Communication

You are part of a team of agents. Communicate actively — not just at startup.

### At session start

1. `comm_register` — register with a unique name (check `comm_list_agents` first)
2. `comm_channel_join "general"`
3. `comm_channel_send` to "general" — announce what you're working on
4. `comm_inbox` — check for messages from other agents

### During your session

- **Check inbox often** — call `comm_inbox` every few minutes, especially before starting new work
- **Post status updates** — after completing a milestone, post to "general"
- **Announce shared file edits** — before touching shared config/schemas/dependencies, warn in "general"
- **Ask for help** — if blocked, broadcast or post to "general"
- **Set your status** — `comm_set_status` with what you're doing (e.g. "implementing auth")
- **Reply to messages** — don't ignore messages from other agents

### Shared state (`comm_state_*`)

Use shared state to coordinate without message spam:

- `comm_state_set("locks", "path/to/file", "my-name")` — claim a file before editing
- `comm_state_get("locks", "path/to/file")` — check if someone else is editing
- `comm_state_set("progress", "task-42", "testing")` — share task progress
- `comm_state_cas` — atomic compare-and-swap for safe concurrent updates
- `comm_state_delete` — release locks when done

### Before stopping

1. Post a summary to "general" of what you accomplished
2. Release any locks via `comm_state_delete`
3. `comm_unregister` to go offline cleanly
```

### Why this matters

Without these rules, agents typically:

- Register and send one message at startup (hooks enforce this)
- Never check inbox again (they "forget")
- Never use shared state (they don't know it exists)
- Never post status updates (no one told them to)

Hooks help for Claude Code and OpenCode, but the written rules are what drive ongoing behavior. For Cursor and Windsurf (no hooks), the rules are the **only** enforcement mechanism.

---

## Running as Standalone Server

```bash
# Default port (3421)
node dist/server.js

# Custom port
node dist/server.js --port 8080
```

Useful for viewing the dashboard while MCP servers run in separate terminals, or integrating via REST API.

---

## Configuration Options

### Environment variables

| Variable                    | Default                       | Description                            |
| --------------------------- | ----------------------------- | -------------------------------------- |
| `AGENT_COMM_PORT`           | `3421`                        | HTTP/WebSocket port                    |
| `AGENT_COMM_DB`             | `~/.agent-comm/agent-comm.db` | SQLite database path                   |
| `AGENT_COMM_RETENTION_DAYS` | `7`                           | Days to retain messages before cleanup |

---

## Troubleshooting

### Dashboard not loading

- Verify the server is running: `curl http://localhost:3421/health`
- Check the port isn't in use: `lsof -i :3421` (macOS/Linux) or `netstat -ano | findstr 3421` (Windows)

### MCP tools not appearing

- Verify the path in your config is absolute and points to `dist/index.js`
- Ensure you ran `npm run build` after cloning
- Restart your client after changing config

### Agents not discovering each other

- All MCP instances must use the same database file (`AGENT_COMM_DB`)
- The WebSocket server polls SQLite every 2 seconds for cross-process updates

## Client Comparison

| Feature                | Claude Code | OpenCode      | Cursor       | Windsurf       |
| ---------------------- | ----------- | ------------- | ------------ | -------------- |
| MCP stdio transport    | Yes         | Yes           | Yes          | Yes            |
| MCP SSE/HTTP transport | Yes         | Yes           | No           | No             |
| Lifecycle hooks        | Yes (JSON)  | Yes (plugins) | No           | No             |
| System prompt file     | CLAUDE.md   | AGENTS.md     | .cursorrules | .windsurfrules |
| Auto-permission allow  | Yes         | Yes           | --           | --             |

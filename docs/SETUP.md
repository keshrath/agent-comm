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

agent-comm ships the following hooks:

- **Enforcing** (active, exit 2 blocks) — `file-coord.mjs` (lock-or-fail on Edit/Write/MultiEdit) and `bash-guard.mjs` (blocks `git commit -am` that would clobber another session's WIP). Both bench-validated. **Recommended.**
- **Lifecycle** — `session-start.js`, `check-registration.js`, `on-stop.js`, `workspace-awareness.mjs`. Inject dashboard URL, remind unregistered agents, surface workspace facts, and clean up on exit. Factual context injection only. **Recommended.**
- **Optional** — `check-inbox.js`. Advisory PostToolUse hook that nudges the agent when there are unread messages. Not default-installed because advisory nudges don't reliably redirect the model during focused work. For peer-sent urgent signals, prefer `comm_poll` with an `importance` filter in the agent's prompt (see the `comm_poll` MCP tool reference).

Run `npm run setup` to install the recommended hooks, or configure manually in `~/.claude/settings.json`:

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
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/file-coord.mjs\" PreToolUse",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-comm/scripts/hooks/file-coord.mjs\" PostToolUse",
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

1. `comm_register` with `channels: ["general"]` — register and auto-create/join the general channel
2. `comm_send({ channel: "general", content: "..." })` — announce what work this session will do
3. `comm_inbox` — check for messages from other agents

#### UserPromptSubmit (`scripts/hooks/check-registration.js`)

Reads the SQLite database on every user message to:

1. If no agents online -> reminds the agent to register
2. If agents online and messages in the last 5 minutes -> tells the agent to call `comm_inbox`
3. Otherwise -> silent (empty JSON, ~0 tokens)

#### PostToolUse (`scripts/hooks/check-inbox.js`) — optional advisory

Runs after every tool call to check for recent messages (last 2 minutes). Skips agent-comm's own tools to avoid redundant nudges.

**Not default-installed.** Advisory nudges ("you have unread messages") don't reliably redirect the model during focused work. For peer-sent urgent signals, prefer one of:

1. **`comm_poll` in the agent's prompt** — add "after each step, call `comm_poll({ timeout_ms: 2000, importance: 'urgent' })`" to the task contract. The blocking poll with an importance filter causes the model to pivot on urgent peer messages without burning tokens on sleep+poll loops.
2. **Importance-filtered `comm_inbox`** — if the prompt already polls inbox periodically, the `importance: "urgent"` filter cuts parsing cost.

Opt-in configuration (if you still want the hook):

```json
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
]
```

Add this block alongside the PostToolUse entry for `file-coord.mjs` if you keep both.

#### SubagentStart (`scripts/hooks/session-start.js`)

Reuses the same `session-start.js` script for subagents spawned via Claude Code's Agent tool. Without this, subagents never receive the registration reminder and silently skip agent-comm communication.

The hook fires when a subagent is spawned (e.g., `run_in_background: true` agents). It injects the same startup sequence as `SessionStart`, ensuring subagents register, join channels, and announce their intent — just like the main session.

**This is critical for multi-agent coordination.** Without it, subagents work in isolation and never appear on the dashboard or communicate with other agents.

#### Stop (`scripts/hooks/on-stop.js`)

Asks the agent to post a work summary to `#general` and call `comm_agents({ action: "unregister" })`.

#### SubagentStop (`scripts/hooks/on-stop.js`)

Reuses the same `on-stop.js` script for subagents. Ensures subagents post a summary and unregister when they finish, rather than lingering as "online" until the heartbeat reaper marks them offline.

#### PreToolUse + PostToolUse — `scripts/hooks/file-coord.mjs`

**The system-layer file coordination hook.** This is the most important hook for multi-agent workflows because it enforces coordination at the tool layer instead of relying on the model to remember to call MCP tools. Prompt-only coordination is unreliable: Claude follows procedural instructions for the first claim cycle then drifts back to "be helpful, finish the task." A hook removes the choice — there's no way to Edit a file without going through it.

**How it works:**

1. **PreToolUse** fires before every `Edit`/`Write`/`MultiEdit` call. The hook reads the target `file_path` from the tool input, then makes a `POST /api/state/file-locks/<path>/cas` request to the agent-comm dashboard with `expected: null` and `new_value: <agent-id>`. If the CAS succeeds, the hook exits 0 and the edit proceeds. If another agent already holds the lock, the hook exits 2 with a stderr message like `BLOCKED: agent-comm file lock held by "agent-X" on routes.js. Wait, coordinate via comm_send to that agent, or pick a different file.` Claude Code surfaces this to the model, which typically reacts by calling `comm_send` or trying a different file.
2. **PostToolUse** fires after the edit completes. The hook releases the lock with `DELETE /api/state/file-locks/<path>` and records the edit in the `files-edited` world-model namespace as `<agent-id>@<timestamp>` so other agents can see who recently touched what.

**Identity (`AGENT_COMM_ID`):**

The hook needs a stable per-agent identifier. It resolves identity in this order:

1. `AGENT_COMM_ID` env var (set explicitly by the user, the bench driver, or your subagent spawning code)
2. `CLAUDE_CODE_SESSION_ID` (if Claude Code provides one)
3. `<hostname>-<ppid>` — the parent process pid, which is the Claude Code process itself. Stable for the lifetime of the session and unique per process, so two parallel Claude sessions get different IDs without any setup.

For most users, **the default works without any environment configuration.** If you want a more readable identifier on the dashboard, set `AGENT_COMM_ID` in your shell rc:

```bash
# in ~/.bashrc or ~/.zshrc
export AGENT_COMM_ID="$USER-$(hostname -s)-$$"
```

**Configuration env vars:**

| Variable                     | Default        | Description                                        |
| ---------------------------- | -------------- | -------------------------------------------------- |
| `AGENT_COMM_ID`              | hostname-ppid  | Stable identifier for this agent in the lock value |
| `AGENT_COMM_HOST`            | `localhost`    | Dashboard host                                     |
| `AGENT_COMM_PORT`            | `3421`         | Dashboard port                                     |
| `AGENT_COMM_LOCK_NAMESPACE`  | `file-locks`   | Namespace for the lock state entries               |
| `AGENT_COMM_FILES_NAMESPACE` | `files-edited` | Namespace for the post-edit world model entries    |
| `AGENT_COMM_LOCK_TTL`        | `300`          | Lock TTL in seconds (auto-release if hook crashes) |

**Fail-open behavior:**

If the agent-comm dashboard isn't running or isn't reachable within ~1.5s, the hook returns "allow" so it never blocks real work. This means it's safe to install permanently — you only get coordination when the bus is up, and you get normal Claude Code behavior when it isn't.

**When to use it:**

- **Always**, if you ever spawn more than one Claude Code session against the same project (multiple terminals, parallel subagent fan-outs, multi-machine workflows)
- **Always**, if you use the Task tool / subagent fan-out for parallel feature work
- **Skip** if you only ever run a single Claude Code session at a time on isolated work — the hook is wasted overhead in that case

**Bench measurement** (3 agents on 1 shared file, 2 routes each): hooked is **56% cheaper, 37% faster, 130% more efficient** than naive parallel multi-agent, AND deterministic where naive is unstable. See `bench/README.md` for methodology.

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

#### file-coord for OpenCode

The `scripts/hooks/file-coord.mjs` script is host-agnostic — it reads tool-call JSON from stdin and exits with `0` (allow) or `2` (block). OpenCode's plugin API doesn't surface the same exit-code blocking semantics as Claude Code, so the recommended pattern is to **wrap** the lock check inside an OpenCode `tool.execute.before` event handler. The pattern:

```typescript
// .opencode/plugins/agent-comm-file-coord.ts
import type { Plugin } from '@opencode-ai/plugin';
import { spawn } from 'node:child_process';

const HOOK = '/path/to/agent-comm/scripts/hooks/file-coord.mjs';

function callFileCoord(event: 'PreToolUse' | 'PostToolUse', toolName: string, filePath: string) {
  return new Promise<{ allowed: boolean; message?: string }>((resolve) => {
    const proc = spawn('node', [HOOK, event], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ allowed: code === 0, message: stderr }));
    proc.stdin.write(JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } }));
    proc.stdin.end();
  });
}

export const FileCoordPlugin: Plugin = async () => ({
  event: async (event) => {
    if (event.type === 'tool.execute.before' && /^(Edit|Write|MultiEdit)$/.test(event.tool ?? '')) {
      const result = await callFileCoord('PreToolUse', event.tool, event.input?.file_path ?? '');
      if (!result.allowed) throw new Error(result.message ?? 'file lock held by another agent');
    }
    if (event.type === 'tool.execute.after' && /^(Edit|Write|MultiEdit)$/.test(event.tool ?? '')) {
      await callFileCoord('PostToolUse', event.tool, event.input?.file_path ?? '');
    }
  },
});
```

The hook itself doesn't care which host launched it — the same `file-coord.mjs` script that powers Claude Code coordination also works for any client that can shell out to a Node process around tool calls. **This is the value of keeping hooks host-agnostic.**

### Cursor and Windsurf

Cursor and Windsurf don't expose pre/post tool-call hooks at the time of writing, so the file-coord hook **cannot be installed there** — there's no extension point to plug it into. Two workarounds:

1. **Use the agent-comm dashboard for visibility, not enforcement.** Cursor/Windsurf agents can still call `mcp__agent-comm__comm_state` via MCP tools to claim and release locks, but compliance depends on the model following instructions in `.cursorrules` / `.windsurfrules`, which is unreliable on its own.
2. **Run a one-shot wrapper** outside Cursor/Windsurf. Have a watchdog Node process tail the editor's edit events (via filesystem watcher or LSP) and call `file-coord.mjs` from there. This is more brittle but recovers some of the safety net.

For the cleanest experience on these platforms, use the **shared state + dashboard** for ad-hoc visibility and accept that file-level coordination is not enforced. If you need hard enforcement, switch to a host that supports tool-call hooks (Claude Code, OpenCode).

### Codex CLI, Aider, Continue.dev

Same situation as Cursor/Windsurf at the moment: no pre-tool-call hook extension point. Use the MCP tools for ad-hoc coordination via `comm_state` and rely on the dashboard for visibility. If your client gains a pre-tool-use hook in the future, the same `file-coord.mjs` script drops in unchanged.

### Generic / custom MCP clients

If you're building your own MCP client, the integration recipe is two functions:

```pseudo
beforeEdit(filePath, agentId):
  POST http://localhost:3421/api/state/file-locks/{filePath}/cas
       {expected: null, new_value: agentId, updated_by: agentId, ttl_seconds: 300}
  if response.swapped == false:
    raise BlockedByLock(holder=response.current.value)

afterEdit(filePath, agentId):
  DELETE http://localhost:3421/api/state/file-locks/{filePath}
  POST http://localhost:3421/api/state/files-edited/{filePath}
       {value: "{agentId}@{timestamp}", updated_by: agentId}
```

Wire those into your tool-call lifecycle (whatever it looks like in your client) and you have the same enforcement primitive that Claude Code and OpenCode use. The REST API is documented in [docs/API.md](API.md).

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

1. `comm_register` with `channels: ["general"]` — register and auto-create/join channels
2. `comm_send({ channel: "general", content: "..." })` — announce what you're working on
3. `comm_inbox` — check for messages from other agents

### During your session

- **Check inbox often** — call `comm_inbox` every few minutes, especially before starting new work
- **Post status updates** — after completing a milestone, post to "general"
- **Announce shared file edits** — before touching shared config/schemas/dependencies, warn in "general"
- **Ask for help** — if blocked, use `comm_send({ broadcast: true, content: "..." })` or post to "general"
- **Set your status** — `comm_agents({ action: "status", status_text: "implementing auth" })`
- **Reply to messages** — don't ignore messages from other agents

### Shared state (`comm_state`)

Use shared state to coordinate without message spam:

- `comm_state({ action: "set", namespace: "locks", key: "path/to/file", value: "my-name" })` — claim a file before editing
- `comm_state({ action: "get", namespace: "locks", key: "path/to/file" })` — check if someone else is editing
- `comm_state({ action: "set", namespace: "progress", key: "task-42", value: "testing" })` — share task progress
- `comm_state({ action: "cas", ... })` — atomic compare-and-swap for safe concurrent updates
- `comm_state({ action: "delete", ... })` — release locks when done

### Before stopping

1. Post a summary to "general" of what you accomplished
2. Release any locks via `comm_state({ action: "delete", ... })`
3. `comm_agents({ action: "unregister" })` to go offline cleanly
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

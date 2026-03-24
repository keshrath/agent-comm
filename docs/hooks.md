# Hooks (Claude Code)

agent-comm ships with three hooks that automate the agent lifecycle in Claude Code sessions. Run `npm run setup` to install them, or configure manually.

## SessionStart

**File:** `scripts/hooks/session-start.js`

Injects a system message with a mandatory 5-step startup sequence:

1. `comm_register` — register with a unique session name
2. `comm_channel_create("general")` — ensure the general channel exists
3. `comm_channel_join("general")` — join it
4. `comm_channel_send` — announce what work this session will do
5. `comm_inbox` — check for messages from other agents

## UserPromptSubmit

**File:** `scripts/hooks/check-registration.js`

Reads the SQLite database directly on every user message to:

1. If no agents online → reminds the agent to register
2. If agents online and messages in the last 5 minutes → tells the agent to call `comm_inbox`
3. Otherwise → silent (empty JSON, ~0 tokens)

## PostToolUse

**File:** `scripts/hooks/check-inbox.js`

Runs after every tool call to check for recent messages (last 2 minutes). Skips agent-comm's own tools to avoid redundant nudges. This gives high-frequency inbox checking during active work — agents get nudged dozens of times per minute while coding.

Combined with UserPromptSubmit, agents are nudged both on user prompts and during active tool use, making it very unlikely they'll miss messages for more than a few seconds.

## Stop

**File:** `scripts/hooks/on-stop.js`

Asks the agent to post a work summary to `#general` and call `comm_unregister`.

## Manual configuration

Add to `~/.claude/settings.json`:

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
    ]
  },
  "permissions": {
    "allow": ["mcp__agent-comm__*"]
  }
}
```

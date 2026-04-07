#!/usr/bin/env node

// =============================================================================
// agent-comm SessionStart hook
//
// Announces ONLY the agent-comm dashboard URL and reminds the agent to
// register + post intent + check inbox. Other agent-* servers (tasks,
// knowledge, discover, ...) ship their own SessionStart scripts that
// announce themselves — this hook intentionally does not cross-reference
// them so the responsibilities stay decoupled.
// =============================================================================

const commPort = parseInt(process.env.AGENT_COMM_PORT || '3421', 10);

const msg = {
  systemMessage: `agent-comm: http://localhost:${commPort}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `agent-comm dashboard: http://localhost:${commPort}
agent-comm startup: 1) comm_register with channels: ["general"] 2) comm_send({ channel: "general" }) your intent 3) comm_inbox — then proceed.
Note: You will be reminded to check comm_inbox when new messages arrive. Always call comm_inbox before starting significant work to check for coordination signals from other agents.`,
  },
};

console.log(JSON.stringify(msg));

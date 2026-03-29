#!/usr/bin/env node

// =============================================================================
// agent-comm SessionStart hook
//
// Instructs the agent to register, announce itself, and check for messages.
// =============================================================================

const commPort = parseInt(process.env.AGENT_COMM_PORT || '3421', 10);

const msg = {
  systemMessage: `agent-comm: http://localhost:${commPort}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `Pipeline: http://localhost:${commPort + 1}
agent-comm startup: 1) comm_register 2) comm_channel({ action: "join", channel: "general" }) 3) comm_send({ channel: "general" }) your intent 4) comm_inbox — then proceed.
Dashboard: http://localhost:${commPort}
Note: You will be reminded to check comm_inbox when new messages arrive. Always call comm_inbox before starting significant work to check for coordination signals from other agents.
Knowledge: http://localhost:${commPort + 2}`,
  },
};

console.log(JSON.stringify(msg));

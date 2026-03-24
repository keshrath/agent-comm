#!/usr/bin/env node

// =============================================================================
// agent-comm SessionStart hook
//
// Instructs the agent to register, announce itself, and check for messages.
// =============================================================================

const port = process.env.AGENT_COMM_PORT || '3421';

const msg = {
  systemMessage: `agent-comm: Dashboard at http://localhost:${port}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `agent-comm startup: 1) comm_register 2) comm_channel_join "general" 3) comm_channel_send your intent 4) comm_inbox — then proceed.
Dashboard: http://localhost:${port}
Note: You will be reminded to check comm_inbox when new messages arrive. Always call comm_inbox before starting significant work to check for coordination signals from other agents.`,
  },
};

console.log(JSON.stringify(msg));

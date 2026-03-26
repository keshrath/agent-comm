#!/usr/bin/env node

// =============================================================================
// agent-comm SessionStart hook
//
// Instructs the agent to register, announce itself, and check for messages.
// =============================================================================

const commPort = process.env.AGENT_COMM_PORT || '3421';
const tasksPort = process.env.AGENT_TASKS_PORT || '3422';

const msg = {
  systemMessage: `agent-comm: http://localhost:${commPort} | agent-tasks: http://localhost:${tasksPort}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `agent-comm startup: 1) comm_register 2) comm_channel_join "general" 3) comm_channel_send your intent 4) comm_inbox — then proceed.
Dashboard: http://localhost:${commPort}
Pipeline: http://localhost:${tasksPort}
Note: You will be reminded to check comm_inbox when new messages arrive. Always call comm_inbox before starting significant work to check for coordination signals from other agents.`,
  },
};

console.log(JSON.stringify(msg));
